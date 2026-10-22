// Config loading: one upstream shared by all accounts, per-account overrides, ${VAR} expansion.

export type OAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
  authorizeParams?: Record<string, string>;
};

type UpstreamFields = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: OAuthConfig;
};

export type StoreConfig = { type: "keychain"; keychain?: string } | { type: "file"; path?: string };

export type RawConfig = {
  name: string;
  upstream?: UpstreamFields;
  accounts: Record<string, UpstreamFields & { description?: string }>;
  store?: StoreConfig;
};

export type StdioAccount = { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string };
export type HttpAccount = { kind: "http"; url: string; headers: Record<string, string>; oauth?: OAuthConfig };
// `description` is shown to the model next to the account name, e.g. the mailbox address or workspace name.
export type Account = (StdioAccount | HttpAccount) & { description?: string };

export type Config = { name: string; accounts: Record<string, Account>; store?: StoreConfig };

const NAME_RE = /^[A-Za-z0-9_-]+$/;

// Resolve ${VAR} so secrets can live in the environment instead of the config file.
export function expand(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{(\w+)\}/g, (_, k: string) => {
    const v = env[k];
    if (v === undefined) throw new Error(`config references unset env var ${k}`);
    return v;
  });
}

function expandDeep<T>(v: T, env: Record<string, string | undefined>): T {
  if (typeof v === "string") return expand(v, env) as T;
  if (Array.isArray(v)) return v.map((x) => expandDeep(x, env)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x, env)])) as T;
  }
  return v;
}

// Account fields override upstream; env/headers/oauth/authorizeParams merge one level deeper.
function merge(base: UpstreamFields, over: UpstreamFields): UpstreamFields {
  const out: UpstreamFields = { ...base, ...over };
  if (base.env || over.env) out.env = { ...base.env, ...over.env };
  if (base.headers || over.headers) out.headers = { ...base.headers, ...over.headers };
  if (base.oauth || over.oauth) {
    out.oauth = { ...base.oauth, ...over.oauth };
    if (base.oauth?.authorizeParams || over.oauth?.authorizeParams) {
      out.oauth.authorizeParams = { ...base.oauth?.authorizeParams, ...over.oauth?.authorizeParams };
    }
  }
  return out;
}

function toAccount(name: string, f: UpstreamFields): Account {
  if (f.command && f.url) throw new Error(`account "${name}": set either "command" or "url", not both`);
  if (f.command) {
    if (f.oauth) throw new Error(`account "${name}": "oauth" only applies to url upstreams`);
    return { kind: "stdio", command: f.command, args: f.args ?? [], env: f.env ?? {}, cwd: f.cwd };
  }
  if (f.url) {
    new URL(f.url); // throws on malformed URLs
    return { kind: "http", url: f.url, headers: f.headers ?? {}, oauth: f.oauth };
  }
  throw new Error(`account "${name}": needs "command" (stdio) or "url" (http)`);
}

export function parseConfig(raw: RawConfig, env: Record<string, string | undefined> = process.env): Config {
  if (typeof raw?.name !== "string" || !NAME_RE.test(raw.name)) {
    throw new Error(`config "name" must match ${NAME_RE}`);
  }
  const names = Object.keys(raw.accounts ?? {});
  if (names.length === 0) throw new Error("config has no accounts");
  const accounts: Record<string, Account> = {};
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new Error(`account name "${n}" must match ${NAME_RE}`);
    const { description, ...fields } = raw.accounts[n]!;
    if (description !== undefined && typeof description !== "string") throw new Error(`account "${n}": "description" must be a string`);
    accounts[n] = { ...toAccount(n, expandDeep(merge(raw.upstream ?? {}, fields), env)), ...(description ? { description } : {}) };
  }
  return { name: raw.name, accounts, store: raw.store && expandDeep(raw.store, env) };
}

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`config not found: ${path}`);
  return parseConfig(await file.json());
}
