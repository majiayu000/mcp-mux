// Core proxy: one client per account, one rewritten toolset, calls routed by the required `account` argument.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import pkg from "../package.json";
import type { Account, Config } from "./config.ts";
import { AccountAuth, NeedsLoginError, httpTransport } from "./oauth.ts";
import { PaginatedClient } from "./paginated-client.ts";
import { openStore, type SecretStore } from "./store.ts";

export const log = (...a: unknown[]) => console.error("[mcp-mux]", ...a); // stdout is reserved for JSON-RPC

// Extension point for irreversible-action approval (docs/design.md §8). Nothing implements it yet.
export interface CallContext {
  account: string;
  tool: string;
  args: Record<string, unknown>;
  annotations?: ToolAnnotations;
}
export type ApprovalDecision = { allow: true } | { allow: false; reason: string };
export type BeforeCall = (ctx: CallContext) => Promise<ApprovalDecision>;

export const storeKey = (cfgName: string, account: string) => `${cfgName}/${account}`;

export async function connectAccount(cfgName: string, name: string, acct: Account, store?: SecretStore): Promise<Client> {
  const client = new PaginatedClient({ name: `mcp-mux-${name}`, version: pkg.version });
  if (acct.kind === "stdio") {
    // Only the SDK's safe default env (PATH, HOME, ...) plus this account's env: other accounts' secrets stay out.
    await client.connect(new StdioClientTransport({ command: acct.command, args: acct.args, env: acct.env, cwd: acct.cwd, stderr: "inherit" }));
  } else {
    const auth = acct.oauth ? new AccountAuth(storeKey(cfgName, name), store!, acct.oauth) : undefined;
    await client.connect(httpTransport(acct, auth));
  }
  return client;
}

export function rewriteTools(tools: Tool[], accounts: string[], labels: Record<string, string | undefined> = {}): Tool[] {
  const list = accounts.map((a) => (labels[a] ? `${a} (${labels[a]})` : a)).join(", ");
  return tools.map((t) => {
    const schema = t.inputSchema ?? { type: "object" };
    if (schema.properties && "account" in schema.properties) {
      throw new Error(`upstream tool "${t.name}" already has an "account" argument`);
    }
    return {
      ...t,
      description: `${t.description ?? ""}\n\nAccounts: ${list}.`.trim(),
      inputSchema: {
        ...schema,
        type: "object",
        properties: {
          account: { type: "string", enum: accounts, description: `Which account to use: ${list}` },
          ...(schema.properties ?? {}),
        },
        required: ["account", ...(schema.required ?? []).filter((r) => r !== "account")],
      },
    };
  });
}

export type AccountCheck = { account: string; ok: true; tools: number } | { account: string; ok: false; error: string };

const describeFailure = (account: string, e: unknown, loginHint: (account: string) => string) =>
  e instanceof NeedsLoginError ? `needs login; ${loginHint(account)}` : `failed to connect: ${(e as Error).message}`;

const needsStore = (cfg: Config) => Object.values(cfg.accounts).some((a) => a.kind === "http" && a.oauth);

// Connect to each account and list its tools, without starting a server. Never opens a browser.
export async function checkAccounts(cfg: Config, loginHint: (account: string) => string, store?: SecretStore): Promise<AccountCheck[]> {
  const s = needsStore(cfg) ? (store ?? openStore(cfg.store)) : undefined;
  return Promise.all(
    Object.entries(cfg.accounts).map(async ([n, a]): Promise<AccountCheck> => {
      let client: Client | undefined;
      try {
        client = await connectAccount(cfg.name, n, a, s);
        return { account: n, ok: true, tools: (await client.listTools()).tools.length };
      } catch (e) {
        return { account: n, ok: false, error: describeFailure(n, e, loginHint) };
      } finally {
        await client?.close().catch(() => {});
      }
    }),
  );
}

const sig = (ts: Tool[]) => ts.map((t) => t.name).sort();

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export type Mux = { server: Server; tools: Tool[]; unavailable: Map<string, string>; close(): Promise<void> };

