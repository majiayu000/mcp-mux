# mcp-mux 调研

调研日期 2026-10-22。issue 数据用 `gh api` 当天拉取（全部评论逐条读完），MCP 规范读的是 modelcontextprotocol.io 上的 `latest`（即 2026-07-28 版），竞品星数为当天 `gh api repos/<repo>` 实查。

## 1. 需求：5 个 issue 读下来的结论

| issue | 👍 | 评论 | 状态 | 核心诉求 |
|---|---|---|---|---|
| [anthropics/claude-code#27302](https://github.com/anthropics/claude-code/issues/27302) | 422 | 277 | open | 同一 connector 挂多个账号（Gmail、GitHub、Notion、Slack、Linear……） |
| [anthropics/claude-code#44243](https://github.com/anthropics/claude-code/issues/44243) | 118 | 46 | open | 内置 Slack connector 同时连多个 workspace |
| [openai/codex#20500](https://github.com/openai/codex/issues/20500) | 116 | 31 | open | 每个 app/connector 支持多个具名账号，硬隐私边界 |
| [anthropics/claude-ai-mcp#178](https://github.com/anthropics/claude-ai-mcp/issues/178) | 37 | 24 | open | 同 URL 不能加第二个自定义 connector |
| [anthropics/claude-ai-mcp#10](https://github.com/anthropics/claude-ai-mcp/issues/10) | 104 | 63 | open | 自定义 connector 支持自定义 header |

合计 797 👍（比 10 月初的 793 又涨了 4）。

### 1.1 具体场景（按出现频率）

1. **多个 Gmail / Google Workspace**：最高频。个人 + 工作 + 副业 + 志愿组织，常见 3–4 个，有人 10 个邮箱（6 个 Gmail + 4 个 Microsoft）。典型任务是"会前准备要搜全部往来邮件"、"plan my day 只看到一个日历"。
2. **咨询 / 外包 / fractional 角色**：自己公司一个 Slack，每个客户一个 Slack/Drive/Notion/monday.com。有人 30 个客户在 monday.com，要求客户之间严格隔离。
3. **多个 Notion / Linear / Airtable workspace**：Notion 被点名次数仅次于 Gmail。
4. **同一 SaaS 多个租户**：Salesforce 多 org（并购后）、Zoho CRM 一个区域 URL 下 7 个客户账号、Xero 两个法人实体、QuickBooks 多公司、Stripe A/B 账号、Datadog 两个账号、eToro 多组合、M365 多 Entra tenant。共同点是**服务端 URL 相同，只靠 OAuth 身份区分**。
5. **家庭代管**：替家人处理保险、银行、税务邮件，账号属于别人，希望**对家人的账号只读**。
6. **定时任务 / routine**：无人值守的 routine 会用"当前恰好连着的那个账号"，个人 inbox 的任务跑到了组织 inbox 上。

### 1.2 用户期望的交互方式

评论里反复出现、彼此一致的几条：

- **账号写在工具调用里**：`account` / `instanceId` 参数，"the account named in every tool call"（#27302 多人、#44243 luisocallaghan、#20500 正文）。ProxyLoom 创始人也说他们就是"every tool takes an `account` argument"。
- **出错要报错，不能静默返回空结果**：两位用户都描述过"搜错了邮箱，返回一个看起来像'没有这封邮件'的空结果，差点据此行动"。#20500 要求 "fail closed instead of falling back to another account"。
- **每个账号有标签**：Personal / Work / Client A，最好能看到真实身份（邮箱、workspace 名）。
- **每个账号独立断开 / 刷新**，互不影响。
- **OAuth 时能锁定账号**：#44243 fedekau 的长评论指出 Slack 授权页允许选任意 workspace，容易点错；提议 `authorizeParams`，如 Slack `team`、Google `login_hint`/`hd`/`prompt=select_account`、GitHub `login`、Microsoft `tenant`。
- **按账号缩小权限**：家人账号只读；Airtable 一个 OAuth 身份授权全部 workspace，"blast radius" 太大。
- **副作用动作要确认账号**：发邮件、发 Slack、改日历前要明确是哪个账号（#20500 隐私与安全一节）。
- **按项目绑定默认账号**：多人提到"工作项目用工作账号"，Codex 评论里提到希望在 `config.toml` 里按路径绑定。

### 1.3 现有绕路方案及其问题

| 绕路 | 出处 | 问题 |
|---|---|---|
| URL 末尾加 `?` 或 `?team=x` 骗过去重 | #27302、#44243、#178 多人 | 依赖未文档化的去重逻辑；Google 已在 2026-05 封掉（非官方 URL 直接 404，已建的连接也坏了）；Zoho 对未知参数返回 400 |
| Claude Code 里 `claude mcp add` 第二个同 URL server | #27302 ChiefCrazybull | `/mcp` 显示 "hidden — same URL as your server"，只能留一个 |
| 插件里写两个同 URL 的 server | #44243 fedekau | "skipped — same command/URL as server provided by plugin" |
| `CLAUDE_CONFIG_DIR` 分目录、shell alias | #27302 多人 | 只是切换，不能在一次对话里同时用两个账号 |
| Composio / ProxyLoom / Bellatrix / Lumman 等托管服务 | 多人推荐 | 要把银行、公司邮箱的长期访问权交给第三方中间人；有人明确说"don't drive us into the jungle of trustless hosted mcp connectors" |
| 自己写本地 MCP（multi-gmail-mcp 等） | 多人 | 每个服务各写一个，OAuth 要自己搭 |

### 1.4 官方动态

- **ChatGPT 2026-08-28 上线了 Google 系（Gmail/Calendar/Contacts）多账号**，带标签和 "Connect another account"，但只限这几个一方 connector；Codex #20500 仍 open，`@Gmail` 时还没有账号选择器。
- claude.ai 2026-10-18 在 #10 下回复：自定义 connector 可以发固定请求头（beta，限部分组织），但**同 URL 去重（#178）和多账号（#27302）都没有动**。
- Anthropic 在 #27302 下没有任何官方回复。

### 1.5 对 mcp-mux 的取舍

- 覆盖：Claude Code、Codex、Claude Desktop 这类能起本地 stdio 进程的客户端。claude.ai 网页、手机端、云端 routine 只能连远端 URL，**本地代理覆盖不到**，README 要写清楚。
- 必须做：`account` 必填参数、未知账号直接报错、按账号 OAuth、`authorizeParams` 锁定账号、凭据按账号隔离、单个账号登出不影响其他。
- 留扩展点：副作用动作审批（只设计接口）。
- 暂不做：按项目默认账号（客户端自己的事）、跨账号聚合搜索、按账号只读（v0.2 候选，见 design.md）。

## 2. MCP 规范要点

### 2.1 版本现状

- 最新规范是 **2026-07-28**。和 2025-11-25 相比有破坏性变化：去掉了 `initialize` 握手和协议级会话（`Mcp-Session-Id`），Streamable HTTP 去掉了 GET 流，服务端发起的请求改成结果里的 `InputRequiredResult`（MRTR），每个 POST 必须带 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 头。
- **但官方 TypeScript SDK 还没跟上**：v1 最新 1.32.1、v2 拆包（`@modelcontextprotocol/client` 等）最新 2.3.1，`LATEST_PROTOCOL_VERSION` 都还是 `2025-11-25`。
- 规范允许客户端先发新式请求、遇到 400 再回退到 `initialize`。目前生态里的服务端绝大多数仍是 initialize 时代，所以 mcp-mux v0.1 用 SDK 1.32.1、按 2025-11-25 说话；只支持 2026-07-28 的上游会连不上，需要等 SDK 升级（已列入风险）。

### 2.2 stdio 传输

- 客户端拉起子进程，stdin/stdout 上是换行分隔的 JSON-RPC；**stdout 只能写 MCP 消息**，日志写 stderr。
- 授权：stdio 实现 **SHOULD NOT** 走 OAuth 规范，"retrieve credentials from the environment"。所以 stdio 上游的"账号"就是不同的环境变量 / 参数 / 目录。

### 2.3 Streamable HTTP 传输

- 单一 MCP 端点，客户端每条消息一个 POST，`Accept` 同时列 `application/json` 和 `text/event-stream`，响应可能是 JSON 或 SSE。
- 安全：服务端必须校验 `Origin` 防 DNS rebinding；本地运行应只绑 127.0.0.1。mcp-mux 的 OAuth 回调服务器同样只绑 127.0.0.1。
- 2025-11-25 及之前有 `Mcp-Session-Id`；mcp-mux 每个账号持有自己的 transport，会话天然按账号隔离。

### 2.4 Authorization（OAuth 2.1）

客户端侧必须做的（mcp-mux 对上游就是 OAuth 客户端）：

1. 无 token 请求得 401 → 从 `WWW-Authenticate` 的 `resource_metadata` 拿 Protected Resource Metadata（RFC 9728）；没有就按 `/.well-known/oauth-protected-resource/<path>`、再根路径的顺序探测。
2. 从 PRM 的 `authorization_servers` 选 AS，按顺序试 RFC 8414 和 OIDC Discovery 的 well-known 地址；**元数据里的 `issuer` 必须和用来拼 URL 的 issuer 完全一致**，否则丢弃。
3. 客户端注册优先级：预注册 > Client ID Metadata Document（AS 声明 `client_id_metadata_document_supported`）> DCR（RFC 7591，**已标为 deprecated**，仅向后兼容）> 让用户手填。DCR 时 CLI 类应用用 `application_type: "native"`。客户端凭据必须按 AS 的 issuer 绑定，AS 变了不能复用。
4. 授权码 + **PKCE S256**；授权请求和 token 请求都必须带 `resource`（RFC 8707，MCP server 的规范 URI）。
5. Scope：优先用 401 里 `WWW-Authenticate` 的 `scope`，否则用 PRM 的 `scopes_supported`。运行时 403 `insufficient_scope` 走 step-up，新 scope = 旧 scope ∪ 挑战 scope，重试次数要有上限。
6. 授权响应校验 RFC 9207 `iss`：AS 声明支持却没带 `iss` 要拒绝；带了就必须和记录的 issuer 字符串完全相等。
7. token 只能放 `Authorization: Bearer`，不能进 URL；**不能把别的 AS 发的 token 透传给 MCP server**。
8. refresh token 要保密存储；不能假设一定会发 refresh token。

SDK 1.32.1 的 `auth()` + `OAuthClientProvider` 已覆盖 1–5、7 的大部分（发现、DCR/CIMD、PKCE、resource、按 issuer 绑定客户端信息、401 时自动刷新、`invalid_grant` 时清 token）。**第 6 条（`iss` 校验）SDK 没做**，mcp-mux 在本地回调里自己校验。

对 mcp-mux 的直接含义：**OAuth 状态（客户端注册信息、token、发现缓存、PKCE verifier）全部按账号各存一份**。同一个上游 URL 的两个账号，就是同一个 OAuth 客户端流程跑两遍、存在两个键下。

## 3. 竞品

### 3.1 检索方法

GitHub 仓库搜索按星数排序，关键词拆成 4 组：

- 多账号：`mcp multi account`、`mcp multiple accounts`、`mcp multi-account proxy`、`mcp account switch`、`mcp multiauth`、`mcp multi tenant`、`mcp workspace multiple`
- OAuth 代理：`mcp oauth proxy`
- 网关 / 代理：`mcp gateway`、`mcp-proxy`
- 聚合 / 复用：`mcp aggregator`、`mcp multiplexer`

再加上 issue 评论里被推荐的托管服务，以及已知的 `geelen/mcp-remote`。对重点项目读了 README。

### 3.2 功能矩阵

图例：✅ 支持　◐ 部分　✗ 不支持

| 项目 | ★ | 形态 | 同一 server 挂 N 个账号 | 单一工具集 + `account` 参数 | 上游 OAuth 登录 | 按账号锁定 OAuth 身份 | 凭据加密 / 钥匙串 | stdio 上游 | HTTP 上游 | 本地、无需部署 |
|---|---|---|---|---|---|---|---|---|---|---|
| **mcp-mux（本项目）** | — | 本地 stdio 代理 | ✅ | ✅ | ✅ 发现 + DCR/CIMD + PKCE + 刷新 | ✅ `authorizeParams` | ✅ 钥匙串 / AES-GCM 文件 | ✅ | ✅ | ✅ |
| TuchSoft/mcp-multiauth | 0 | 本地 stdio 代理（Py + Node） | ✅ | ✅ | ✗（只有 header/env/file 模板） | ✗ | ✗（明文或环境变量） | ✅ | ✅ 含 SSE | ✅ |
| geelen/mcp-remote | 1640 | 本地 stdio↔远端桥 | ◐ 起多个实例，`--resource` 隔离会话 | ✗ 每个实例一套重复工具 | ✅ | ✅ `--authorize-param` | ✗ 存在 `~/.mcp-auth` 目录，README 未提加密 | ✗ | ✅ | ✅ |
| sparfenyuk/mcp-proxy | 2799 | stdio↔HTTP 传输桥 | ✗ | ✗ | ◐ client_credentials | ✗ | ✗ | ✅ | ✅ | ✅ |
| docker/mcp-gateway | 1612 | Docker 网关 | ✗ | ✗ | ✅ | ✗ | ◐ Docker secrets | ✅ 容器 | ✅ | 需 Docker |
| metatool-ai/metamcp | 2718 | 聚合 + 网关（docker） | ✗ | ✗（按 namespace 合并多个 server） | ◐ 2025-03-26 版 | ✗ | ◐ | ✅ | ✅ | 需部署 |
| samanhappy/mcphub | 2568 | 自托管网关 | ◐ 多**用户**各绑凭据，非一人多账号 | ✗ | ✅ | ✗ | ✅ AES-256-GCM | ✅ | ✅ | 需部署 |
| IBM/mcp-context-forge | 4675 | 企业网关 | ✗ | ✗ | ◐ | ✗ | ✅ | ✅ | ✅ | 需部署 |
| agentgateway/agentgateway | 5471 | 企业代理 | ✗ | ✗ | ◐ | ✗ | — | ✅ | ✅ | 需部署 |
| microsoft/mcp-gateway | 890 | K8s 网关 | ✗ | ✗ | ✗ | ✗ | — | — | ✅ | 需 K8s |
| domdomegg/mcp-aggregator | 12 | 远端聚合，一次登录 | ◐ 多**用户** | ✗（按上游加前缀） | ✅ 含 DCR | ✗ | ◐ 内存 / SQLite | ✗ | ✅ | 需部署 |
| obot-platform/mmmcp | 7 | 多路复用 | ✗ | ✗（`prefix__tool`） | ✗（README 自述 OAuth 传递有问题） | ✗ | ✗ | ✅ | ✅ | ✅ |
| hyprmcp/mcp-gateway | 92 | 给 server 加 OAuth 的网关 | ✗ | ✗ | 服务端方向 | ✗ | — | ✗ | ✅ | 需部署 |
| elzinko/google-mcp-multi-account | 0 | 单服务多账号（Google） | ✅ 仅 Google | ✅ alias | ✅ 仅 Google | ✅ 邮箱锁定 | ✅ Keychain 主密钥 + AES-GCM | — | — | ✅ |
| gx-55/multi-gmail-mcp 等单服务实现 | 个位数–百 | 单服务多账号 | ✅ 仅该服务 | 各异 | 自带 | 各异 | 各异 | — | — | ✅ |
| Composio / ProxyLoom / Bellatrix One / Lumman Multi Mail | 商业 | 托管 | ✅ | ProxyLoom ✅ | ✅ | 不详 | 托管方持有 | — | — | ✗ 第三方托管 |

### 3.3 结论

- **通用 + OAuth + 本地** 这一格仍然空着。mcp-multiauth 是唯一同形态的，但没有 OAuth 登录、凭据不加密，3 天前才建；mcp-remote 能做按实例隔离 OAuth，但每个账号是一套重复工具，模型要从两套同名工具里自己挑，凭据落在 `~/.mcp-auth`（README 未提加密），也接不了 stdio 上游。
- 各家网关解决的是"一个组织、多个 server、多个用户"，不是"一个人、同一个 server、多个账号"。
- 单服务的多账号实现（Gmail、Google、Plex、Instagram……）证明需求真实，但每个都只覆盖一个服务。
- 托管服务能用，但用户在评论里明确表达了不想把邮箱和银行的长期访问权交给中间人。本地运行 + 钥匙串是 mcp-mux 对这类用户的卖点。

### 3.4 风险

- 官方原生支持：ChatGPT 已经对 Google 系上线多账号；Anthropic 一侧没有表态。mcp-mux 的价值在"任意 MCP server"和"Claude Code + Codex 同一套配置"，官方即使做了 Gmail 也覆盖不到 Notion、Linear、Salesforce、自建 server。
- SDK 还不支持 2026-07-28，只支持新版的上游暂时连不上。
- 很多远端 MCP 不开放 DCR、也不支持 CIMD（Slack 就需要自建 app + 预注册 client_id），这时需要用户自带 `clientId`，配置门槛不低。
- 本地代理覆盖不到 claude.ai 网页、手机端、云端 routine，而这部分正是 #27302 里声量很大的人群。
