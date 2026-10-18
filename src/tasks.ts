/** Plugin-owned tasks use the real Harness Agent factory and durable Session log. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { BridgeError, type Config } from './config.js'

/** A plugin-owned task identity; arbitrary Harness sessions are never accepted. */
export const taskIdSchema = z.uuid().brand<'NotionTaskId'>()
type TaskId = z.infer<typeof taskIdSchema>
/** Client-supplied idempotency identity for one submission. */
export const submitSchema = z.object({
  requestId: z.string().min(1).max(200).brand<'NotionRequestId'>(),
  workspace: z.string().min(1).max(100),
  prompt: z.string().min(1).max(32000),
  continueTaskId: taskIdSchema.optional(),
}).strict()
/** Direct tool requests use Harness execution policies without a local model request. */
export const toolRequestSchema = z.object({
  requestId: submitSchema.shape.requestId,
  workspace: submitSchema.shape.workspace,
  tool: z.string().min(1).max(200),
  arguments: z.json(),
}).strict()
type ToolRequest = z.infer<typeof toolRequestSchema>
const internalRequestSchema = submitSchema.extend({ toolCall: toolRequestSchema.pick({ tool: true, arguments: true }).optional() })
type InternalSubmission = z.infer<typeof internalRequestSchema>
const taskSchema = internalRequestSchema.extend({
  taskId: taskIdSchema,
  sessionId: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  output: z.string(),
  tools: z.array(z.string()),
  toolResults: z.array(z.object({ isError: z.boolean(), text: z.string() })),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  persisted: z.boolean(),
  value: z.json().optional(),
  contexts: z.array(z.string()).optional(),
})
type Task = z.infer<typeof taskSchema>
type Running = { controller: AbortController; handle?: AgentHandle; done: Promise<void>; timedOut: boolean; shared?: boolean }

/** Owns admission, task receipts, Agent handles, and quiescent teardown for one connection. */
export class NotionTasks {
  private readonly tasks = new Map<TaskId, Task>()
  private readonly running = new Map<TaskId, Running>()
  private readonly bySession = new Map<SessionId, Task>()
  private readonly directAgents = new Map<string, Promise<AgentHandle>>()
  readonly workspaces: Record<string, string> = {}
  private closing = false
  private writes: Promise<void> = Promise.resolve()
  private readonly statePath: string

  /** @param ctx Harness services. @param config Validated deployment configuration. */
  constructor(private readonly ctx: Context, readonly config: Config) {
    this.statePath = join(config.stateDirectory, 'tasks.json')
  }

