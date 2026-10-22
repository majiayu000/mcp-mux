import { describe, expect, test } from "bun:test";
import { expand, parseConfig } from "../src/config.ts";

describe("config", () => {
  test("merges account overrides onto the shared upstream", () => {
    const cfg = parseConfig(
      {
        name: "notion",
        upstream: { url: "https://mcp.example.com/mcp", headers: { "X-A": "1" }, oauth: { scope: "read", authorizeParams: { prompt: "consent" } } },
        accounts: {
          work: { headers: { "X-B": "2" }, oauth: { authorizeParams: { login_hint: "me@corp" } } },
          home: {},
        },
      },
      {},
    );
    expect(cfg.accounts.work).toEqual({
      kind: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-A": "1", "X-B": "2" },
      oauth: { scope: "read", authorizeParams: { prompt: "consent", login_hint: "me@corp" } },
    });
    expect(cfg.accounts.home).toMatchObject({ kind: "http", oauth: { authorizeParams: { prompt: "consent" } } });
  });

  test("expands ${VAR} and fails on unset vars", () => {
    expect(expand("Bearer ${T}", { T: "abc" })).toBe("Bearer abc");
    expect(() => parseConfig({ name: "x", upstream: { command: "c" }, accounts: { a: { env: { K: "${NOPE}" } } } }, {})).toThrow(
      "config references unset env var NOPE",
    );
  });

  test("stdio account replaces args and merges env", () => {
    const cfg = parseConfig(
      { name: "fs", upstream: { command: "bun", args: ["s.ts"], env: { A: "1" } }, accounts: { w: { args: ["s.ts", "/w"], env: { B: "${X}" } } } },
      { X: "2" },
    );
    expect(cfg.accounts.w).toEqual({ kind: "stdio", command: "bun", args: ["s.ts", "/w"], env: { A: "1", B: "2" }, cwd: undefined });
  });

  test("rejects invalid configs", () => {
    const bad: [unknown, string][] = [
      [{ name: "x", accounts: {} }, "no accounts"],
      [{ name: "bad name", accounts: { a: { command: "c" } } }, '"name" must match'],
      [{ name: "x", accounts: { "a b": { command: "c" } } }, 'account name "a b"'],
      [{ name: "x", accounts: { a: { command: "c", url: "http://x" } } }, "not both"],
      [{ name: "x", accounts: { a: {} } }, 'needs "command"'],
      [{ name: "x", accounts: { a: { command: "c", oauth: {} } } }, '"oauth" only applies to url'],
      [{ name: "x", accounts: { a: { url: "not a url" } } }, ""],
    ];
    for (const [raw, msg] of bad) expect(() => parseConfig(raw as never, {})).toThrow(msg);
  });
});
