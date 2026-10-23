import { expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseConfig, type Config } from "../src/config.ts";
import { buildMux, checkAccounts, connectAccount, type Mux } from "../src/mux.ts";
import { clientFor, text, tmp } from "./helpers.ts";

const fixture = join(import.meta.dir, "fixtures/paged-server.ts");
const tool = (name: string): Tool => ({ name, inputSchema: { type: "object" } });
type Pages = { pages: Tool[][]; cursors?: string[]; failPage?: number; outputs?: Record<string, CallToolResult> };
type Fixture = {
  cfg: Config;
  set: (account: string, pages: Pages) => Promise<void>;
  requests: (account: string) => Promise<unknown[]>;
  calls: (account: string) => Promise<unknown[]>;
  closed: (account: string) => Promise<boolean>;
};

async function withPages(accounts: Record<string, Pages>, run: (fixture: Fixture) => Promise<void>) {
  const dir = await tmp("pagination");
  const path = (account: string) => join(dir, `${account}.json`);
  const trace = (account: string) => join(dir, `${account}.trace`);
  const set = async (account: string, pages: Pages) => writeFile(path(account), JSON.stringify({ ...pages, trace: trace(account) }));
  try {
    await Promise.all(Object.entries(accounts).map(([account, pages]) => set(account, pages)));
    const cfg = parseConfig({ name: "paged", upstream: { command: "bun", args: [fixture] },
      accounts: Object.fromEntries(Object.keys(accounts).map((account) => [account, { args: [fixture, path(account)] }])) });
    const lines = async (path: string) => (await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    })).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await run({ cfg, set, requests: (account) => lines(trace(account)), calls: (account) => lines(trace(account) + ".calls"),
      closed: async (account) => !!(await stat(trace(account) + ".closed").catch(() => undefined)) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withMux(accounts: Record<string, Pages>, run: (mux: Mux, client: Client, fixture: Fixture) => Promise<void>) {
  await withPages(accounts, async (fixture) => {
    const mux = await buildMux(fixture.cfg);
    let client: Client | undefined;
    try {
      client = await clientFor(mux);
      await run(mux, client, fixture);
    } finally {
      await client?.close();
      await mux.close();
    }
  });
}

test("advertises and routes later-page tools, retaining a complete cached downstream list", async () => {
  await withMux({ a: { pages: [[tool("first")], [tool("later")]] } }, async (mux, client, fixture) => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(["first", "later"]);
    expect(result.nextCursor).toBeUndefined();
    expect(result.tools[1]!.inputSchema.properties!.account).toMatchObject({ enum: ["a"] });
    expect(result.tools[1]!.inputSchema.required).toEqual(["account"]);
    const called = await client.callTool({ name: "later", arguments: { account: "a", value: "x" } });
    expect(text(called)).toBe("later");
    expect(called._meta).toMatchObject({ "mcp-mux/account": "a", received: { value: "x" } });
    await client.listTools();
    expect(await fixture.requests("a")).toEqual([{ cursor: null }, { cursor: "page:1" }]);
    expect(mux.tools.map((tool) => tool.name)).toEqual(["first", "later"]);
  });
});

test("accepts equal inventories with different page boundaries and counts every tool in status", async () => {
  const accounts = { a: { pages: [[tool("first")], [tool("later")]] }, b: { pages: [[tool("first"), tool("later")]] } };
  await withMux(accounts, async (_mux, client, fixture) => {
    expect((await client.listTools()).tools).toHaveLength(2);
    expect(await checkAccounts(fixture.cfg, (a) => a)).toEqual([{ account: "a", ok: true, tools: 2 }, { account: "b", ok: true, tools: 2 }]);
  });
});

test("rejects a toolset mismatch found only on a later page", async () => {
  await withPages({ a: { pages: [[tool("first")], [tool("later")]] }, b: { pages: [[tool("first")], [tool("other")]] } }, async ({ cfg }) => {
    await expect(buildMux(cfg)).rejects.toThrow('different toolset than "a" (missing: later; extra: other)');
  });
});

test("follows an empty-string cursor and an empty intermediate page", async () => {
  await withMux({ a: { pages: [[tool("first")], [], [tool("later")]], cursors: ["", "last"] } }, async (_mux, client, fixture) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["first", "later"]);
    expect(await fixture.requests("a")).toEqual([{ cursor: null }, { cursor: "" }, { cursor: "last" }]);
  });
});

test("reconnect validates all pages even when the page boundaries change", async () => {
  await withMux({ a: { pages: [[tool("first")], [tool("later"), tool("crash")]] } }, async (mux, client, fixture) => {
    await fixture.set("a", { pages: [[tool("first"), tool("later")], [tool("crash")]] });
    expect((await client.callTool({ name: "crash", arguments: { account: "a" } })).isError).toBe(true);
    expect(text(await client.callTool({ name: "later", arguments: { account: "a" } }))).toBe("later");
    expect(mux.unavailable.size).toBe(0);
    expect(await fixture.requests("a")).toHaveLength(4);
  });
});

