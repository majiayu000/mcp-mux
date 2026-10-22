import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseConfig } from "../src/config.ts";
import { buildMux, checkAccounts, rewriteTools, type BeforeCall, type Mux } from "../src/mux.ts";
import { clientFor, text, tmp } from "./helpers.ts";

const root = join(import.meta.dir, "..");
const FS = join(root, "node_modules/.bin/mcp-server-filesystem");
const ECHO = join(import.meta.dir, "fixtures/echo-server.ts");

test("rewriteTools injects a required account enum", () => {
  const [t] = rewriteTools(
    [{ name: "read", description: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    ["work", "home"],
  );
  expect(t!.inputSchema.properties!.account).toMatchObject({ type: "string", enum: ["work", "home"] });
  expect(t!.inputSchema.required).toEqual(["account", "path"]);
  expect(t!.description).toContain("Accounts: work, home.");
  const [labeled] = rewriteTools([{ name: "read", inputSchema: { type: "object" } }], ["work", "home"], { work: "me@corp.com" });
  expect(labeled!.inputSchema.properties!.account).toMatchObject({ description: "Which account to use: work (me@corp.com), home" });
  expect(labeled!.description).toBe("Accounts: work (me@corp.com), home.");
  expect(() => rewriteTools([{ name: "x", inputSchema: { type: "object", properties: { account: {} } } }], ["a"])).toThrow(
    'already has an "account" argument',
  );
});

describe("filesystem server as two accounts", () => {
  let work: string, home: string, mux: Mux, client: Client;

  beforeAll(async () => {
    const base = await realpath(await tmp("fs"));
    work = join(base, "work");
    home = join(base, "home");
    await mkdir(work);
    await mkdir(home);
    await Bun.write(join(work, "plan.txt"), "work plan");
    await Bun.write(join(home, "plan.txt"), "home plan");
    const cfg = parseConfig({
      name: "fs",
      upstream: { command: "bun", args: [FS] },
      accounts: { work: { args: [FS, work] }, home: { args: [FS, home] } },
    });
    mux = await buildMux(cfg);
    client = await clientFor(mux);
  });
  afterAll(async () => {
    await client.close();
    await mux.close();
  });

  test("lists the upstream tools once, each with the account argument", async () => {
    const { tools } = await client.listTools();
    const read = tools.find((t) => t.name === "read_text_file")!;
    expect(read.inputSchema.properties!.account).toMatchObject({ enum: ["work", "home"] });
    expect(read.inputSchema.required![0]).toBe("account");
  });

  test("routes by account and keeps accounts isolated", async () => {
    const w = await client.callTool({ name: "read_text_file", arguments: { account: "work", path: join(work, "plan.txt") } });
    const h = await client.callTool({ name: "read_text_file", arguments: { account: "home", path: join(home, "plan.txt") } });
    expect(text(w)).toBe("work plan");
    expect(text(h)).toBe("home plan");
    expect(w._meta).toMatchObject({ "mcp-mux/account": "work" });
    const cross = await client.callTool({ name: "read_text_file", arguments: { account: "home", path: join(work, "plan.txt") } });
    expect(cross.isError).toBe(true);
    expect(text(cross)).toContain("Access denied");
  });

  test("rejects missing or unknown accounts instead of picking one", async () => {
    await expect(client.callTool({ name: "list_allowed_directories", arguments: { account: "nope" } })).rejects.toThrow(
      'unknown account "nope"; expected one of: work, home',
    );
    await expect(client.callTool({ name: "list_allowed_directories", arguments: {} })).rejects.toThrow("unknown account undefined");
  });
});

describe("stdio isolation and failure modes", () => {
  test("each account's process only sees its own env", async () => {
    const cfg = parseConfig(
      {
        name: "echo",
        upstream: { command: "bun", args: [ECHO] },
        accounts: { a: { env: { TOKEN: "${A_TOKEN}" } }, b: { env: { TOKEN: "${B_TOKEN}" } } },
      },
      { A_TOKEN: "token-a", B_TOKEN: "token-b" },
    );
    process.env.MUX_PARENT_SECRET = "leak";
    const mux = await buildMux(cfg);
    const c = await clientFor(mux);
    try {
      const get = async (account: string, name: string) => text(await c.callTool({ name: "get_env", arguments: { account, name } }));
      expect(await get("a", "TOKEN")).toBe("token-a");
      expect(await get("b", "TOKEN")).toBe("token-b");
      expect(await get("b", "A_TOKEN")).toBe("<unset>");
      expect(await get("a", "MUX_PARENT_SECRET")).toBe("<unset>");
    } finally {
      delete process.env.MUX_PARENT_SECRET;
      await c.close();
      await mux.close();
    }
  });

  test("upstream errors come back as tool errors tagged with the account", async () => {
    const mux = await buildMux(parseConfig({ name: "echo", upstream: { command: "bun", args: [ECHO] }, accounts: { a: {} } }));
    const c = await clientFor(mux);
    const r = await c.callTool({ name: "fail", arguments: { account: "a" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("upstream exploded");
    await c.close();
    await mux.close();
  });

  test("refuses to start when accounts expose different tools", async () => {
    const cfg = parseConfig({ name: "echo", upstream: { command: "bun", args: [ECHO] }, accounts: { a: {}, b: { args: [ECHO, "--extra-tool"] } } });
    await expect(buildMux(cfg)).rejects.toThrow('account "b" exposes a different toolset than "a" (missing: -; extra: extra)');
  });

  test("refuses upstream tools that already take an account argument", async () => {
    const cfg = parseConfig({ name: "echo", upstream: { command: "bun", args: [ECHO, "--account-param"] }, accounts: { a: {} } });
    await expect(buildMux(cfg)).rejects.toThrow('upstream tool "clash" already has an "account" argument');
  });

  test("an account that fails to start is reported, the rest keep working", async () => {
    const cfg = parseConfig({ name: "echo", upstream: { command: "bun", args: [ECHO] }, accounts: { a: {}, broken: { command: "/nonexistent/bin" } } });
    const mux = await buildMux(cfg);
    const c = await clientFor(mux);
    expect(text(await c.callTool({ name: "get_env", arguments: { account: "a", name: "PATH" } }))).not.toBe("<unset>");
    const r = await c.callTool({ name: "get_env", arguments: { account: "broken", name: "PATH" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('account "broken" is unavailable: failed to connect');
    await c.close();
    await mux.close();
  });

  test("a crashed upstream is restarted on the next call; other accounts are unaffected", async () => {
    const cfg = parseConfig({ name: "echo", upstream: { command: "bun", args: [ECHO, "--crash-tool"], env: { WHO: "x" } }, accounts: { a: { env: { WHO: "a" } }, b: { env: { WHO: "b" } } } });
    const mux = await buildMux(cfg);
    const c = await clientFor(mux);
    const who = async (account: string) => c.callTool({ name: "get_env", arguments: { account, name: "WHO" } });
    expect((await c.callTool({ name: "crash", arguments: { account: "a" } })).isError).toBe(true);
    expect(text(await who("b"))).toBe("b");
    expect(text(await who("a"))).toBe("a");
    expect(mux.unavailable.size).toBe(0);
    await c.close();
    await mux.close();
  });

  test("checkAccounts reports each account without starting a server", async () => {
    const cfg = parseConfig({ name: "echo", upstream: { command: "bun", args: [ECHO] }, accounts: { a: {}, broken: { command: "/nonexistent/bin" } } });
    const r = await checkAccounts(cfg, (a) => `login ${a}`);
    expect(r[0]).toEqual({ account: "a", ok: true, tools: 2 });
    expect(r[1]).toMatchObject({ account: "broken", ok: false });
    expect((r[1] as { error: string }).error).toContain("failed to connect");
  });

  test("beforeCall hook can deny a call before it reaches the upstream", async () => {
    const seen: string[] = [];
    const beforeCall: BeforeCall = async (ctx) => {
      seen.push(`${ctx.account}:${ctx.tool}:${JSON.stringify(ctx.args)}`);
      return ctx.account === "b" ? { allow: false, reason: "b is read-only" } : { allow: true };
    };
    const mux = await buildMux(parseConfig({ name: "echo", upstream: { command: "bun", args: [ECHO] }, accounts: { a: {}, b: {} } }), { beforeCall });
    const c = await clientFor(mux);
    expect((await c.callTool({ name: "get_env", arguments: { account: "a", name: "X" } })).isError).toBeFalsy();
    const denied = await c.callTool({ name: "get_env", arguments: { account: "b", name: "X" } });
    expect(text(denied)).toBe("denied: b is read-only");
    expect(seen).toEqual(['a:get_env:{"name":"X"}', 'b:get_env:{"name":"X"}']);
    await c.close();
    await mux.close();
  });
});

test("CLI serve speaks MCP over stdio end to end", async () => {
  const dir = await realpath(await tmp("cli"));
  await mkdir(join(dir, "w"));
  await mkdir(join(dir, "h"));
  const cfgPath = join(dir, "fs.mux.json");
  await Bun.write(cfgPath, JSON.stringify({ name: "fs", upstream: { command: "bun", args: [FS] }, accounts: { w: { args: [FS, join(dir, "w")] }, h: { args: [FS, join(dir, "h")] } } }));
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StdioClientTransport({ command: "bun", args: [join(root, "src/cli.ts"), "serve", cfgPath], stderr: "ignore" }));
  const r = await c.callTool({ name: "list_allowed_directories", arguments: { account: "h" } });
  expect(text(r)).toContain(join(dir, "h"));
  expect(text(r)).not.toContain(join(dir, "w"));
  await c.close();
});
