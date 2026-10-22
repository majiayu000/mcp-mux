# mcp-mux 功能对比

核查日期 2026-10-22。星数和 issue 状态用 `gh api` 当天实查；官方现状来自 Claude Code 文档（code.claude.com/docs/en/mcp）、5 个 issue 的全部评论和 9to5Mac 2026-08-28 的报道。竞品功能按各自 README 和源码判断，未逐个安装实测。

## 1. 官方现状：问题解决了吗

| 渠道 | issue | 状态（2026-10-22） | 官方给了什么 | 还缺什么 |
|---|---|---|---|---|
| Claude（web / Desktop / Cowork / Code on the web） | [anthropics/claude-code#27302](https://github.com/anthropics/claude-code/issues/27302) | open，👍422，277 条评论，**无官方回复** | 无 | 同一 connector 只能连一个账号 |
| 内置 Slack connector | [anthropics/claude-code#44243](https://github.com/anthropics/claude-code/issues/44243) | open，👍118，46 条评论 | 无 | 只能连一个 workspace，OAuth 时无法锁定 workspace |
| claude.ai 自定义 connector | [anthropics/claude-ai-mcp#178](https://github.com/anthropics/claude-ai-mcp/issues/178) | open，👍37，24 条评论 | 无 | 同 URL 不能加第二个；URL 加 `?x` 的绕路在部分服务上能用，Google 已封 |
| claude.ai 自定义 header | [anthropics/claude-ai-mcp#10](https://github.com/anthropics/claude-ai-mcp/issues/10) | open，👍104，63 条评论 | 2026-10-18 官方回复：固定请求头 beta，限部分组织 | 多账号仍受同 URL 去重限制 |
| Codex / ChatGPT | [openai/codex#20500](https://github.com/openai/codex/issues/20500) | open，👍116，31 条评论 | 2026-08-28 起 Gmail、Google Calendar、Contacts 支持多账号（[9to5Mac](https://9to5mac.com/2026/08/28/chatgpt-and-codex-now-support-multiple-gmail-and-google-calendar-accounts/)） | 其他 connector 不支持；评论反映 `@Gmail` 时没有账号选择器 |
| Claude Code CLI（本地 MCP） | — | 文档现状 | 不同名字的 stdio server 可以并存；HTTP server 按 endpoint 去重，"a different path, query string … makes two servers"；OAuth 按 endpoint 存 | 两个账号就是两套同名工具；文档里没有授权参数（`login_hint`、`team`）配置，无法锁定登录身份 |

结论：Codex 只在 Google 一方 connector 上解决了，Claude 一侧没有任何官方方案。本地 CLI 能靠"加两个 server"凑合，但工具会重复，同 URL 的远端 server 也锁不住登录身份。

## 2. 逐项功能对比

图例：✅ 支持　◐ 部分支持　✗ 不支持　— 不适用

| 功能 | **mcp-mux** | [mcp-multiauth](https://github.com/TuchSoft/mcp-multiauth) | [mcp-remote](https://github.com/geelen/mcp-remote) | Claude Code 原生 | Codex 原生 | 自托管网关¹ |
|---|---|---|---|---|---|---|
| ★（2026-10-22） | 新项目 | 0（2026-10-19 创建） | 1641 | — | — | 1612–5481 |
| 同一 server 同时挂多个账号 | ✅ | ✅ | ◐ 每个账号起一个实例 | ◐ 每个账号加一个 server | ◐ 仅 Gmail / Calendar / Contacts | ✗ 面向多用户，不是一人多账号 |
| 一套工具 + 必填 `account` 参数 | ✅ | ✅ | ✗ 工具重复 N 份 | ✗ 工具重复 N 份 | ✗ | ✗ |
| 账号标签给模型看（邮箱 / workspace） | ✅ `description` | ✗ | ✗ | ✗ | ✅ 账号标签 | ✗ |
| 未知账号报错、不回退 | ✅ | ◐ 可设 `defaultAccount` 回退 | — | — | ✗ 评论反映不能指定账号 | — |
| stdio 上游 | ✅ | ✅ | ✗ | ✅ | ✅ | ✅ |
| Streamable HTTP 上游 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 旧版 HTTP+SSE 上游 | ✗ | ✅ | ✅ | ✅ | ✗ | ◐ |
| 上游 OAuth 按账号登录 | ✅ 发现 + DCR / CIMD + PKCE | ✗ 只有 header / env / file 模板 | ✅ | ◐ 按 endpoint 一份 | ◐ 仅 Google | ✅ |
| 登录时锁定身份（`login_hint` / Slack `team`） | ✅ `authorizeParams` | ✗ | ✅ `--authorize-param` | ✗ 文档未提供 | ✗ | ✗ |
| token 自动刷新 | ✅ | — | ✅ | ✅ | ✅ | ✅ |
| RFC 9207 `iss` 校验 | ✅ | — | 未提及 | 未提及 | 未知 | 未知 |
| 凭据存储 | macOS 钥匙串 / AES-256-GCM 文件 | 环境变量 / 文件明文 | `~/.mcp-auth`，README 未提加密 | macOS 钥匙串或凭据文件 | 云端 | ◐ mcphub AES-256-GCM |
| stdio 账号之间环境变量隔离 | ✅ 只继承安全默认集 | 未提及 | — | — | — | — |
| 上游崩溃后恢复 | ✅ 下次调用时重连 | ✅ 指数退避重连 | 未提及 | 未核实 | 未核实 | 未核实 |
| 客户端运行中补登录无需重启 | ✅ | — | 未核实 | ◐ `/mcp` 里重新认证 | 未核实 | — |
| 空闲断开 / 懒连接 | ✗ | ✅ | ✗ | — | — | ◐ |
| 一条命令自检所有账号 | ✅ `mcp-mux status` | ✗ | ◐ `mcp-remote-client` 测单个 | ◐ `claude mcp list` | ◐ `codex mcp list`（不连接） | ◐ 管理界面 |
| resources / prompts 代理 | ✗ 仅 tools | ✗ 仅 tools | ✅ 透明桥接 | — | — | ✅ |
| 副作用动作审批 | ◐ 仅预留接口 | ✗ | ✗ | ◐ 工具权限确认 | ◐ 审批模式 | ◐ 部分有策略引擎 |
| 是否需要部署 | 本地进程 | 本地进程 | 本地进程 | — | — | Docker / K8s / 服务器 |
| 运行时 | Bun | Python 或 Node | Node | — | — | 各异 |

¹ 自托管网关指 docker/mcp-gateway（★1612）、samanhappy/mcphub（★2572）、metatool-ai/metamcp（★2719）、IBM/mcp-context-forge（★4676）、agentgateway/agentgateway（★5481）、microsoft/mcp-gateway（★890）。它们解决"一个组织、多个 server、多个用户"，不解决"一个人、同一个 server、多个账号"。mcphub 的 per-user credentials 是每个**用户**绑定一份凭据。

托管服务（Composio、ProxyLoom、Bellatrix One、Lumman Multi Mail、Carly）能解决多账号，但要把邮箱等账号的长期访问权交给第三方。#27302 里有用户明确表示不愿意这样做。

## 3. 差距与取舍

- **mcp-mux 独有的组合**：一套工具 + `account` 参数，加上按账号 OAuth 并锁定身份，加上钥匙串存储。mcp-multiauth 有前一项、没有后两项；mcp-remote 有后两项中的 OAuth 和锁定，但工具会重复，凭据也没加密。
- **本次补上的缺口**（第一次用就会遇到）：
  - 账号标签：模型能看到 `work (me@corp.com)`，而不只是 `work`。
  - `status` 改成真实连接自检：之前只看有没有存 token。
  - 自动重连：上游崩溃不再永久失效；客户端运行中执行 `mcp-mux login` 后，下一次调用直接生效。
- **故意不做**：
  - `defaultAccount` 回退：与"选错账号要报错"的需求相反。
  - 不可逆动作审批：只保留接口。
- **已知落后项，留到后续版本**：
  - 旧版 HTTP+SSE 上游：已被规范标为 deprecated。
  - resources / prompts 代理。
  - 空闲断开。
  - 按账号限制工具：用于"家人账号只读"的场景。
