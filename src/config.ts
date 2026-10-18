/** Deployment settings for the Notion-to-Harness MCP connection. */
import { z } from 'zod'

/** Configuration accepted by the Loader; all paths name local deployment resources. */
export const configSchema = z.object({
  port: z.number().int().min(1).max(65535),
  publicUrl: z.url().refine(value => {
    const url = new URL(value)
    return (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))
      && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  }, 'Use an HTTPS origin, or the loopback HTTP origin during local testing.'),
  workspaces: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string().min(1)).refine(value => Object.keys(value).length > 0),
  permissionPreset: z.string().min(1),
  preset: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  maxTasks: z.number().int().min(1).max(1000),
  maxConcurrentTasks: z.number().int().min(1).max(16),
  maxResultChars: z.number().int().min(1024).max(1000000),
  taskTimeoutMs: z.number().int().min(1000).max(43200000),
  stateDirectory: z.string().min(1),
}).strict()

/** Validated configuration for one plugin instance. */
export type Config = z.infer<typeof configSchema>

/** Expected rejection before an operation is admitted, or an identified task failure. */
export class BridgeError extends Error {
  /** @param code Stable identity. @param message Actionable detail. */
  constructor(readonly code: string, message: string) { super(message) }
}
