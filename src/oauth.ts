/** Single-owner OAuth provider; protocol handlers and PKCE verification belong to the MCP SDK. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Response } from 'express'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidTargetError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js'
import { z } from 'zod'
import { BridgeError } from './config.js'

const grantSchema = z.object({ clientId: z.string(), expiresAt: z.number(), resource: z.string() })
const stateSchema = z.object({
  clients: z.record(z.string(), z.unknown()),
  access: z.record(z.string(), grantSchema),
  refresh: z.record(z.string(), grantSchema),
})
type State = z.infer<typeof stateSchema>
type Pending = { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number; nonce: string }
const key = credentialKey('dsh-notion-bridge', 'oauth')
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const secret = (): string => randomBytes(32).toString('base64url')
const now = (): number => Math.floor(Date.now() / 1000)
const scope = 'dsh:tasks'

/** OAuth clients and grants persist through the Harness credential provider; pending consent expires locally. */
export class NotionOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore
  private readonly pending = new Map<string, Pending>()
  private readonly codes = new Map<string, Pending>()
  readonly resource: string

  /** @param ctx Credential owner. @param origin Public HTTPS origin. @param localOrigin Loopback consent origin. */
  constructor(private readonly ctx: Context, readonly origin: string, readonly localOrigin: string) {
    this.resource = `${origin}/mcp`
    this.clientsStore = {
      getClient: async id => {
        const value = (await this.read()).clients[id]
        return value === undefined ? undefined : OAuthClientInformationFullSchema.parse(value)
      },
      registerClient: async client => {
        for (const uri of client.redirect_uris) {
          const url = new URL(uri)
          if (url.protocol !== 'https:' || url.username || url.password || url.hash
            || !['notion.com', 'notion.so'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
            throw new InvalidClientMetadataError('Only HTTPS Notion callback URLs can register.')
          }
        }
        const value = { ...client, client_id: randomUUID(), client_id_issued_at: now() }
        await this.update(state => {
          if (Object.keys(state.clients).length >= 32) throw new InvalidClientMetadataError('Client limit reached; remove old connection records locally.')
          // SDK client metadata can carry present-but-undefined optional fields; credential payloads are JSON.
          state.clients[value.client_id] = OAuthClientInformationFullSchema.parse(JSON.parse(JSON.stringify(value)))
        })
        return value
      },
    }
  }

  private async read(): Promise<State> {
    const record = await this.ctx.credentials.readRecord(key)
    if (record === undefined) return { clients: {}, access: {}, refresh: {} }
    if (record.kind !== 'grant') throw new Error('Notion OAuth credential is not a grant record.')
    return stateSchema.parse(record.payload)
  }

  private async update(mutate: (state: State) => void): Promise<void> {
    await this.ctx.credentials.modifyRecord(key, async current => {
      if (current !== undefined && current.kind !== 'grant') throw new Error('Notion OAuth credential is not a grant record.')
      const state = current === undefined ? { clients: {}, access: {}, refresh: {} } : stateSchema.parse(current.payload)
      for (const group of [state.access, state.refresh]) {
        for (const [id, item] of Object.entries(group)) if (item.expiresAt <= now()) delete group[id]
      }
      mutate(state)
      return { kind: 'grant', payload: state }
    })
  }

  /** @inheritdoc */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: Response): Promise<void> {
    if (params.resource !== undefined && params.resource.href !== this.resource) throw new InvalidTargetError('Token resource must be this MCP endpoint.')
    if (params.scopes?.some(item => item !== scope)) throw new InvalidScopeError(`Only ${scope} is available.`)
    for (const [id, item] of this.pending) if (item.expiresAt <= now()) this.pending.delete(id)
    for (const [id, item] of this.codes) if (item.expiresAt <= now()) this.codes.delete(id)
    if (this.pending.size >= 16) throw new BridgeError('consent-busy', 'Too many pending authorization requests.')
    const id = secret()
    this.pending.set(id, { client, params, expiresAt: now() + 300, nonce: secret() })
    response.redirect(`${this.localOrigin}/consent?request=${encodeURIComponent(id)}`)
  }

  /** Read one pending request for the loopback-only consent page. @param id Request identity. @returns Client name and CSRF nonce. */
  consent(id: string): { clientName: string; nonce: string } {
    const item = this.pending.get(id)
    if (item === undefined || item.expiresAt <= now()) throw new BridgeError('consent-expired', 'Authorization expired; reconnect in Notion.')
    return { clientName: item.client.client_name ?? 'Notion', nonce: item.nonce }
  }

  /** Grant a locally confirmed request once. @param id Request identity. @param nonce Local-page CSRF nonce. @returns Registered callback URL. */
  approve(id: string, nonce: string): string {
    const item = this.pending.get(id)
    if (item === undefined || item.expiresAt <= now() || nonce !== item.nonce) throw new BridgeError('consent-expired', 'Authorization expired; reconnect in Notion.')
    this.pending.delete(id)
    const code = secret()
    this.codes.set(hash(code), { ...item, expiresAt: now() + 90 })
    const callback = new URL(item.params.redirectUri)
    callback.searchParams.set('code', code)
    if (item.params.state !== undefined) callback.searchParams.set('state', item.params.state)
    return callback.href
  }

  private code(clientId: string, code: string): Pending {
    const item = this.codes.get(hash(code))
    if (item === undefined || item.client.client_id !== clientId || item.expiresAt <= now()) throw new InvalidGrantError('Code expired or was consumed; reconnect in Notion.')
    return item
  }

  /** @inheritdoc */
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.code(client.client_id, code).params.codeChallenge
  }

  private async issue(clientId: string, consumeRefresh?: string): Promise<OAuthTokens> {
    const access = secret()
    const refresh = secret()
    await this.update(state => {
      if (consumeRefresh !== undefined) {
        const old = state.refresh[hash(consumeRefresh)]
        if (old === undefined || old.clientId !== clientId || old.resource !== this.resource) throw new InvalidGrantError('Refresh token expired or consumed; reconnect in Notion.')
        delete state.refresh[hash(consumeRefresh)]
      }
      state.access[hash(access)] = { clientId, resource: this.resource, expiresAt: now() + 3600 }
      state.refresh[hash(refresh)] = { clientId, resource: this.resource, expiresAt: now() + 2592000 }
    })
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope }
  }

  /** @inheritdoc */
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const item = this.code(client.client_id, code)
    if (redirectUri !== undefined && redirectUri !== item.params.redirectUri) throw new InvalidGrantError('Callback does not match.')
    if (resource !== undefined && resource.href !== this.resource) throw new InvalidTargetError('Resource does not match.')
    this.codes.delete(hash(code))
    return this.issue(client.client_id)
  }

  /** @inheritdoc */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    if (scopes?.some(item => item !== scope)) throw new InvalidScopeError('Scope cannot be expanded.')
    if (resource !== undefined && resource.href !== this.resource) throw new InvalidTargetError('Resource does not match.')
    return this.issue(client.client_id, refresh)
  }

  /** @inheritdoc */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const item = (await this.read()).access[hash(token)]
    if (item === undefined || item.expiresAt <= now() || item.resource !== this.resource) throw new InvalidTokenError('Token expired or revoked; reconnect in Notion.')
    return { token, clientId: item.clientId, scopes: [scope], expiresAt: item.expiresAt, resource: new URL(this.resource) }
  }

  /** @inheritdoc */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.update(state => {
      const item = state.access[hash(request.token)] ?? state.refresh[hash(request.token)]
      if (item?.clientId !== client.client_id) return
      for (const group of [state.access, state.refresh]) {
        for (const [id, value] of Object.entries(group)) if (value.clientId === client.client_id) delete group[id]
      }
    })
  }
}
