# mcp-mux

Use several accounts of the same MCP server at once (two Gmails, a work and a client Slack, three Notion workspaces) from Claude Code or Codex. mcp-mux shows up as a single MCP server. Every tool gets a required `account` argument, each account logs in with its own OAuth session, and credentials stay in the system keychain.

```
Claude Code / Codex ──stdio──► mcp-mux ──► work     ─► upstream (its own process, or HTTP with its own token)
                                       ──► personal ─► upstream
```

- **One toolset**: the client sees the upstream's tools once. Each one gets `account: "work" | "personal"`, so the model has to name the account on every call.
- **Fails closed**: an unknown or missing account is an error. If one account's login has expired, calls to it return an error that tells you how to log in again. mcp-mux never falls back to a different account.
- **Per-account OAuth** for remote servers: discovery, dynamic client registration, PKCE, refresh, and pinning the login to a specific identity through `authorizeParams` (Google `login_hint`, Slack `team`, Microsoft `tenant`).
- **Isolation**: each account has its own process or HTTP session and its own credential entry. A stdio account only sees its own environment variables, not the other accounts'.
- **Local only**: no hosted middleman holds standing access to your mail.

This addresses [anthropics/claude-code#27302](https://github.com/anthropics/claude-code/issues/27302), [#44243](https://github.com/anthropics/claude-code/issues/44243) and [openai/codex#20500](https://github.com/openai/codex/issues/20500) for clients that run local MCP servers. It can't help claude.ai on the web, the mobile apps, or cloud routines, because those only connect to remote URLs.

## Install

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bunx mcp-mux --help
```

Or from a checkout: `bun install`, then `bun src/cli.ts --help`.

## Configure

One config file describes one upstream server and its accounts. `upstream` holds what all accounts share; each entry under `accounts` holds only what is different for that account.

A local (stdio) server, with each account given different arguments or environment variables:

```json
{
  "name": "fs",
  "upstream": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
  "accounts": {
    "work":     { "args": ["-y", "@modelcontextprotocol/server-filesystem", "${MUX_WORK_DIR}"] },
    "personal": { "args": ["-y", "@modelcontextprotocol/server-filesystem", "${MUX_PERSONAL_DIR}"],
                  "env": { "API_TOKEN": "${PERSONAL_TOKEN}" } }
  }
}
```

A remote server where every account uses the same URL and only the OAuth identity differs:

```json
{
  "name": "notion",
  "upstream": { "url": "https://mcp.notion.com/mcp", "oauth": {} },
  "accounts": {
    "work":     { "oauth": { "authorizeParams": { "login_hint": "me@corp.com" } } },
    "personal": {}
  }
}
```

`${VAR}` is expanded from mcp-mux's own environment, and a variable that isn't set is an error. If the authorization server doesn't support dynamic registration (Slack is one example), register an app yourself and set `oauth.clientId`, `oauth.clientSecret` and a fixed `oauth.callbackPort` that matches the app's redirect URI (`http://127.0.0.1:<port>/callback`).

Log in to each OAuth account once:

```sh
bunx mcp-mux login notion.mux.json work      # opens the browser
bunx mcp-mux login notion.mux.json personal
bunx mcp-mux status notion.mux.json
```

Tokens are stored in the macOS Keychain (service `mcp-mux`, account `<name>/<account>`). On other platforms they go to an AES-256-GCM encrypted file, with the key taken from `MCP_MUX_STORE_KEY` (`openssl rand -base64 32`). `bunx mcp-mux logout <config> <account>` removes one account's credentials and leaves the others alone.

## Add it to Claude Code

```sh
claude mcp add notion -- bunx mcp-mux serve /abs/path/notion.mux.json
```

or in `.mcp.json`:

```json
{
  "mcpServers": {
    "notion": { "command": "bunx", "args": ["mcp-mux", "serve", "/abs/path/notion.mux.json"] }
  }
}
```

## Add it to Codex

```sh
codex mcp add notion -- bunx mcp-mux serve /abs/path/notion.mux.json
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.notion]
command = "bunx"
args = ["mcp-mux", "serve", "/abs/path/notion.mux.json"]
```

To pass secrets to stdio accounts, set them in the client's `env` for this server and reference them as `${VAR}` in the mux config.

## Try it without real accounts

`examples/mock-oauth-server.ts` is a local OAuth-protected MCP server with two fake users. The identity comes only from the token, the same way Gmail or Notion work.

```sh
bun examples/mock-oauth-server.ts                                # http://127.0.0.1:47821/mcp
bun src/cli.ts login examples/mock-mail.mux.json work            # login_hint pins alice@work.example
bun src/cli.ts login examples/mock-mail.mux.json home            # pick alice@home.example on the consent page
claude mcp add mail -- bun "$PWD/src/cli.ts" serve "$PWD/examples/mock-mail.mux.json"
```

Then ask for `whoami` or `search_mail` with `account` set to `work` or `home`.

## Development

```sh
bun install
bun test          # config, stores (incl. a throwaway macOS keychain), routing over the real filesystem server, OAuth end to end
bun run typecheck
```

Design and research notes: [docs/design.md](docs/design.md), [docs/research.md](docs/research.md).

## Limitations

- Proxies tools only. Resources, prompts, and upstream `tools/list_changed` notifications aren't passed through yet.
- The MCP TypeScript SDK speaks protocol versions up to 2025-11-25. Upstreams that only support 2026-07-28 won't connect until the SDK adds support.
- All accounts must expose the same tools. If they don't, mcp-mux refuses to start and lists the differences.

## License

MIT