test("reconnect rejects a changed inventory on a later page", async () => {
  await withMux({ a: { pages: [[tool("first")], [tool("later"), tool("crash")]] } }, async (mux, client, fixture) => {
    await fixture.set("a", { pages: [[tool("first")], [tool("other"), tool("crash")]] });
    expect((await client.callTool({ name: "crash", arguments: { account: "a" } })).isError).toBe(true);
    const result = await client.callTool({ name: "later", arguments: { account: "a" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("missing: later; extra: other");
    expect(mux.unavailable.has("a")).toBe(true);
  });
});

test("a repeated cursor fails promptly during startup and status instead of looping", async () => {
  await withPages({ a: { pages: [[tool("first")], [tool("later")]], cursors: ["same", "same"] } }, async (fixture) => {
    await expect(buildMux(fixture.cfg)).rejects.toThrow("upstream tools/list returned a repeated cursor");
    const checks = await checkAccounts(fixture.cfg, (a) => a);
    expect(checks[0]).toMatchObject({ account: "a", ok: false, error: "failed to connect: upstream tools/list returned a repeated cursor" });
    expect(await fixture.requests("a")).toHaveLength(4);
  });
});

test("does not serve a partial inventory when a later page fails", async () => {
  await withPages({ a: { pages: [[tool("first")], [tool("later")]], failPage: 1 } }, async ({ cfg }) => {
    await expect(buildMux(cfg)).rejects.toThrow("later page failed");
    expect((await checkAccounts(cfg, (a) => a))[0]).toMatchObject({ account: "a", ok: false });
  });
});

test("a later-page account argument collision closes every upstream", async () => {
  const clash: Tool = { name: "clash", inputSchema: { type: "object", properties: { account: {} } } };
  const pages = { pages: [[tool("first")], [clash]] };
  await withPages({ a: pages, b: pages }, async (fixture) => {
    await expect(buildMux(fixture.cfg)).rejects.toThrow('upstream tool "clash" already has an "account" argument');
    expect(await fixture.closed("a")).toBe(true);
    expect(await fixture.closed("b")).toBe(true);
  });
});

test("preserves SDK output validation for tools on an earlier page", async () => {
  const checked: Tool = { ...tool("checked"), outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const outputs = { checked: { content: [{ type: "text" as const, text: "bad output" }], structuredContent: { value: 42 } } };
  await withMux({ a: { pages: [[checked], [tool("later")]], outputs } }, async (_mux, client) => {
    // Do not list tools on the downstream client: its own validators must not mask an upstream regression.
    const result = await client.callTool({ name: "checked", arguments: { account: "a" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("[account a]");
    expect(text(result)).toContain("Structured content does not match");
  });
});

test("preserves SDK required-task checks on every page without sending the call upstream", async () => {
  const required = (name: string): Tool => ({ ...tool(name), execution: { taskSupport: "required" } });
  await withMux({ a: { pages: [[required("first")], [required("later")]] } }, async (_mux, client, fixture) => {
    for (const name of ["first", "later"]) {
      const result = await client.callTool({ name, arguments: { account: "a" } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("requires task-based execution");
    }
    expect(await fixture.calls("a")).toEqual([]);
  });
});

test("reconnect refreshes SDK metadata for the complete inventory", async () => {
  const checked: Tool = { ...tool("checked"), outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const required: Tool = { ...tool("required"), execution: { taskSupport: "required" } };
  const outputs = { checked: { content: [{ type: "text" as const, text: "missing structured output" }] } };
  await withMux({ a: { pages: [[checked, required], [tool("crash")]], outputs } }, async (_mux, client, fixture) => {
    expect((await client.callTool({ name: "crash", arguments: { account: "a" } })).isError).toBe(true);
    const badOutput = await client.callTool({ name: "checked", arguments: { account: "a" } });
    expect(badOutput.isError).toBe(true);
    expect(text(badOutput)).toContain("has an output schema but did not return structured content");
    const task = await client.callTool({ name: "required", arguments: { account: "a" } });
    expect(task.isError).toBe(true);
    expect(text(task)).toContain("requires task-based execution");
    expect(await fixture.calls("a")).toEqual([{ name: "crash" }, { name: "checked" }]);
  });
});

test("explicit cursor requests retain the SDK's single-page behavior", async () => {
  await withPages({ a: { pages: [[tool("first")], [tool("middle")], [tool("last")]] } }, async (fixture) => {
    const client = await connectAccount(fixture.cfg.name, "a", fixture.cfg.accounts.a!);
    try {
      const result = await client.listTools({ cursor: "page:1" });
      expect(result.tools.map((tool) => tool.name)).toEqual(["middle"]);
      expect(result.nextCursor).toBe("page:2");
      expect(await fixture.requests("a")).toEqual([{ cursor: "page:1" }]);
    } finally {
      await client.close();
    }
  });
});

test("preserves request metadata and leaves custom result schemas single-page", async () => {
  await withPages({ a: { pages: [[tool("first")], [tool("later")]] } }, async (fixture) => {
    const client = await connectAccount(fixture.cfg.name, "a", fixture.cfg.accounts.a!);
    try {
      const custom = await client.request({ method: "tools/list" }, ListToolsResultSchema.extend({}));
      expect(custom.tools.map((tool) => tool.name)).toEqual(["first"]);
      expect(custom.nextCursor).toBe("page:1");
      const _meta = { trace: "pagination-test" };
      const complete = await client.request({ method: "tools/list", params: { _meta } }, ListToolsResultSchema, { signal: new AbortController().signal });
      expect(complete.tools.map((tool) => tool.name)).toEqual(["first", "later"]);
      expect(await fixture.requests("a")).toEqual([{ cursor: null }, { cursor: null, _meta }, { cursor: "page:1", _meta }]);
    } finally {
      await client.close();
    }
  });
});
