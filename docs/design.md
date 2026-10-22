# mcp-mux 设计

目标：把"同一个 MCP server 的 N 个账号"变成**一个** stdio MCP server。每个工具多一个必填的 `account` 参数，调用按账号路由；需要 OAuth 的上游按账号分别登录，凭据按账号隔离存储。

非目标（v0.1）：远端托管、claude.ai 网页 / 手机端、跨账号聚合搜索、resources / prompts 代理、热重载配置。

```
Claude Code / Codex ──stdio──► mcp-mux ──► account "work"     ─► 上游（stdio 子进程 或 HTTP + 该账号 token）
     一个 server，                │     ──► account "personal" ─► 上游
     一套工具 + account 参数       └─ 凭据存储：系统钥匙串 或 AES-256-GCM 文件，键 = <name>/<account>
```

## 1. 配置格式

一个配置文件描述**一个上游 server 和它的若干账号**。`upstream` 是所有账号共用的部分，`accounts.<name>` 里只写这个账号不同的地方。

```jsonc
// stdio 上游：账号差异在 args / env
{
  "name": "fs",
  "upstream": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] },
  "accounts": {
    "work":     { "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/work"] },
    "personal": { "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/home"],
                  "env": { "SOME_TOKEN": "${PERSONAL_TOKEN}" } }
  }
}
```

```jsonc
// HTTP + OAuth 上游：URL 相同，账号只靠 OAuth 身份区分
{
  "name": "notion",
  "upstream": { "url": "https://mcp.notion.com/mcp", "oauth": {} },
  "accounts": {
    "work":     { "oauth": { "authorizeParams": { "login_hint": "me@corp.com" } } },
    "personal": {}
  }
}
```

字段：

| 字段 | 说明 |
|---|---|
| `name` | 必填。用作 MCP server 名和凭据键前缀。只允许 `[A-Za-z0-9_-]`。 |
| `upstream.command` / `args` / `env` / `cwd` | stdio 上游。 |
| `upstream.url` / `headers` | HTTP（Streamable HTTP）上游。 |
| `upstream.oauth` | 出现即表示该上游用 OAuth。子字段：`clientId`、`clientSecret`（预注册客户端，用于不支持 DCR/CIMD 的 AS，如 Slack）、`scope`、`callbackPort`（预注册时必须和登记的回调一致；默认临时端口）、`authorizeParams`（追加到授权 URL，用于锁定账号）。 |
| `accounts.<name>` | 必填，至少一个。账号名只允许 `[A-Za-z0-9_-]`。可写的字段与 `upstream` 相同，另加可选的 `description`。 |
| `accounts.<name>.description` | 可选。给模型看的账号标签，比如邮箱地址或 workspace 名，会写进 `account` 参数说明：`work (me@corp.com), personal`。 |
| `store` | 可选。`{"type":"keychain","keychain":"<路径>"}` 或 `{"type":"file","path":"<路径>"}`。默认：macOS 用登录钥匙串，其他平台用文件。 |

合并规则只有一条：账号字段覆盖 `upstream` 同名字段；`env`、`headers`、`oauth`、`oauth.authorizeParams` 这几个对象再往下合并一层。没有模板语言。

字符串里的 `${VAR}` 从 mcp-mux 自己的环境变量展开；引用了未设置的变量直接报错退出，不会悄悄变成空串。密钥因此可以只放在环境变量里，配置文件可以提交。

拒绝启动的情况：没有账号；账号名或 `name` 不合法；同一账号既有 `command` 又有 `url`，或两者都没有；`oauth` 用在 stdio 上游上。

## 2. 上游传输

### 2.1 stdio 上游

- **每个账号一个子进程**，各自的 args / env / cwd。这就是 stdio 上的"账号"：规范要求 stdio 实现从环境读凭据，不走 OAuth。
- 子进程环境 = SDK 的安全默认集（`PATH`、`HOME`、`USER`、`SHELL`、`TERM`、`LOGNAME`）+ 该账号的 `env`。**不继承 mcp-mux 的完整环境**，所以 `personal` 进程看不到给 `work` 用的 `WORK_TOKEN`。原型里把 `process.env` 整个传了下去，这一点改掉了。
- 子进程 stderr 继承到 mcp-mux 的 stderr（客户端日志里能看到上游报错）。

### 2.2 HTTP 上游

- 每个账号一个 `StreamableHTTPClientTransport` + 一个 `Client`，会话（`Mcp-Session-Id`）天然按账号分开。
- 有 `oauth` 时给 transport 挂一个**只属于这个账号**的 `OAuthClientProvider`（见第 5 节）；没有时只发静态 `headers`。
- 协议版本：SDK 1.32.1 只会说到 2025-11-25（initialize 时代）。只支持 2026-07-28 的上游目前连不上，等 SDK 升级后跟进，代码里不手写新协议。

## 3. 工具 schema 改写

