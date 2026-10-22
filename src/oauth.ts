// Per-account OAuth: an OAuthClientProvider whose state lives under one store key, plus the interactive login flow.
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { HttpAccount, OAuthConfig } from "./config.ts";
import type { SecretStore } from "./store.ts";

export class NeedsLoginError extends Error {}

type Saved = { tokens?: OAuthTokens; client?: OAuthClientInformationMixed; discovery?: OAuthDiscoveryState };

type Interactive = { redirectUrl: string; open: (url: URL) => void | Promise<void> };

export class AccountAuth implements OAuthClientProvider {
  readonly stateValue = randomUUID();
  private saved?: Saved;
  private verifier?: string;

  // Without `interactive` (serve mode) the provider never starts a browser flow: it throws NeedsLoginError instead.
  constructor(
    readonly key: string,
    private store: SecretStore,
    private oauth: OAuthConfig,
    private interactive?: Interactive,
  ) {}

  private async load(): Promise<Saved> {
    if (!this.saved) {
      const raw = await this.store.get(this.key);
      this.saved = raw ? JSON.parse(raw) : {};
    }
    return this.saved!;
  }

  private async patch(p: Partial<Saved>) {
    this.saved = { ...(await this.load()), ...p };
    await this.store.set(this.key, JSON.stringify(this.saved));
  }

  get redirectUrl() {
    // Serve mode never redirects; a placeholder keeps the SDK on the authorization-code path instead of client_credentials.
    return this.interactive?.redirectUrl ?? "http://127.0.0.1/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "mcp-mux",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.oauth.clientSecret ? "client_secret_post" : "none",
      ...(this.oauth.scope ? { scope: this.oauth.scope } : {}),
      application_type: "native",
    } as OAuthClientMetadata;
  }

  state() {
    return this.stateValue;
  }

  async clientInformation() {
    if (this.oauth.clientId) return { client_id: this.oauth.clientId, client_secret: this.oauth.clientSecret };
    const client = (await this.load()).client;
    if (!this.interactive) {
      if (!client) throw new NeedsLoginError("not logged in");
      return client;
    }
    // A registration made for another callback port cannot be reused; returning nothing makes the SDK register again.
    const uris = (client as { redirect_uris?: string[] } | undefined)?.redirect_uris;
    return uris && !uris.includes(this.redirectUrl) ? undefined : client;
  }

  async saveClientInformation(client: OAuthClientInformationMixed) {
    if (!this.oauth.clientId) await this.patch({ client });
  }

  async tokens() {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    await this.patch({ tokens });
  }

  async redirectToAuthorization(url: URL) {
    if (!this.interactive) throw new NeedsLoginError("login required (no valid token and refresh failed or unavailable)");
    for (const [k, v] of Object.entries(this.oauth.authorizeParams ?? {})) url.searchParams.set(k, v);
    await this.interactive.open(url);
  }

  saveCodeVerifier(v: string) {
    this.verifier = v;
  }

  codeVerifier() {
    if (!this.verifier) throw new Error("no PKCE code verifier for this login");
    return this.verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    await this.patch({ discovery });
  }

  async discoveryState() {
    return (await this.load()).discovery;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "verifier") this.verifier = undefined;
    else if (scope === "all") await this.patch({ tokens: undefined, client: undefined, discovery: undefined });
    else await this.patch({ [scope === "client" ? "client" : scope]: undefined });
  }
}

export function httpTransport(account: HttpAccount, auth?: AccountAuth) {
  return new StreamableHTTPClientTransport(new URL(account.url), {
    authProvider: auth,
    requestInit: { headers: account.headers },
  });
}

type CallbackResult = { code: string } | { error: string };

// Local redirect target. Bound to 127.0.0.1 only; validates state and the RFC 9207 `iss` parameter.
function startCallbackServer(port: number, auth: () => AccountAuth) {
  let settle!: (r: CallbackResult) => void;
  const result = new Promise<CallbackResult>((r) => (settle = r));
  const page = (msg: string, status = 200) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>mcp-mux</title><p>${msg}</p>`, { status, headers: { "content-type": "text/html" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
      const q = u.searchParams;
      if (q.get("state") !== auth().stateValue) {
        settle({ error: "state mismatch" });
        return page("Login failed: state mismatch.", 400);
      }
      const md = (await auth().discoveryState())?.authorizationServerMetadata as
        | { issuer?: string; authorization_response_iss_parameter_supported?: boolean }
        | undefined;
      const issuer = md?.issuer;
      const issRequired = md?.authorization_response_iss_parameter_supported === true;
      const iss = q.get("iss");
      if ((iss === null && issRequired) || (iss !== null && iss !== issuer)) {
        settle({ error: `issuer mismatch (expected ${issuer}, got ${iss})` }); // do not act on error fields from a mismatched issuer
        return page("Login failed: issuer mismatch.", 400);
      }
      if (q.get("error")) {
        settle({ error: `${q.get("error")}: ${q.get("error_description") ?? ""}`.trim() });
        return page("Login failed. You can close this tab.", 400);
      }
      const code = q.get("code");
      if (!code) {
        settle({ error: "callback without code" });
        return page("Login failed: no code.", 400);
      }
      settle({ code });
      return page("Logged in. You can close this tab and return to the terminal.");
    },
  });
  return { server, result };
}

export async function openInBrowser(url: URL) {
  console.error(`[mcp-mux] open this URL to log in:\n${url.href}`);
  const cmd = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  try {
    Bun.spawn([...cmd, url.href], { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    console.error(`[mcp-mux] could not open a browser (${(e as Error).message}); open the URL manually`);
  }
}

// Interactive login for one account. Always starts a fresh authorization so the user can pick the identity.
export async function login(opts: {
  account: HttpAccount;
  key: string;
  store: SecretStore;
  open?: (url: URL) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<{ tools: number }> {
  const oauth = opts.account.oauth ?? {};
  let auth!: AccountAuth;
  const { server, result } = startCallbackServer(oauth.callbackPort ?? 0, () => auth);
  auth = new AccountAuth(opts.key, opts.store, oauth, {
    redirectUrl: `http://127.0.0.1:${server.port}/callback`,
    open: opts.open ?? openInBrowser,
  });
  let timer: Timer | undefined;
  try {
    await auth.invalidateCredentials("tokens");
    const transport = httpTransport(opts.account, auth);
    const first = new Client({ name: "mcp-mux-login", version: "0.1.0" });
    try {
      await first.connect(transport);
      throw new Error("upstream accepted the request without a token; it does not need OAuth");
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
    }
    const timeout = new Promise<CallbackResult>((r) => {
      timer = setTimeout(() => r({ error: "timed out waiting for the browser callback" }), opts.timeoutMs ?? 300_000);
    });
    const r = await Promise.race([result, timeout]);
    if ("error" in r) throw new Error(`login failed: ${r.error}`);
    await transport.finishAuth(r.code);

    // Verify with a fresh connection that only uses stored credentials.
    const check = new Client({ name: "mcp-mux-login", version: "0.1.0" });
    await check.connect(httpTransport(opts.account, new AccountAuth(opts.key, opts.store, oauth)));
    const { tools } = await check.listTools();
    await check.close();
    return { tools: tools.length };
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}
