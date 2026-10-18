/** Authenticated Notion MCP ingress for plugin-owned Harness tasks. */
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { BridgeError, configSchema } from './config.js'
import type { Config } from './config.js'
import { NotionOAuth } from './oauth.js'
import { NotionTasks, submitSchema, taskIdSchema, toolRequestSchema } from './tasks.js'

/** Loader identity. */
export const name = 'dsh-notion-bridge'
/** Services used before the endpoint begins accepting requests. */
export const inject = ['agents', 'agentPresets', 'sessions', 'credentials', 'permissionPresets', 'tools']
export type { Config } from './config.js'

function html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character))
}

function localRequest(request: Request, localOrigin: string): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
    && request.headers.host === new URL(localOrigin).host
    && request.headers['cf-connecting-ip'] === undefined && request.headers['x-forwarded-for'] === undefined
}

/** Start one instance through the Loader; disposal stops its HTTP endpoint and owned tasks. @param ctx Harness context. @param rawConfig Deployment settings. */
export async function apply(ctx: Context, rawConfig: Config): Promise<void> {
  const config = configSchema.parse(rawConfig)
  const origin = new URL(config.publicUrl).origin
  const localOrigin = `http://127.0.0.1:${config.port}`
  const tasks = new NotionTasks(ctx, config)
  const oauth = new NotionOAuth(ctx, origin, localOrigin)
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  const server = createServer(app)
  const cleanups = new Set<Promise<void>>()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    const stopped = new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return }
      server.close(error => { if (error) reject(error); else resolve() })
    })
    await tasks.close()
    server.closeAllConnections()
    await stopped
    await Promise.allSettled([...cleanups])
  })()
  ctx.effect(() => close, 'dsh-notion-bridge.http-and-tasks')
  await tasks.initialize()

  function result(value: unknown, isError = false): CallToolResult {
    let text = JSON.stringify(value)
    if (text.length > config.maxResultChars) {
      let preview = text.slice(0, Math.floor(config.maxResultChars / 2))
      text = JSON.stringify({ truncated: true, preview })
      while (text.length > config.maxResultChars) {
        preview = preview.slice(0, Math.floor(preview.length / 2))
        text = JSON.stringify({ truncated: true, preview })
      }
    }
    return { content: [{ type: 'text', text }], ...isError ? { isError: true } : {} }
  }

  async function guarded(action: () => unknown | Promise<unknown>): Promise<CallToolResult> {
    try { return result(await action()) }
    catch (error) {
      if (error instanceof BridgeError) return result({ error: { code: error.code, message: error.message } }, true)
      ctx.logger.error('Notion MCP operation failed: %s', error)
      return result({ error: { code: 'host-operation-failed', message: 'Harness could not finish this operation. Inspect its local log and task state before retrying.' } }, true)
    }
  }

  function mcpServer(): McpServer {
    const mcp = new McpServer({ name: 'DSH Local Agent', version: '0.1.0' }, {
      instructions: 'Use dsh_status to select a configured workspace. For direct local computer actions, use dsh_tools_list, dsh_tool_describe, then dsh_tool_execute: you are the model, and DSH executes its native tools through its permission pipeline without a second model request. Use dsh_task_submit only when you want a separate local model to handle an autonomous task. Submit work with a unique requestId; reuse that same requestId only to recover an uncertain submission. Read dsh_task_result until work settles. A completed receipt is execution evidence, not independent verification. Only this connection\'s tasks can be read, continued or cancelled.',
    })
    mcp.registerTool('dsh_status', {
      title: 'Local DSH status', description: 'List configured local workspaces, the execution permission preset, and this connection\'s retained tasks.',
      inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
    }, () => guarded(() => tasks.status()))
    mcp.registerTool('dsh_tools_list', {
      title: 'List DSH native tools', description: 'List the native tools visible to the configured DSH Agent. No local model request is made. Describe a tool before executing it.',
      inputSchema: z.object({ workspace: z.string() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => guarded(() => tasks.toolNames(args.workspace)))
    mcp.registerTool('dsh_tool_describe', {
      title: 'Describe a DSH tool', description: 'Read the exact current description and JSON parameter schema for a native DSH tool. No local model request is made.',
      inputSchema: z.object({ workspace: z.string(), name: z.string() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => guarded(() => tasks.describeTool(args.workspace, args.name)))
    mcp.registerTool('dsh_tool_execute', {
      title: 'Execute a native DSH tool', description: 'Execute the named native tool with JSON arguments under the configured Agent preset and permission policy. No local model is called: Notion AI chooses the tool and arguments. Returns an asynchronous task receipt; read dsh_task_result for its actual output. Use a unique requestId for each intended action.',
      inputSchema: toolRequestSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, args => guarded(() => tasks.executeTool(args)))
    mcp.registerTool('dsh_task_submit', {
      title: 'Run a task on the local computer',
      description: 'Ask the local DSH Agent to work in a configured workspace. It can use the tools permitted by that workspace\'s DSH preset. Returns a taskId immediately; read dsh_task_result for output and actual tool receipts. Set continueTaskId to a finished task from this connection to continue its persisted Session. Repeating the same requestId and input returns the original task.',
      inputSchema: submitSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, args => guarded(() => tasks.submit(args)))
    mcp.registerTool('dsh_task_result', {
      title: 'Read local task result', description: 'Read an owned task\'s current or final receipt. waitMs can wait up to 30 seconds. Check status, errors, persisted, and actual tool output before reporting success.',
      inputSchema: z.object({ taskId: taskIdSchema, waitMs: z.number().int().min(0).max(30000).default(0) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, args => guarded(() => tasks.result(args.taskId, args.waitMs)))
    mcp.registerTool('dsh_task_cancel', {
      title: 'Stop a local task', description: 'Cancel this connection\'s task and return its settled receipt. Cancellation does not undo file changes or earlier external actions.',
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, args => guarded(() => tasks.cancel(args.taskId)))
    return mcp
  }

  app.use(mcpAuthRouter({ provider: oauth, issuerUrl: new URL(origin), resourceServerUrl: new URL(oauth.resource), scopesSupported: ['dsh:tasks'], resourceName: 'DSH Local Agent' }))
  app.get('/', (_request, response) => response.json({ service: 'DSH Local Agent', mcp: `${origin}/mcp`, authentication: 'OAuth 2.1 / PKCE' }))
  app.get('/local/status', (request, response) => {
    if (!localRequest(request, localOrigin)) { response.sendStatus(403); return }
    response.set('Cache-Control', 'no-store').json(tasks.status())
  })
  app.get('/consent', (request, response) => {
    if (!localRequest(request, localOrigin)) { response.status(403).send('Open the authorization page on the DSH computer.'); return }
    const id = z.string().parse(request.query.request)
    const consent = oauth.consent(id)
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" })
    response.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权 Notion 连接本机 DSH</title><style>body{font:16px/1.7 system-ui;background:#f4f5f7;color:#20252c;margin:0;padding:48px 20px}main{max-width:640px;margin:auto;background:white;padding:32px;border:1px solid #dfe3e8;border-radius:12px}h1{font-size:24px}li{overflow-wrap:anywhere}button{font:inherit;background:#1767d1;color:white;border:0;border-radius:6px;padding:10px 18px;cursor:pointer}small{color:#606975}</style><main><h1>连接 Notion 与本机 DSH</h1><p>请求方：<strong>${html(consent.clientName)}</strong></p><p>此连接可向以下工作区的 DSH Agent 下发任务、读取执行回执、取消和续接任务：</p><ul>${Object.entries(tasks.workspaces).map(([id, path]) => `<li><strong>${html(id)}</strong> · ${html(path)}</li>`).join('')}</ul><p>DSH 权限：<strong>${html(config.permissionPreset)}</strong>。Agent 可以使用该预设允许的本机工具；涉及的文件内容和执行结果会返回 Notion。</p><p><small>授权保存在本机 DSH 凭据存储中。关闭此页可取消；请求在五分钟后失效。</small></p><form method="post" action="/consent"><input type="hidden" name="request" value="${html(id)}"><input type="hidden" name="nonce" value="${html(consent.nonce)}"><button type="submit">授权此 Notion 连接</button></form></main></html>`)
  })
  app.post('/consent', express.urlencoded({ extended: false, limit: '8kb' }), (request, response) => {
    if (!localRequest(request, localOrigin) || request.headers.origin !== localOrigin) { response.sendStatus(403); return }
    const body = z.object({ request: z.string(), nonce: z.string() }).strict().parse(request.body)
    response.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).redirect(oauth.approve(body.request, body.nonce))
  })
  app.all('/mcp', requireBearerAuth({ verifier: oauth, requiredScopes: ['dsh:tasks'], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauth.resource)) }), async (request, response) => {
    const mcp = mcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => {
      const cleanup = (async () => { await transport.close(); await mcp.close() })()
      cleanups.add(cleanup)
      void cleanup.catch(error => ctx.logger.warn('Notion MCP transport cleanup failed: %s', error)).finally(() => cleanups.delete(cleanup))
    })
    await mcp.connect(transport)
    await transport.handleRequest(request, response)
  })
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    ctx.logger.error('Notion HTTP request failed: %s', error)
    if (!response.headersSent) response.status(error instanceof BridgeError || error instanceof z.ZodError ? 400 : 500).json({ error: error instanceof BridgeError ? error.message : 'Request failed; inspect the local DSH log.' })
    else response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  ctx.logger.info('Notion MCP ready on %s; public endpoint %s/mcp', localOrigin, origin)
}