  /** Validate local directories, restore receipts, and subscribe to committed Session events. */
  async initialize(): Promise<void> {
    this.ctx.permissionPresets.resolve(this.config.permissionPreset)
    for (const [id, path] of Object.entries(this.config.workspaces)) {
      if (!isAbsolute(path)) throw new Error(`Workspace ${id} must use an absolute path.`)
      this.workspaces[id] = await realpath(path)
    }
    let stored: unknown = []
    try { stored = JSON.parse(await readFile(this.statePath, 'utf8')) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    for (const item of z.array(taskSchema).parse(stored)) {
      if (item.status === 'running') {
        item.status = 'interrupted'
        item.error = { code: 'process-restarted', message: 'The host stopped before a final receipt; inspect this Session before continuing.' }
      }
      this.tasks.set(item.taskId, item)
    }
    await this.save()
    this.ctx.on('session/event', (session, event) => {
      const task = this.bySession.get(session.id)
      if (task !== undefined) this.observe(task, event)
    })
  }

  private save(): Promise<void> {
    const data = JSON.stringify([...this.tasks.values()], null, 2) + '\n'
    const next = this.writes.then(async () => {
      await mkdir(this.config.stateDirectory, { recursive: true })
      const temporary = `${this.statePath}.tmp`
      await writeFile(temporary, data, 'utf8')
      await rename(temporary, this.statePath)
    })
    this.writes = next
    return next
  }

  private observe(task: Task, event: SessionEvent): void {
    switch (event.type) {
      case 'assistant/message': {
        const text = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (text) task.output = text.slice(0, this.config.maxResultChars)
        break
      }
      case 'tool/call':
        if (task.tools.length < 100) task.tools.push(event.data.name)
        break
      case 'tool/result': {
        const text = event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        if (task.toolResults.length < 20) task.toolResults.push({ isError: event.data.message.isError === true, text: text.slice(0, 1200) })
        break
      }
      case 'turn/end':
        if (event.data.reason.kind !== 'completed') {
          const reason = event.data.reason
          task.error = { code: reason.kind, message: reason.kind === 'error' ? reason.error.message : `Turn ended: ${reason.kind}.` }
        }
        break
      default:
        // Other merge-extensible Session events remain owned by Harness and its log.
        break
    }
  }

  /** Admit a unique request or return its existing receipt. @param request Validated remote submission. @returns Task identity and current state. */
  async submit(request: InternalSubmission): Promise<ReturnType<NotionTasks['view']>> {
    if (this.closing) throw new BridgeError('host-closing', 'Harness is shutting down; retry after it restarts.')
    const existing = [...this.tasks.values()].find(item => item.requestId === request.requestId)
    if (existing !== undefined) {
      if (existing.workspace !== request.workspace || existing.prompt !== request.prompt || existing.continueTaskId !== request.continueTaskId || !isDeepStrictEqual(existing.toolCall, request.toolCall)) {
        throw new BridgeError('request-conflict', 'This requestId names different work; use a new requestId.')
      }
      return this.view(existing)
    }
    if (this.workspaces[request.workspace] === undefined) throw new BridgeError('unknown-workspace', 'Choose a workspace returned by dsh_status.')
    if (this.running.size >= this.config.maxConcurrentTasks) throw new BridgeError('busy', 'The task limit is reached; wait for a running task or cancel it.')
    if ([...this.tasks.values()].some(item => item.workspace === request.workspace && item.status === 'running')) {
      throw new BridgeError('workspace-busy', 'This workspace already has running work; wait for its result or cancel that task.')
    }
    const prior = request.continueTaskId === undefined ? undefined : this.find(request.continueTaskId)
    if (prior !== undefined && (prior.workspace !== request.workspace || prior.sessionId === undefined || prior.status === 'running')) {
      throw new BridgeError('cannot-continue', 'Continue a finished task in its original workspace.')
    }
    if (prior?.sessionId !== undefined && [...this.tasks.values()].some(item => item.sessionId === prior.sessionId && item.status === 'running')) {
      throw new BridgeError('session-busy', 'This Session already has running work; wait for its result.')
    }
    while (this.tasks.size >= this.config.maxTasks) {
      const removable = [...this.tasks.values()].find(item => item.status !== 'running' && item.taskId !== prior?.taskId)
      if (removable === undefined) throw new BridgeError('receipt-limit', 'All retained task slots are active; wait for one to finish.')
      this.tasks.delete(removable.taskId)
    }
    const task: Task = { ...request, taskId: taskIdSchema.parse(randomUUID()), status: 'running', output: '', tools: [], toolResults: [], createdAt: new Date().toISOString(), persisted: false }
    this.tasks.set(task.taskId, task)
    const execution: Running = { controller: new AbortController(), done: Promise.resolve(), timedOut: false }
    this.running.set(task.taskId, execution)
    try { await this.save() }
    catch (error) { this.running.delete(task.taskId); this.tasks.delete(task.taskId); throw error }
    execution.done = this.run(task, execution, prior?.sessionId)
    return this.view(task)
  }

  private async run(task: Task, execution: Running, resumeId?: string): Promise<void> {
    const timeout = setTimeout(() => {
      execution.timedOut = true
      execution.controller.abort()
      execution.handle?.agent.cancel({ kind: 'hook', reason: 'Notion task time limit reached' })
    }, this.config.taskTimeoutMs)
    try {
      if (task.toolCall !== undefined) {
        const handle = await this.directAgent(task.workspace)
        execution.handle = handle
        execution.shared = true
        task.sessionId = handle.agent.id
        await this.save()
        const request = task.toolCall
        task.tools.push(request.tool)
        const outcome = await handle.agent.runMaintenance(async signal => this.ctx.agents.withInitiator(handle.agent, () => this.ctx.tools.execute({
          callId: ToolCallId(task.taskId), agent: handle.agent, name: request.tool,
          arguments: request.arguments, signal: AbortSignal.any([signal, execution.controller.signal]),
        })))
        task.output = outcome.content.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, this.config.maxResultChars)
        task.toolResults.push({ isError: outcome.isError, text: task.output.slice(0, 1200) })
        if (outcome.isError) {
          task.status = execution.controller.signal.aborted ? 'cancelled' : 'failed'
          task.error = { code: outcome.error.info?.code ?? 'tool-failed', message: outcome.error.message }
        } else {
          task.status = 'completed'
          task.value = outcome.value
        }
        task.contexts = outcome.additionalContexts?.map(message => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))
        task.persisted = await this.ctx.sessions.flush(handle.agent.session)
        if (execution.timedOut) { task.status = 'failed'; task.error = { code: 'timeout', message: 'Tool reached its time limit; inspect the receipt before retrying.' } }
        return
      }
      const agentOptions = { ...this.config.provider === undefined ? {} : { provider: this.config.provider }, ...this.config.model === undefined ? {} : { model: this.config.model } }
      const preset = this.config.preset ?? this.ctx.agentPresets.defaultId
      const setup = async (agentCtx: Context): Promise<void> => { await this.ctx.agentPresets.mount(agentCtx, preset) }
      const options = { agentOptions, setup, signal: execution.controller.signal }
      const handle = resumeId === undefined
        ? await this.ctx.agents.create({ ...options, sessionId: SessionId(randomUUID()), meta: { cwd: this.workspaces[task.workspace], agentPreset: preset } })
        : await this.ctx.agents.resume({ ...options, resumeSessionId: SessionId(resumeId) })
      execution.handle = handle
      task.sessionId = handle.agent.id
      this.ctx.permissionPresets.set(handle.agent.session, this.config.permissionPreset)
      this.bySession.set(handle.agent.id, task)
      await this.save()
      if (execution.controller.signal.aborted) throw new BridgeError('cancelled', 'Task cancelled before prompt admission.')
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: `[Notion MCP task ${task.taskId}]\n${task.prompt}` }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
      task.persisted = await this.ctx.sessions.flush(handle.agent.session)
      task.status = task.error === undefined ? 'completed' : task.error.code === 'aborted' ? 'cancelled' : 'failed'
      if (execution.timedOut) {
        task.status = 'failed'
        task.error = { code: 'timeout', message: 'Task reached its time limit; inspect the Session before continuing.' }
      }
    } catch (error) {
      task.status = execution.controller.signal.aborted ? 'cancelled' : 'failed'
      task.error = { code: error instanceof BridgeError ? error.code : 'execution-failed', message: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timeout)
      if (execution.handle !== undefined && !execution.shared) {
        this.bySession.delete(execution.handle.agent.id)
        try { await execution.handle.dispose() }
        catch (error) {
          task.status = 'failed'
          task.error = { code: 'cleanup-failed', message: error instanceof Error ? error.message : String(error) }
          this.ctx.logger.error('Notion task Agent teardown failed: %s', task.error.message)
        }
      }
      task.finishedAt = new Date().toISOString()
      this.running.delete(task.taskId)
      try { await this.save() }
      catch (error) {
        task.persisted = false
        task.status = 'failed'
        task.error = { code: 'receipt-write-failed', message: 'Task receipt could not be saved; inspect the Harness Session before retrying.' }
        this.ctx.logger.error('Notion task receipt write failed: %s', error)
      }
    }
  }

  private find(id: TaskId): Task {
    const value = this.tasks.get(id)
    if (value === undefined) throw new BridgeError('task-not-found', 'This connection does not own that task, or its receipt expired.')
    return value
  }

  private view(task: Task) {
    const { prompt: _prompt, requestId: _requestId, continueTaskId: _continueTaskId, toolCall: _toolCall, ...view } = task
    return view
  }

  /** Read or briefly wait for one task. @param id Plugin-owned identity. @param waitMs Maximum wait. @returns Current receipt. */
  async result(id: TaskId, waitMs: number) {
    const task = this.find(id)
    const active = this.running.get(id)
    if (active !== undefined && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([active.done, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs) })]) }
      finally { clearTimeout(timer) }
    }
    return this.view(task)
  }

  /** Stop an owned task and wait for its Agent to settle. @param id Plugin-owned identity. @returns Final receipt. */
  async cancel(id: TaskId) {
    const task = this.find(id)
    const active = this.running.get(id)
    if (active !== undefined) {
      active.controller.abort()
      active.handle?.agent.cancel({ kind: 'user' })
      await active.done
    }
    return this.view(task)
  }

  /** Safe connection inventory, restricted to this plugin's tasks. @returns Workspaces and retained task states. */
  status() {
    return { workspaces: this.workspaces, permissionPreset: this.config.permissionPreset, tasks: [...this.tasks.values()].map(item => ({ taskId: item.taskId, sessionId: item.sessionId, workspace: item.workspace, status: item.status })), running: this.running.size, directToolsUseLocalModel: false }
  }

  private async directAgent(workspace: string): Promise<AgentHandle> {
    if (this.closing) throw new BridgeError('host-closing', 'Harness is shutting down.')
    if (this.workspaces[workspace] === undefined) throw new BridgeError('unknown-workspace', 'Choose a workspace returned by dsh_status.')
    const existing = this.directAgents.get(workspace)
    if (existing !== undefined) return existing
    const preset = this.config.preset ?? this.ctx.agentPresets.defaultId
    const pending = this.ctx.agents.create({
      sessionId: SessionId(randomUUID()), meta: { cwd: this.workspaces[workspace], agentPreset: preset },
      setup: async agentCtx => { await this.ctx.agentPresets.mount(agentCtx, preset) },
    }).then(handle => { this.ctx.permissionPresets.set(handle.agent.session, this.config.permissionPreset); return handle })
    this.directAgents.set(workspace, pending)
    try { return await pending }
    catch (error) { if (this.directAgents.get(workspace) === pending) this.directAgents.delete(workspace); throw error }
  }

  /** List tool names from the Agent's actual scoped registry. @param workspace Configured directory key. @returns Visible native tool names. */
  async toolNames(workspace: string) {
    const handle = await this.directAgent(workspace)
    return { workspace, tools: this.ctx.tools.schemas(handle.agent).map(tool => tool.name).sort() }
  }

  /** Describe one currently visible native tool. @param workspace Configured directory key. @param name Native tool name. @returns Model-facing description and JSON parameters. */
  async describeTool(workspace: string, name: string) {
    const handle = await this.directAgent(workspace)
    const tool = this.ctx.tools.schemas(handle.agent).find(item => item.name === name)
    if (tool === undefined) throw new BridgeError('unknown-tool', 'The configured DSH Agent cannot see that tool.')
    return tool
  }

  /** Submit a native DSH tool call through the same task receipt mechanism. @param request Validated invocation. @returns Immediate receipt. */
  async executeTool(request: ToolRequest) {
    return this.submit({ requestId: request.requestId, workspace: request.workspace, prompt: `Execute DSH tool: ${request.tool}`, toolCall: { tool: request.tool, arguments: request.arguments } })
  }

  /** Stop admission, cancel owned work, drain its Agents, and finish receipt writes. */
  async close(): Promise<void> {
    this.closing = true
    const running = [...this.running.values()]
    for (const item of running) { item.controller.abort(); item.handle?.agent.cancel({ kind: 'disposed' }) }
    await Promise.allSettled(running.map(item => item.done))
    const handles = await Promise.allSettled([...this.directAgents.values()])
    const disposals = await Promise.allSettled(handles.filter((item): item is PromiseFulfilledResult<AgentHandle> => item.status === 'fulfilled').map(item => item.value.dispose()))
    this.directAgents.clear()
    await this.writes
    const failure = disposals.find(item => item.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
