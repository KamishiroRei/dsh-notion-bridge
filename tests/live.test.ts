/** Real-Loader acceptance against the installed local plugin; no fake Agent or model results. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'

const origin = process.env.DSH_NOTION_TEST_URL ?? 'http://127.0.0.1:18748'
const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string() })
const toolValue = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })), isError: z.boolean().optional() })
const receiptSchema = z.object({ taskId: z.uuid(), sessionId: z.string().optional(), status: z.string(), output: z.string(), tools: z.array(z.string()), toolResults: z.array(z.object({ isError: z.boolean(), text: z.string() })), persisted: z.boolean(), error: z.object({ code: z.string(), message: z.string() }).optional() })

function payload(value: unknown): unknown {
  const result = toolValue.parse(value)
  const text = result.content.find(item => item.type === 'text')?.text
  assert.ok(text)
  return JSON.parse(text)
}

test('installed MCP authorizes, reads, writes, runs commands, deduplicates, reuses its Agent, and revokes', { timeout: 180000 }, async () => {
  const unauthorized = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(unauthorized.status, 401)
  assert.match(unauthorized.headers.get('www-authenticate') ?? '', /resource_metadata/)
  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()
  const issuer = new URL(z.object({ issuer: z.url() }).parse(metadata).issuer).origin
  const resource = `${issuer}/mcp`
  const rejected = await fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://example.com/callback'], token_endpoint_auth_method: 'none' }) })
  assert.equal(rejected.status, 400)
  const registered = await fetch(`${origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'DSH local acceptance', redirect_uris: ['https://www.notion.so/dsh-local-test-callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })
  const registeredBody: unknown = await registered.json()
  assert.equal(registered.status, 201, JSON.stringify(registeredBody))
  const client = z.object({ client_id: z.string() }).parse(registeredBody)
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomUUID()
  const authorize = new URL(`${origin}/authorize`)
  authorize.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://www.notion.so/dsh-local-test-callback', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, state, resource }).toString()
  const pending = await fetch(authorize, { redirect: 'manual' })
  assert.equal(pending.status, 302)
  const localConsent = pending.headers.get('location')
  assert.ok(localConsent?.startsWith(`${origin}/consent?`))
  const consentId = new URL(localConsent).searchParams.get('request')
  assert.ok(consentId)
  const forwarded = await fetch(localConsent, { headers: { 'x-forwarded-for': '192.0.2.9' } })
  assert.equal(forwarded.status, 403)
  const page = await (await fetch(localConsent)).text()
  const nonce = page.match(/name="nonce" value="([^"]+)"/)?.[1]
  assert.ok(nonce)
  const forbidden = await fetch(`${origin}/consent`, { method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request: consentId, nonce }), redirect: 'manual' })
  assert.equal(forbidden.status, 403)
  const approved = await fetch(`${origin}/consent`, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request: consentId, nonce }), redirect: 'manual' })
  assert.equal(approved.status, 302)
  const callback = new URL(approved.headers.get('location') ?? '')
  assert.equal(callback.searchParams.get('state'), state)
  const code = callback.searchParams.get('code')
  assert.ok(code)
  const exchange = async (codeVerifier: string) => fetch(`${origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: 'https://www.notion.so/dsh-local-test-callback', code_verifier: codeVerifier, code, resource }) })
  assert.equal((await exchange(randomBytes(32).toString('base64url'))).status, 400)
  const issued = await exchange(verifier)
  assert.equal(issued.status, 200)
  const tokens = tokenSchema.parse(await issued.json())
  assert.equal((await exchange(verifier)).status, 400)
  const mcp = new Client({ name: 'dsh-notion-local-acceptance', version: '1.0.0' })
  const ownedTaskIds = new Set<string>()
  const revoke = () => fetch(`${origin}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, token: tokens.access_token }) })
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }))
    const tools = await mcp.listTools()
    assert.deepEqual(tools.tools.map(item => item.name).sort(), ['dsh_status', 'dsh_task_cancel', 'dsh_task_result', 'dsh_task_submit', 'dsh_tool_describe', 'dsh_tool_execute', 'dsh_tools_list'])
    const status = z.object({ workspaces: z.record(z.string(), z.string()) }).parse(payload(await mcp.callTool({ name: 'dsh_status', arguments: {} })))
    assert.ok(status.workspaces.harness)
    const invalid = toolValue.parse(await mcp.callTool({ name: 'dsh_task_submit', arguments: { requestId: randomUUID(), workspace: 'missing', prompt: 'must not execute' } }))
    assert.equal(invalid.isError, true)
    assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(payload(invalid)).error.code, 'unknown-workspace')
    const nativeTools = z.object({ tools: z.array(z.string()) }).parse(payload(await mcp.callTool({ name: 'dsh_tools_list', arguments: { workspace: 'harness' } })))
    assert.ok(nativeTools.tools.includes('read'))
    const description = z.object({ name: z.literal('read'), parameters: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(payload(await mcp.callTool({ name: 'dsh_tool_describe', arguments: { workspace: 'harness', name: 'read' } })))
    const fileParameter = ['filePath', 'file_path', 'path'].find(name => name in description.parameters.properties)
    assert.ok(fileParameter, 'The current read tool must declare its file path parameter.')
    const request = { requestId: randomUUID(), workspace: 'harness', tool: 'read', arguments: { [fileParameter]: `${status.workspaces.harness}/package.json`, offset: 1, limit: 8 } }
    const submitted = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_tool_execute', arguments: request })))
    ownedTaskIds.add(submitted.taskId)
    const duplicate = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_tool_execute', arguments: request })))
    assert.equal(duplicate.taskId, submitted.taskId)
    const conflicting = toolValue.parse(await mcp.callTool({ name: 'dsh_tool_execute', arguments: { ...request, arguments: { ...request.arguments, limit: 9 } } }))
    assert.equal(conflicting.isError, true)
    async function settle(taskId: string) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const receipt = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_task_result', arguments: { taskId, waitMs: 25000 } })))
        if (receipt.status !== 'running') return receipt
      }
      throw new Error('Agent did not settle within the acceptance window.')
    }
    const completed = await settle(submitted.taskId)
    assert.equal(completed.status, 'completed', JSON.stringify(completed.error))
    assert.equal(completed.persisted, true)
    assert.ok(completed.tools.length > 0, 'The Agent must actually use a local tool.')
    assert.match(completed.output, /@deepseek-ai\/dsh-root/)
    console.log(JSON.stringify({ stage: 'real-local-read', taskId: completed.taskId, status: completed.status, sessionId: completed.sessionId, tools: completed.tools, persisted: completed.persisted }))
    const continuation = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_tool_execute', arguments: { ...request, requestId: randomUUID(), arguments: { ...request.arguments, offset: 2, limit: 2 } } })))
    ownedTaskIds.add(continuation.taskId)
    const resumed = await settle(continuation.taskId)
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.error))
    assert.equal(resumed.sessionId, completed.sessionId)
    assert.match(resumed.output, /@deepseek-ai\/dsh-root/)
    console.log(JSON.stringify({ stage: 'scoped-agent-reuse', taskId: resumed.taskId, sessionId: resumed.sessionId, persisted: resumed.persisted }))
    const fixturePath = join(status.workspaces.harness, `.notion-mcp-acceptance-${randomUUID()}.txt`)
    const fixture = await open(fixturePath, 'wx')
    await fixture.close()
    try {
      const observed = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_tool_execute', arguments: { requestId: randomUUID(), workspace: 'harness', tool: 'read', arguments: { [fileParameter]: fixturePath } } })))
      ownedTaskIds.add(observed.taskId)
      assert.equal((await settle(observed.taskId)).status, 'completed')
      const written = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_tool_execute', arguments: { requestId: randomUUID(), workspace: 'harness', tool: 'write', arguments: { file_path: fixturePath, content: 'DSH_NOTION_NATIVE_WRITE_OK\n' } } })))
      ownedTaskIds.add(written.taskId)
      const writeReceipt = await settle(written.taskId)
      assert.equal(writeReceipt.status, 'completed', JSON.stringify(writeReceipt.error))
      assert.equal(await readFile(fixturePath, 'utf8'), 'DSH_NOTION_NATIVE_WRITE_OK\n')
      console.log(JSON.stringify({ stage: 'real-local-write', taskId: written.taskId, tools: writeReceipt.tools, persisted: writeReceipt.persisted }))
    } finally {
      for (const taskId of ownedTaskIds) await mcp.callTool({ name: 'dsh_task_cancel', arguments: { taskId } })
      await unlink(fixturePath)
    }
    const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash'
    assert.ok(nativeTools.tools.includes(shellTool))
    const shellDescription = z.object({ parameters: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(payload(await mcp.callTool({ name: 'dsh_tool_describe', arguments: { workspace: 'harness', name: shellTool } })))
    assert.ok('command' in shellDescription.parameters.properties)
    const command = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_tool_execute', arguments: { requestId: randomUUID(), workspace: 'harness', tool: shellTool, arguments: { description: 'Verify native command execution through DSH', command: 'node -e "console.log(\'DSH_NOTION_NATIVE_COMMAND_OK\')"' } } })))
    ownedTaskIds.add(command.taskId)
    const commandReceipt = await settle(command.taskId)
    assert.equal(commandReceipt.status, 'completed', JSON.stringify(commandReceipt.error))
    assert.match(commandReceipt.output, /DSH_NOTION_NATIVE_COMMAND_OK/)
    console.log(JSON.stringify({ stage: 'real-local-command', taskId: command.taskId, tools: commandReceipt.tools, persisted: commandReceipt.persisted }))
    const cancelled = receiptSchema.parse(payload(await mcp.callTool({ name: 'dsh_task_cancel', arguments: { taskId: completed.taskId } })))
    assert.equal(cancelled.status, 'completed')
    const refresh = (token: string) => fetch(`${origin}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token, resource }) })
    const rotation = await refresh(tokens.refresh_token)
    assert.equal(rotation.status, 200)
    const rotated = tokenSchema.parse(await rotation.json())
    assert.notEqual(rotated.refresh_token, tokens.refresh_token)
    assert.equal((await refresh(tokens.refresh_token)).status, 400)
    ownedTaskIds.clear()
    await revoke()
    const revoked = await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(revoked.status, 401)
    assert.equal((await refresh(rotated.refresh_token)).status, 400)
  } finally {
    for (const taskId of ownedTaskIds) {
      await mcp.callTool({ name: 'dsh_task_cancel', arguments: { taskId } }).catch(error => console.error('Acceptance task cleanup failed:', error instanceof Error ? error.message : error))
    }
    await mcp.close()
    await revoke()
  }
})
