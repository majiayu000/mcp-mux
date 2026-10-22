// Core proxy: one client per account, one rewritten toolset, calls routed by the required `account` argument.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
  const client = new Client({ name: `mcp-mux-${name}`, version: pkg.version });
  if (acct.kind === "stdio") {
    // Only the SDK's safe default env (PATH, HOME, ...) plus this account's env: other accounts' secrets stay out.
    await client.connect(new StdioClientTransport({ command: acct.command, args: acct.args, env: acct.env, cwd: acct.cwd, stderr: "inherit" }));
  } else {
    const auth = acct.oauth ? new AccountAuth(storeKey(cfgName, name), store!, acct.oauth) : undefined;
    await client.connect(httpTransport(acct, auth));
  }
  return client;
}

export function rewriteTools(tools: Tool[], accounts: string[]): Tool[] {
  return tools.map((t) => {
    const schema = t.inputSchema ?? { type: "object" };
    if (schema.properties && "account" in schema.properties) {
      throw new Error(`upstream tool "${t.name}" already has an "account" argument`);
    }
    return {
      ...t,
      description: `${t.description ?? ""}\n\nAccounts: ${accounts.join(", ")}.`.trim(),
      inputSchema: {
        ...schema,
        type: "object",
        properties: {
          account: { type: "string", enum: accounts, description: `Which account to use: ${accounts.join(", ")}` },
          ...(schema.properties ?? {}),
        },
        required: ["account", ...(schema.required ?? []).filter((r) => r !== "account")],
      },
    };
  });
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
  const needsStore = names.some((n) => {
    const a = cfg.accounts[n]!;
    return a.kind === "http" && a.oauth;
  });
  const store = needsStore ? (opts.store ?? openStore(cfg.store)) : undefined;
  const loginHint = opts.loginHint ?? ((a: string) => `run: mcp-mux login <config> ${a}`);

  const clients = new Map<string, Client>();
  const unavailable = new Map<string, string>();
  const describe = (n: string, e: unknown) =>
    e instanceof NeedsLoginError ? `needs login; ${loginHint(n)}` : `failed to connect: ${(e as Error).message}`;

  const settled = await Promise.allSettled(names.map((n) => connectAccount(cfg.name, n, cfg.accounts[n]!, store)));
  settled.forEach((r, i) => {
    const n = names[i]!;
    if (r.status === "fulfilled") clients.set(n, r.value);
    else {
      unavailable.set(n, describe(n, r.reason));
      log(`account "${n}" ${unavailable.get(n)}`);
    }
  });
  const close = async () => {
    await Promise.allSettled([...clients.values()].map((c) => c.close()));
  };
  if (clients.size === 0) {
    await close();
    throw new Error(`no account is usable: ${[...unavailable].map(([n, why]) => `${n}: ${why}`).join("; ")}`);
  }

  // The first usable account (in config order) defines the toolset; every other usable account must match it.
  const live = names.filter((n) => clients.has(n));
  const lists = await Promise.all(live.map(async (n) => [n, (await clients.get(n)!.listTools()).tools] as const));
  const [refName, refTools] = lists[0]!;
  for (const [n, ts] of lists.slice(1)) {
    const a = sig(refTools), b = sig(ts);
    if (a.join() !== b.join()) {
      await close();
      const missing = a.filter((x) => !b.includes(x)), extra = b.filter((x) => !a.includes(x));
      throw new Error(`account "${n}" exposes a different toolset than "${refName}" (missing: ${missing.join(", ") || "-"}; extra: ${extra.join(", ") || "-"})`);
    }
  }
  const tools = rewriteTools(refTools, names);
  const annotations = new Map(refTools.map((t) => [t.name, t.annotations]));

  const server = new Server({ name: cfg.name, version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { account, ...args } = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (typeof account !== "string" || !names.includes(account)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown account ${JSON.stringify(account)}; expected one of: ${names.join(", ")}`);
    }
    const client = clients.get(account);
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
