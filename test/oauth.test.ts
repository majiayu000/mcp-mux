import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { startMockOAuthServer } from "../examples/mock-oauth-server.ts";
import { parseConfig, type Config, type HttpAccount } from "../src/config.ts";
import { buildMux, checkAccounts, storeKey } from "../src/mux.ts";
import { login } from "../src/oauth.ts";
import { EncryptedFileStore } from "../src/store.ts";
import { clientFor, text, tmp } from "./helpers.ts";

// Stand-in for the user's browser: follow the provider's redirect back to the local callback.
const browser = async (url: URL) => {
  await fetch(url, { redirect: "follow" });
};

describe("OAuth upstream, two accounts on one URL", () => {
  let mock: ReturnType<typeof startMockOAuthServer>;
  let cfg: Config;
  let store: EncryptedFileStore;
  const acct = (n: string) => cfg.accounts[n] as HttpAccount;

  beforeAll(async () => {
    mock = startMockOAuthServer();
    store = new EncryptedFileStore(join(await tmp("oauth"), "creds.json"), randomBytes(32).toString("base64"));
    cfg = parseConfig({
      name: "mail",
      upstream: { url: mock.url, oauth: {} },
      accounts: {
        work: { oauth: { authorizeParams: { login_hint: "alice@work.example" } } },
        home: { oauth: { authorizeParams: { login_hint: "alice@home.example" } } },
      },
    });
  });
  afterAll(() => mock.stop());

  test("serve before login: every account needs login, so startup fails with the hint", async () => {
    await expect(buildMux(cfg, { store })).rejects.toThrow("work: needs login; run: mcp-mux login <config> work");
    const r = await checkAccounts(cfg, (a) => `login ${a}`, store);
    expect(r).toEqual([
      { account: "work", ok: false, error: "needs login; login work" },
      { account: "home", ok: false, error: "needs login; login home" },
    ]);
  });

  test("login each account through discovery, DCR, PKCE and the local callback", async () => {
    const opened: URL[] = [];
    for (const n of ["work", "home"]) {
      const r = await login({ account: acct(n), key: storeKey("mail", n), store, open: async (u) => (opened.push(u), browser(u)) });
      expect(r.tools).toBe(2);
    }
    expect(opened.map((u) => u.searchParams.get("login_hint"))).toEqual(["alice@work.example", "alice@home.example"]);
    for (const u of opened) {
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("resource")).toBe(mock.url);
      expect(u.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    }
    expect(mock.stats.codeExchanges).toBe(2);
    // Credentials are stored per account and encrypted.
    const work = JSON.parse((await store.get("mail/work"))!);
    const home = JSON.parse((await store.get("mail/home"))!);
    expect(work.tokens.access_token).not.toBe(home.tokens.access_token);
    expect(work.client.client_id).not.toBe(home.client.client_id);
    expect(await checkAccounts(cfg, (a) => a, store)).toEqual([
      { account: "work", ok: true, tools: 2 },
      { account: "home", ok: true, tools: 2 },
    ]);
  });

  test("one mux, same URL, each account acts as its own identity", async () => {
    const mux = await buildMux(cfg, { store });
    const c = await clientFor(mux);
    const call = (account: string, name: string, args = {}) => c.callTool({ name, arguments: { account, ...args } });
    expect(text(await call("work", "whoami"))).toBe("alice@work.example");
    expect(text(await call("home", "whoami"))).toBe("alice@home.example");
    expect(JSON.parse(text(await call("work", "search_mail", { query: "invoice" })))).toEqual(["Invoice #4411 from Acme"]);
    expect(JSON.parse(text(await call("home", "search_mail", { query: "invoice" })))).toEqual([]);

    // Expired access tokens are refreshed transparently and the rotated tokens are stored.
    const before = JSON.parse((await store.get("mail/work"))!).tokens.refresh_token;
    mock.expireAllTokens();
    expect(text(await call("work", "whoami"))).toBe("alice@work.example");
    expect(mock.stats.refreshes).toBe(1);
    expect(JSON.parse((await store.get("mail/work"))!).tokens.refresh_token).not.toBe(before);

    // A dead refresh token takes down only that account, with an actionable error.
    mock.expireAllTokens();
    mock.revokeRefreshTokens();
    const r = await call("home", "whoami");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('account "home" is unavailable: needs login; run: mcp-mux login <config> home');
    await c.close();
    await mux.close();
  });

  test("logout removes one account only; logging back in works without restarting the server", async () => {
    await login({ account: acct("work"), key: storeKey("mail", "work"), store, open: browser });
    await login({ account: acct("home"), key: storeKey("mail", "home"), store, open: browser });
    await store.delete(storeKey("mail", "home"));
    const mux = await buildMux(cfg, { store });
    expect([...mux.unavailable.keys()]).toEqual(["home"]);
    const c = await clientFor(mux);
    expect(text(await c.callTool({ name: "whoami", arguments: { account: "work" } }))).toBe("alice@work.example");
    expect((await c.callTool({ name: "whoami", arguments: { account: "home" } })).isError).toBe(true);
    await login({ account: acct("home"), key: storeKey("mail", "home"), store, open: browser });
    expect(text(await c.callTool({ name: "whoami", arguments: { account: "home" } }))).toBe("alice@home.example");
    await c.close();
    await mux.close();
  });

  test("login rejects a callback whose state does not match", async () => {
    const forge = async (u: URL) => {
      const redirect = new URL(u.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "stolen");
      redirect.searchParams.set("state", "forged");
      await fetch(redirect);
    };
    await expect(login({ account: acct("work"), key: storeKey("mail", "work"), store, open: forge })).rejects.toThrow("state mismatch");
  });

  test("login rejects an authorization response from the wrong issuer", async () => {
    const wrongIss = async (u: URL) => {
      const res = await fetch(u, { redirect: "manual" });
      const back = new URL(res.headers.get("location")!);
      back.searchParams.set("iss", "https://attacker.example");
      await fetch(back);
    };
    await expect(login({ account: acct("work"), key: storeKey("mail", "work"), store, open: wrongIss })).rejects.toThrow("issuer mismatch");
  });
});
