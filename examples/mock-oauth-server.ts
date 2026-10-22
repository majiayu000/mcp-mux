// Local stand-in for a multi-tenant OAuth-protected MCP server (think Gmail/Notion): one URL, identity comes from the token.
// Implements PRM (RFC 9728), AS metadata (RFC 8414), DCR (RFC 7591), PKCE S256, resource indicators (RFC 8707),
// `iss` in the authorization response (RFC 9207) and refresh tokens. Fake users and data only.
// Run standalone: bun examples/mock-oauth-server.ts [port]
import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const INBOX: Record<string, string[]> = {
  "alice@work.example": ["Q3 budget review moved to Friday", "Invoice #4411 from Acme"],
  "alice@home.example": ["Dentist appointment reminder", "Your library books are due"],
};

type Code = { user: string; clientId: string; redirectUri: string; challenge: string; resource: string };
type Grant = { user: string; clientId: string; expires: number };

export function startMockOAuthServer(opts: { port?: number; tokenTtlSec?: number } = {}) {
  const ttl = opts.tokenTtlSec ?? 3600;
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, Code>();
  const access = new Map<string, Grant>();
  const refresh = new Map<string, { user: string; clientId: string }>();
  const stats = { registrations: 0, authorizations: 0, codeExchanges: 0, refreshes: 0, rejectedTokens: 0 };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const oauthError = (error: string, description: string) => json({ error, error_description: description }, 400);

  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const base: string = `http://127.0.0.1:${server.port}`;
      const resource = `${base}/mcp`;
      const prm = `${base}/.well-known/oauth-protected-resource/mcp`;

      if (u.pathname === "/.well-known/oauth-protected-resource/mcp" || u.pathname === "/.well-known/oauth-protected-resource") {
        return json({ resource, authorization_servers: [base], scopes_supported: ["mail.read"], bearer_methods_supported: ["header"] });
      }
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mail.read"],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (u.pathname === "/register" && req.method === "POST") {
        const md = (await req.json()) as { redirect_uris?: string[] };
        if (!md.redirect_uris?.length) return oauthError("invalid_redirect_uri", "redirect_uris required");
        const client_id = randomUUID();
        clients.set(client_id, { redirect_uris: md.redirect_uris });
        stats.registrations++;
        return json({ ...md, client_id, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201);
      }
      if (u.pathname === "/authorize") {
        const q = u.searchParams;
        const client = clients.get(q.get("client_id") ?? "");
        const redirectUri = q.get("redirect_uri") ?? "";
        if (!client || !client.redirect_uris.includes(redirectUri)) return new Response("unknown client or redirect_uri", { status: 400 });
        if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return new Response("PKCE S256 required", { status: 400 });
        if (q.get("resource") !== resource) return new Response(`resource must be ${resource}`, { status: 400 });
        const user = q.get("login_hint");
        if (!user || !INBOX[user]) {
          // Account picker, like a real provider's consent screen. login_hint (via authorizeParams) skips it.
          const links = Object.keys(INBOX)
            .map((e) => { const n = new URL(u); n.searchParams.set("login_hint", e); return `<li><a href="${n.pathname}${n.search}">${e}</a></li>`; })
            .join("");
          return new Response(`<!doctype html><meta charset="utf-8"><h3>Mock provider: choose an account</h3><ul>${links}</ul>`, {
            headers: { "content-type": "text/html" },
          });
        }
        const code = randomUUID();
        codes.set(code, { user, clientId: q.get("client_id")!, redirectUri, challenge: q.get("code_challenge")!, resource });
        stats.authorizations++;
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("iss", base);
        if (q.get("state")) back.searchParams.set("state", q.get("state")!);
        return Response.redirect(back.href, 302);
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        const issue = (user: string, clientId: string) => {
          const at = randomUUID(), rt = randomUUID();
          access.set(at, { user, clientId, expires: Date.now() + ttl * 1000 });
          refresh.set(rt, { user, clientId });
          return json({ access_token: at, token_type: "Bearer", expires_in: ttl, refresh_token: rt, scope: "mail.read" });
        };
        if (f.get("resource") !== resource) return oauthError("invalid_target", `resource must be ${resource}`);
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          if (!c || c.clientId !== f.get("client_id") || c.redirectUri !== f.get("redirect_uri")) return oauthError("invalid_grant", "bad code");
          const verifier = f.get("code_verifier") ?? "";
          if (createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return oauthError("invalid_grant", "PKCE failed");
          stats.codeExchanges++;
          return issue(c.user, c.clientId);
        }
        if (f.get("grant_type") === "refresh_token") {
          const r = refresh.get(f.get("refresh_token") ?? "");
          refresh.delete(f.get("refresh_token") ?? ""); // rotate
          if (!r || r.clientId !== f.get("client_id")) return oauthError("invalid_grant", "bad refresh token");
          stats.refreshes++;
          return issue(r.user, r.clientId);
        }
        return oauthError("unsupported_grant_type", String(f.get("grant_type")));
      }
      if (u.pathname === "/mcp") {
        const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const g = access.get(token);
        if (!g || g.expires < Date.now()) {
          if (token) stats.rejectedTokens++;
          return new Response("unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer resource_metadata="${prm}", scope="mail.read"` },
          });
        }
        const mcp = new McpServer({ name: "mock-mail", version: "1.0.0" });
        mcp.registerTool("whoami", { description: "Return the signed-in user's email address" }, async () => ({
          content: [{ type: "text", text: g.user }],
        }));
        mcp.registerTool(
          "search_mail",
          { description: "Search the signed-in user's inbox", inputSchema: { query: z.string() } },
          async ({ query }) => ({
            content: [{ type: "text", text: JSON.stringify(INBOX[g.user]!.filter((s) => s.toLowerCase().includes(query.toLowerCase()))) }],
          }),
        );
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcp.connect(transport);
        return transport.handleRequest(req);
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stats,
    expireAllTokens() {
      for (const g of access.values()) g.expires = 0;
    },
    revokeRefreshTokens() {
      refresh.clear();
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const m = startMockOAuthServer({ port: Number(process.argv[2] ?? 47821) });
  console.error(`[mock] OAuth-protected MCP server at ${m.url} (users: ${Object.keys(INBOX).join(", ")})`);
}
