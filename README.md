# Notion → DSH

让 Notion 网页 AI 通过鉴权 MCP 调用本机 DSH 原生工具。先安装并启动插件，再用 HTTPS 隧道提供 `/mcp`，在 Notion「设置 → 连接 → 新建 MCP 连接」里添加地址并完成本机同意页授权。连接成功后，先列工具、读工具参数，再执行并按任务 ID 取回结果。默认不需要再调用一个本地模型；可选的自主任务委派需要单独配置可用模型。下文给出安装、配置、工具和验证范围。

This local bundle lets Notion's web AI execute DeepSeek Harness's native tools on this computer. Notion AI chooses the tool and arguments; DSH applies its Agent preset, permissions, and tool middleware without making a second model request. Optional task delegation can ask a separately configured local model to handle a prompt. This is the opposite direction from `dsh-notion-oauth-ui`, which lets DSH call Notion.

The Loader mounts the plugin inside the existing Web profile. Agent creation, preset composition, permissions, and tool execution remain owned by DSH. Only tasks created by this connection are addressable through its MCP tools; the plugin never takes over unrelated Sessions or changes their Workspace membership.

## Install

Requires Node.js 22.19+ and DeepSeek Harness 0.2.1-rc.2. The local native-tool path is verified on Windows. This repository contains the original bridge implementation; SDK and Express dependencies remain separately licensed.

```powershell
git clone https://github.com/KamishiroRei/dsh-notion-bridge.git
cd dsh-notion-bridge
pnpm install
pnpm run build
dsh plugin --profile web add .
dsh web
```

Use `pnpm dsh` from a Harness source checkout in place of `dsh`. Keep the built plugin directory available after installation. Git installs build via the package prepare script; pnpm may require allowing this package build in the profile configuration before retrying installation. Cloning, building and installing the absolute local directory avoids relying on a remote prepare step. This plugin exposes tools through MCP; it does not add a client settings page.

## Deployment

Build with `pnpm run build`, then install this directory with `dsh plugin --profile web add <absolute-directory>`. Its `cordis.patch.yml` defaults to loopback port 18748, the launching process working directory as workspace `harness`, and a state directory under DSH_HOME or the current user home. Override the `dsh-notion-bridge` row in the profile patch to configure `publicUrl`, `port`, named `workspaces`, `permissionPreset`, optional Agent `preset`/`provider`/`model`, task/result limits, timeout, and `stateDirectory`.

`publicUrl` must be an HTTPS origin for cloud use; loopback HTTP is accepted for local verification. Publish only this plugin's loopback endpoint through a TLS gateway. The gateway's lifetime and stable hostname belong to that deployment. Changing the public origin invalidates previously issued grants for the old resource.

In Notion, open Settings → Connections → New MCP connection and enter `<publicUrl>/mcp`. The OAuth flow uses dynamic client registration and PKCE. Consent opens at `http://127.0.0.1:<port>/consent` on the computer running DSH, lists the configured working directories and permission preset, and requires a local approval. Callbacks are limited to HTTPS Notion domains. Grants persist through DSH credentials at `dsh-notion-bridge/oauth`; pending approvals and authorization codes expire in memory. The SDK implements protocol parsing, PKCE checks, and authorization endpoints. Access tokens expire after one hour; refresh tokens rotate and expire after thirty days. Revocation removes the client's active grants.