启动时对每个账号 `tools/list`，取**第一个连上的账号**的工具列表作为规范工具集：

- 其他已连上的账号工具名集合必须一致，不一致直接报错退出（说明哪个账号多了 / 少了什么）。
- 每个工具 `inputSchema.properties` 前面插入：

  ```json
  "account": { "type": "string", "enum": ["work", "personal"], "description": "Which account to use: work, personal" }
  ```

  并把 `account` 放进 `required` 首位。
- 描述末尾追加 `Accounts: work (me@corp.com), personal.`（有 `description` 时带上），让模型在只看描述时也知道要选哪个账号。
- 上游工具自己已经有名为 `account` 的参数时拒绝启动（不做重命名，避免语义混淆）。
- 其余字段（`annotations`、`outputSchema`、`title`）原样透传。

调用时：取出 `account`，校验它在 enum 里，剩余参数原样转发给该账号的上游。返回结果原样透传，并在 `_meta` 里加 `"mcp-mux/account": "<name>"`，方便日志和以后的客户端展示来源账号。

## 4. 按账号隔离

| 层面 | 隔离方式 |
|---|---|
| 进程 / 连接 | 每账号一个子进程或一个 HTTP transport，不共享 |
| 环境变量 | stdio 子进程只拿安全默认集 + 本账号 env |
| OAuth 状态 | 每账号一个 provider 实例；客户端注册、token、发现缓存都存在 `<name>/<account>` 键下；PKCE verifier 只在内存 |
| 登出 / 刷新 | `logout <account>` 只删这一个键；某账号 refresh 失败只把这个账号标成"需要登录" |
| 路由 | `account` 不在 enum 里 → JSON-RPC `InvalidParams`；绝不回退到默认账号 |

## 5. OAuth 流程

### 5.1 登录（`mcp-mux login <config> <account>`）

MCP 客户端拉起 mcp-mux 时 stdin/stdout 被占着，也不保证有人在电脑前，所以**交互式登录走单独的 CLI 命令**，serve 模式只用已存的 token。

1. 在 `127.0.0.1:<callbackPort 或临时端口>` 起回调服务器，`redirect_uri = http://127.0.0.1:<port>/callback`。
2. 用该账号的 provider 建 transport 去连上游。SDK 收到 401 后完成：PRM 发现 → AS 元数据发现（校验 issuer）→ 客户端注册（预注册 `clientId` > CIMD > DCR）→ 生成 PKCE S256 + `resource` → 回调 `redirectToAuthorization(url)`。
3. provider 在这一步把 `authorizeParams` 加到 URL 上（如 Slack `team`、Google `login_hint`），然后打开浏览器（同时把 URL 打到 stderr，打不开浏览器时可手动复制；`--no-browser` 只打印 URL，适合 SSH 场景）。
4. 回调服务器校验 `state`、按 RFC 9207 校验 `iss`（AS 声明支持却没带 → 拒绝；带了就必须和发现时记录的 issuer 完全相等），取出 `code`。
5. `transport.finishAuth(code)` 换 token（带 `code_verifier` 和 `resource`），provider 存盘。
6. 重新连接并 `tools/list` 一次，确认这个账号可用，打印工具数。

DCR 注册的客户端信息里记录了 `redirect_uris`。临时端口每次不同，所以 provider 发现已存的 `redirect_uris` 不含当前回调地址时，当作没有注册信息，让 SDK 重新注册。用预注册 `clientId` 时需要固定 `callbackPort`。

### 5.2 运行时（serve）

- provider 从存储读 token，SDK 每个请求带 `Authorization: Bearer`。
- 上游返回 401 时 SDK 用 refresh token 刷新并存盘；`invalid_grant` 时 SDK 清掉 token。
- 需要浏览器交互（无 token、refresh 失败）时，serve 模式下的 provider **不打开浏览器**，而是把账号标成 `needs_login` 并抛错。启动阶段：这个账号不参与工具集，其他账号照常；全部账号都不可用才退出。调用阶段：对这个账号的调用返回 `isError` 结果，文本写明 `run: mcp-mux login <config> <account>`。
- 不可用的账号（需要登录、启动失败、上游进程崩溃或连接断开）在**下一次被调用时重连一次**；重连成功且工具集与基准一致就恢复使用，否则继续返回错误。所以在客户端运行期间执行 `mcp-mux login`，或修好崩溃的上游，都不需要重启客户端。同一账号的并发调用只触发一次重连。

### 5.3 自检（`mcp-mux status <config>`）

按 serve 的方式逐个连接每个账号并 `tools/list`，打印每个账号是 `ok (N tools)`、`needs login; run: ...` 还是连接错误；有任何账号不可用就以 1 退出。不会打开浏览器。用于第一次配置后、注册到客户端之前确认配置可用。

### 5.4 token 存储

两种后端，接口相同：`get(key)`、`set(key, value)`、`delete(key)`，value 是一个 JSON（`tokens`、`clientInformation`、`discoveryState`）。

