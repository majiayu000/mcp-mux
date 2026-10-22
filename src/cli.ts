#!/usr/bin/env bun
// mcp-mux CLI: serve | login | logout | status
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { buildMux, log, storeKey } from "./mux.ts";
import { login, openInBrowser } from "./oauth.ts";
import { openStore } from "./store.ts";

const USAGE = `usage:
  mcp-mux serve  <config.json>             run as a stdio MCP server
  mcp-mux login  <config.json> <account> [--no-browser]
                                           OAuth login for one account (opens a browser; --no-browser only prints the URL)
  mcp-mux logout <config.json> <account>   delete one account's stored credentials
  mcp-mux status <config.json>             show accounts and whether credentials are stored`;

async function main(argv: string[]) {
  const noBrowser = argv.includes("--no-browser");
  const [cmd, path, account] = argv.filter((a) => a !== "--no-browser");
  if (!cmd || !path || cmd === "-h" || cmd === "--help") {
    console.error(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  const cfg = await loadConfig(path);
  const pick = () => {
    if (!account) throw new Error(`${cmd} needs an account name; one of: ${Object.keys(cfg.accounts).join(", ")}`);
    const a = cfg.accounts[account];
    if (!a) throw new Error(`unknown account "${account}"; one of: ${Object.keys(cfg.accounts).join(", ")}`);
    return a;
  };

  switch (cmd) {
    case "serve": {
      const mux = await buildMux(cfg, { loginHint: (a) => `run: mcp-mux login ${path} ${a}` });
      await mux.server.connect(new StdioServerTransport());
      const ready = Object.keys(cfg.accounts).filter((a) => !mux.unavailable.has(a));
      log(`ready: ${mux.tools.length} tools x ${ready.length}/${Object.keys(cfg.accounts).length} accounts (${ready.join(", ")})`);
      return;
    }
    case "login": {
      const a = pick();
      if (a.kind !== "http" || !a.oauth) throw new Error(`account "${account}" is not an OAuth (url + "oauth") account`);
      const open = noBrowser ? (u: URL) => console.error(`[mcp-mux] open this URL to log in:\n${u.href}`) : openInBrowser;
      const { tools } = await login({ account: a, key: storeKey(cfg.name, account!), store: openStore(cfg.store), open });
      console.error(`[mcp-mux] logged in "${account}" (${tools} tools available)`);
      return;
    }
    case "logout": {
      pick();
      await openStore(cfg.store).delete(storeKey(cfg.name, account!));
      console.error(`[mcp-mux] removed stored credentials for "${account}"`);
      return;
    }
    case "status": {
      const oauth = Object.entries(cfg.accounts).some(([, a]) => a.kind === "http" && a.oauth);
      const store = oauth ? openStore(cfg.store) : undefined;
      for (const [n, a] of Object.entries(cfg.accounts)) {
        let auth = "-";
        if (a.kind === "http" && a.oauth) {
          const raw = await store!.get(storeKey(cfg.name, n));
          auth = raw && JSON.parse(raw).tokens ? "token stored" : "not logged in";
        }
        console.log(`${n}\t${a.kind === "stdio" ? `stdio: ${a.command} ${a.args.join(" ")}` : `http: ${a.url}`}\t${auth}`);
      }
      return;
    }
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((e) => {
  log("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