export async function buildMux(
  cfg: Config,
  opts: { store?: SecretStore; beforeCall?: BeforeCall; loginHint?: (account: string) => string } = {},
): Promise<Mux> {
  const names = Object.keys(cfg.accounts);
  const store = needsStore(cfg) ? (opts.store ?? openStore(cfg.store)) : undefined;
  const loginHint = opts.loginHint ?? ((a: string) => `run: mcp-mux login <config> ${a}`);

  const clients = new Map<string, Client>();
  const unavailable = new Map<string, string>();
  const describe = (n: string, e: unknown) => describeFailure(n, e, loginHint);

  // A closed upstream (crashed process, dropped session) is dropped here and reconnected on the next call.
  const track = (n: string, c: Client) => {
    clients.set(n, c);
    unavailable.delete(n);
    c.onclose = () => {
      if (clients.get(n) !== c) return;
      clients.delete(n);
      unavailable.set(n, "upstream connection closed");
      log(`account "${n}" upstream connection closed; will reconnect on next call`);
    };
  };

  const settled = await Promise.allSettled(names.map((n) => connectAccount(cfg.name, n, cfg.accounts[n]!, store)));
  settled.forEach((r, i) => {
    const n = names[i]!;
    if (r.status === "fulfilled") track(n, r.value);
    else {
      unavailable.set(n, describe(n, r.reason));
      log(`account "${n}" ${unavailable.get(n)}`);
    }
  });
  const close = async () => {
    const all = [...clients.values()];
    clients.clear();
    await Promise.allSettled(all.map((c) => c.close()));
  };
  if (clients.size === 0) {
    await close();
    throw new Error(`no account is usable: ${[...unavailable].map(([n, why]) => `${n}: ${why}`).join("; ")}`);
  }

  // The first usable account (in config order) defines the toolset; every other usable account must match it.
  const live = names.filter((n) => clients.has(n));
  const lists = await Promise.all(live.map(async (n) => [n, (await clients.get(n)!.listTools()).tools] as const)).catch(async (e: unknown) => {
    await close();
    throw e;
  });
  const [refName, refTools] = lists[0]!;
  const toolsetDiff = (ts: Tool[]) => {
    const a = sig(refTools), b = sig(ts);
    if (a.join() === b.join()) return undefined;
    const missing = a.filter((x) => !b.includes(x)), extra = b.filter((x) => !a.includes(x));
    return `different toolset than "${refName}" (missing: ${missing.join(", ") || "-"}; extra: ${extra.join(", ") || "-"})`;
  };
  for (const [n, ts] of lists.slice(1)) {
    const diff = toolsetDiff(ts);
    if (diff) {
      await close();
      throw new Error(`account "${n}" exposes a ${diff}`);
    }
  }
  let tools: Tool[];
  try {
    tools = rewriteTools(refTools, names, Object.fromEntries(names.map((n) => [n, cfg.accounts[n]!.description])));
  } catch (e) {
    await close();
    throw e;
  }
  const annotations = new Map(refTools.map((t) => [t.name, t.annotations]));

  // Retry an unavailable account on demand, so `mcp-mux login` or a restarted upstream takes effect without restarting the client.
  const pending = new Map<string, Promise<Client | undefined>>();
  const reconnect = (n: string) => {
    if (!pending.has(n)) {
      const attempt = (async () => {
        let c: Client | undefined;
        try {
          c = await connectAccount(cfg.name, n, cfg.accounts[n]!, store);
          const diff = toolsetDiff((await c.listTools()).tools);
          if (diff) throw new Error(`now exposes a ${diff}`);
          track(n, c);
          log(`account "${n}" reconnected`);
          return c;
        } catch (e) {
          await c?.close().catch(() => {});
          unavailable.set(n, describe(n, e));
          return undefined;
        } finally {
          pending.delete(n);
        }
      })();
      pending.set(n, attempt);
    }
    return pending.get(n)!;
  };

  const server = new Server({ name: cfg.name, version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { account, ...args } = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (typeof account !== "string" || !names.includes(account)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown account ${JSON.stringify(account)}; expected one of: ${names.join(", ")}`);
    }
    const client = clients.get(account) ?? (await reconnect(account));
    if (!client) return errorResult(`account "${account}" is unavailable: ${unavailable.get(account)}`);

    if (opts.beforeCall) {
      const d = await opts.beforeCall({ account, tool: req.params.name, args, annotations: annotations.get(req.params.name) });
      if (!d.allow) return errorResult(`denied: ${d.reason}`);
    }

    log(`call ${req.params.name} -> ${account}`);
    try {
      const res = (await client.callTool({ name: req.params.name, arguments: args })) as CallToolResult;
      return { ...res, _meta: { ...res._meta, "mcp-mux/account": account } };
    } catch (e) {
      if (e instanceof NeedsLoginError) {
        clients.delete(account);
        unavailable.set(account, describe(account, e));
        await client.close().catch(() => {});
        return errorResult(`account "${account}" is unavailable: ${unavailable.get(account)}`);
      }
      return errorResult(`[account ${account}] ${(e as Error).message}`);
    }
  });

  return { server, tools, unavailable, close };
}