- **keychain**（macOS 默认）：调用系统 `security` 命令，service 固定为 `mcp-mux`，account 为 `<name>/<account>`。写入走 `security -i` 从 stdin 读命令，**密钥不出现在进程参数里**；值先 base64 再存，避免转义问题。可以用 `store.keychain` 指定另一个钥匙串文件（测试和演示就是这么做的，不碰用户的登录钥匙串）。
- **file**（其他平台默认）：一个 JSON 文件，每个键的值单独用 AES-256-GCM 加密（随机 12 字节 IV，键名作 AAD，防止把 A 账号的密文挪到 B 账号下）。密钥来自环境变量 `MCP_MUX_STORE_KEY`（base64 的 32 字节），没设就报错，不自动生成、不回退明文。文件权限 0600，写入先写临时文件再 rename。

不做 Linux Secret Service / Windows Credential Manager，用 file 后端覆盖；有需求再加。

## 6. 错误处理

原则：出错就明确报错，绝不悄悄用别的账号或返回空结果。

| 情况 | 行为 |
|---|---|
| 配置不合法、`${VAR}` 未设置、账号工具集不一致、上游已有 `account` 参数 | 启动时报错退出（exit 1），stderr 写原因 |
| 某账号启动时连不上 / 需要登录 | stderr 告警并标记该账号不可用；全部不可用则退出 |
| 上游进程退出 / 连接断开 | 标记不可用，下次调用该账号时重连；重连后工具集变了则拒绝并报错 |
| 调用缺 `account` 或值不在 enum | JSON-RPC `InvalidParams`，消息列出可选账号 |
| 调用不可用账号 | `isError: true` 的工具结果，写明原因和 `mcp-mux login` 命令 |
| 上游调用抛错 | 转成 `isError: true` 结果，消息前缀 `[account <name>]`，不吞掉原始信息 |
| 上游返回 `isError` | 原样透传 |
| 文件存储解密失败（密钥错或被篡改） | 报错，不当作"没有 token" |
| 回调 `state` 不符、`iss` 不符、AS 返回 `error` | 登录失败退出，不换 token |

日志只写 stderr（stdout 是 JSON-RPC 通道），不打印 token、code、client secret。

## 7. 在客户端里配置

两边都只需要一个 stdio server 条目：

Claude Code：

```sh
claude mcp add notion -- bunx mcp-mux serve /abs/path/notion.mux.json
```

或项目里的 `.mcp.json`：

```json
{ "mcpServers": { "notion": { "command": "bunx", "args": ["mcp-mux", "serve", "/abs/path/notion.mux.json"] } } }
```

Codex：

```sh
codex mcp add notion -- bunx mcp-mux serve /abs/path/notion.mux.json
```

或 `~/.codex/config.toml`：

```toml
[mcp_servers.notion]
command = "bunx"
args = ["mcp-mux", "serve", "/abs/path/notion.mux.json"]
```

OAuth 账号先在终端里登录一次：`bunx mcp-mux login notion.mux.json work`。stdio 账号的密钥用客户端配置里的 `env` 传给 mcp-mux，再由 `${VAR}` 分发到各账号。

## 8. 扩展点：不可逆动作审批（只设计接口，v0.1 不实现）

动机：#20500 要求"发邮件、发 Slack、改日历前确认账号"；需求调研里另一个选题（MCP 不可逆动作闸门）也可以挂在这里，而不是另起一个代理。

接口（代码里只保留类型和一个调用点，默认不挂任何实现）：

```ts
export interface CallContext {
  account: string;                   // 已校验过的账号名
  tool: string;                      // 上游工具名
  args: Record<string, unknown>;     // 去掉 account 之后、即将转发的参数
  annotations?: ToolAnnotations;     // 上游声明的 readOnlyHint / destructiveHint 等
}

export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

export type BeforeCall = (ctx: CallContext) => Promise<ApprovalDecision>;
```

- 调用点：账号校验通过之后、转发上游之前。`allow: false` 时返回 `isError` 结果，文本为 `denied: <reason>`，上游不会收到请求。
- 以后的实现可以按 `annotations.destructiveHint`、工具名规则或账号（比如家人的账号一律只读）决定是否需要人工确认，再通过 MCP elicitation、系统通知或 ntfy 拿到批准。超时视为拒绝。
- 配置入口暂不设计；等第一个实现落地时再定 `approval` 字段，避免现在就定一个用不上的格式。

## 9. v0.2 候选

按调研里的呼声排序，均不在 v0.1：

1. 按账号限制工具（`accounts.<name>.tools` 白名单，实现"家人账号只读"）。届时 `account` 的 enum 按工具分别计算。
2. 上游 `notifications/tools/list_changed` 透传与重新校验。
3. resources / prompts 代理。
4. serve 模式下对 `needs_login` 账号按需拉起浏览器登录。
5. SDK 支持 2026-07-28 后升级。