The bundled Windows gateway helper uses an official `cloudflared.exe` available on PATH (or supplied with `-Cloudflared`) and manages only its recorded process with matching executable, origin, and metrics arguments:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/gateway.ps1 -Action start
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/gateway.ps1 -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/gateway.ps1 -Action stop
```

`start` returns an account-free temporary HTTPS origin. Put that origin in the profile's `publicUrl` before connecting Notion. Keep the Web profile and gateway running. A gateway restart changes its hostname and requires updating the profile URL and reconnecting Notion. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) have no uptime guarantee and do not support SSE; this service uses JSON responses. Override `-Cloudflared` if the installed executable moves. State and logs have fixed filenames under `$DSH_HOME/dsh-notion-bridge`, defaulting to `~/.dsh/dsh-notion-bridge`. Use `-StateDirectory` when the plugin has a custom state directory.

## Tools

| Tool | Behavior |
| --- | --- |
| `dsh_status` | List configured working directories, permission preset, and retained tasks. |
| `dsh_tools_list` | List the tools available to the configured Agent in a named workspace. |
| `dsh_tool_describe` | Return a native tool's current description and exact JSON parameter schema. |
| `dsh_tool_execute` | Execute a native tool through DSH's tool runtime, without calling a local model. Return a task receipt immediately. |
| `dsh_task_submit` | Submit a prompt under a unique `requestId`, choose a configured workspace, optionally continue a finished `continueTaskId`, and immediately receive a task receipt. |
| `dsh_task_result` | Read an owned task; `waitMs` can wait up to thirty seconds. |
| `dsh_task_cancel` | Cancel an owned task and wait for its Agent to settle. Earlier file changes and external actions remain committed. |

Use `dsh_status` → `dsh_tools_list` → `dsh_tool_describe` → `dsh_tool_execute` → `dsh_task_result` for direct work. Supply the native tool's actual parameter names rather than guessing. Keep reading the task receipt until it settles. Direct execution reuses one plugin-owned Agent per workspace and admits one task at a time in each workspace.

A repeated `requestId` with identical input returns its existing task while that receipt is retained. Reusing the identity with changed input fails. The retained receipt count and concurrent task count are bounded by configuration. Receipts, direct tool arguments, and tool results live in `tasks.json`. Agent setup persists in the normal DSH Session store; delegated model conversations also use its normal turn and tool event history. A host restart marks unfinished receipts as interrupted; it never silently replays their work. A completed receipt means the execution settled; check actual tool output and perform the task's verification before treating its work as accepted. Receipt or Session persistence failures are visible as failures.

`dsh_task_submit` additionally requires a working DSH model provider with available quota. Direct native-tool execution does not require that provider. The local verification found insufficient balance on the configured official provider and an upstream rejection on the existing free-model route; neither route is verified for delegated work.

## Access and limitations

Named workspaces select the working directory; DSH's permission preset and each installed tool determine what the Agent can do. This plugin does not add a process sandbox around every third-party plugin. Tool results and file content returned by the Agent are transmitted to the connected Notion account. Consent applies to that connection's task API and the configured DSH capabilities.

Loopback status and consent routes reject forwarded requests. Consent POSTs require the local Origin and a per-request nonce. All MCP requests require an unexpired resource-bound bearer token. The transport uses stateless JSON replies so long-running work is represented by task identities instead of a long-lived HTTP stream. Task receipts and tool output are capped; a result exceeding the configured serialized character limit returns a marked preview. OAuth grants have one local owner and are shared by that connection; this bundle is not a multi-user hosting service.

Stopping or unloading the plugin stops admission, cancels and drains its owned Agents, closes HTTP connections, and settles receipt writes. Unrelated DSH Sessions remain owned by their existing callers.

## Development status

The repository includes the source, a deployment patch, a Windows gateway helper, and a live integration test. Keep account authorization and local deployment records outside Git.

The existing `@chushixixin/dsh-harness-mcp-server` project was inspected as prior art for task submission and structured results: <https://github.com/chushixixin/dsh-harness-mcp-server>. This implementation uses the current Harness APIs and the official MCP SDK directly.

## Verification

`pnpm run build` checks the TypeScript sources. `pnpm test` connects to the installed running service on loopback port 18748 and exercises OAuth, native read/write/command execution, duplicate requests, and revocation. It creates temporary test files and removes them, and requires a configured workspace named `harness`. This is an integration test against a real deployment, not an offline unit test. Local acceptance does not confirm that Notion AI has completed its own OAuth connection or invoked a tool; that external-account step remains deployment-specific.

MIT License.
