/**
 * Host half of the test-account plugin.
 *
 * It is a metadata registry plus a Remote surface: it owns `accounts.json` and
 * the per-account storageState files, remembers which account each Session is
 * using, and drives the current Session's Playwright MCP storage tools on
 * request. It starts no browser and stores no credentials.
 *
 * The operations themselves live in {@link AccountService}; this module only
 * resolves configuration, builds the collaborators, and publishes the two faces
 * (the `/api/test-account` route and the optional Agent tools).
 * @module @songxiyuan/test-account
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import { AccountStore, AccountStoreError } from './account-store.ts'
import { AccountService } from './accounts.ts'
import { registerAgentTools } from './agent-tools.ts'
import { BrowserStorageBridge, BrowserStorageError } from './browser-storage.ts'
import {
  Endpoint,
  TEST_ACCOUNT_ROUTE,
  type AccountInput,
  type AccountPatch,
  type RemoteResult,
} from './types.ts'

/** Cordis identity for the account plugin. */
export const name = 'test-account'

/**
 * Services required before either face can be published.
 *
 * `webServer` is load-bearing: the route rides the Connection `/api` prefix that
 * only exists while a Web server does, and the plugin must wait for that.
 */
export const inject = ['connection', 'tools', 'agents', 'webServer']

/** Provider configuration as declared in a profile patch row. */
export interface Config {
  /** Account-store directory; defaults to `<DSH_HOME>/test-accounts`. */
  root?: string
  /** Browser provider name backing the `mcp__<provider>__` tool namespace. */
  mcpProvider?: string
  /** `direct` writes account paths straight through; `staged` round-trips the workspace. */
  stateAccess?: 'direct' | 'staged'
  /** File-name prefix for the temporary workspace copy used by staged mode. */
  stagePrefix?: string
  /** Upper bound on one browser storage tool call, in milliseconds. */
  toolTimeoutMs?: number
  /** Whether to publish `account_list` / `account_use` / `account_current` to Agents. */
  agentTools?: boolean
}

/** Loader defaults and validation for the account plugin configuration. */
export const Config = Schema.object({
  root: Schema.string(),
  mcpProvider: Schema.string(),
  stateAccess: Schema.union([Schema.const('direct'), Schema.const('staged')]),
  stagePrefix: Schema.string(),
  toolTimeoutMs: Schema.number().min(1),
  agentTools: Schema.boolean(),
})

/** Configuration with this plugin's defaults applied. */
export interface ResolvedConfig {
  root: string
  mcpProvider: string
  stateAccess: 'direct' | 'staged'
  stagePrefix: string
  toolTimeoutMs: number
  agentTools: boolean
}

/**
 * Default account-store directory, following the DSH home convention.
 * @returns the absolute directory path.
 */
export function defaultRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'test-accounts')
}

/**
 * Apply this plugin's defaults over the loader-resolved configuration.
 * @param input - raw profile configuration.
 * @returns the complete configuration.
 */
export function resolveConfig(input: Config = {}): ResolvedConfig {
  return {
    root: input.root ?? defaultRoot(),
    mcpProvider: input.mcpProvider ?? 'playwright-mcp',
    stateAccess: input.stateAccess ?? 'direct',
    stagePrefix: input.stagePrefix ?? '.dsh-test-account-storage-',
    toolTimeoutMs: input.toolTimeoutMs ?? 120_000,
    agentTools: input.agentTools ?? true,
  }
}

/** One Remote success envelope. */
function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One Remote failure envelope. */
function fail(code: string, message: string, details: object = {}): RemoteResult<never> {
  return { ok: false, error: { code, message, details } }
}

/**
 * Read a stable error code off a thrown value.
 * @param error - thrown value.
 * @returns the plugin code, or `internal`.
 */
function codeOf(error: unknown): string {
  if (error instanceof AccountStoreError || error instanceof BrowserStorageError) return error.code
  return 'internal'
}

/**
 * Read a message off a thrown value.
 * @param error - thrown value.
 * @returns the human-readable message.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Narrow a Remote payload to an object.
 * @param payload - decoded payload.
 * @returns the payload as a plain record.
 */
function asObject(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

/**
 * Read a required non-empty string field.
 * @param payload - decoded payload.
 * @param field - field name.
 * @returns the field value.
 */
function requireField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AccountStoreError('invalid-payload', `缺少字段 ${field}`)
  }
  return value
}

/**
 * Read an optional string-list field.
 * @param value - raw field value.
 * @returns the strings, or `undefined` when the field is absent.
 */
function optionalTags(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : undefined
}

/**
 * Host body of the account plugin.
 * @param ctx - plugin context supplying Connection, tools, and Agents.
 * @param input - profile configuration.
 */
export function apply(ctx: Context, input: Config = {}): void {
  const config = resolveConfig(input)
  const log = ctx.logger('test-account')
  const service = new AccountService({
    store: new AccountStore(config.root),
    bridge: new BrowserStorageBridge(ctx, {
      provider: config.mcpProvider,
      stateAccess: config.stateAccess,
      stagePrefix: config.stagePrefix,
      toolTimeoutMs: config.toolTimeoutMs,
    }),
    agents: ctx.agents,
    log,
  })

  /**
   * Dispatch one Remote endpoint.
   * @param endpoint - route-relative endpoint name.
   * @param payload - decoded payload.
   * @param signal - caller cancellation.
   * @returns the endpoint result.
   */
  async function handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RemoteResult<unknown>> {
    try {
      const fields = asObject(payload)
      switch (endpoint) {
        case Endpoint.list:
          return ok(await service.list(typeof fields.sessionId === 'string' ? fields.sessionId : undefined))
        case Endpoint.current:
          return ok(service.current(requireField(fields, 'sessionId')))
        case Endpoint.create: {
          const raw = asObject(fields.input)
          const createInput: AccountInput = { id: requireField(raw, 'id'), name: requireField(raw, 'name') }
          if (typeof raw.site === 'string') createInput.site = raw.site
          const tags = optionalTags(raw.tags)
          if (tags !== undefined) createInput.tags = tags
          return ok(await service.create(createInput))
        }
        case Endpoint.update: {
          const raw = asObject(fields.patch)
          const patch: AccountPatch = {}
          if (typeof raw.name === 'string') patch.name = raw.name
          if (raw.site === null) patch.site = null
          else if (typeof raw.site === 'string') patch.site = raw.site
          if (raw.tags === null) patch.tags = null
          else {
            const tags = optionalTags(raw.tags)
            if (tags !== undefined) patch.tags = tags
          }
          return ok(await service.update(requireField(fields, 'id'), patch))
        }
        case Endpoint.delete:
          return ok(await service.remove(requireField(fields, 'id')))
        case Endpoint.saveState:
          return ok(await service.saveState(requireField(fields, 'sessionId'), requireField(fields, 'id'), signal))
        case Endpoint.use:
          return ok(await service.use(requireField(fields, 'sessionId'), requireField(fields, 'id'), signal))
        default:
          return fail('unknown-endpoint', `未知端点：${endpoint}`)
      }
    } catch (error) {
      log.warn('endpoint %s failed: %s', endpoint, messageOf(error))
      return fail(codeOf(error), messageOf(error))
    }
  }

  /**
   * Serve the plugin's endpoints on the authenticated `/api` channel.
   * @param request - already trust-checked and authenticated request.
   * @returns the endpoint result as JSON.
   */
  async function route(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json(fail('invalid-json', '请求体不是合法 JSON'), { status: 400 })
    }
    const fields = asObject(body)
    const endpoint = typeof fields.endpoint === 'string' ? fields.endpoint : ''
    if (endpoint === '') return Response.json(fail('invalid-payload', '缺少 endpoint'), { status: 400 })
    return Response.json(await handle(endpoint, fields.payload, request.signal))
  }

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: TEST_ACCOUNT_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: route,
      }),
    'test-account: remote route',
  )

  if (config.agentTools) registerAgentTools(ctx, service)

  log.info(
    'account store rooted at %s (provider %s, state access %s, agent tools %s)',
    service.root,
    config.mcpProvider,
    config.stateAccess,
    config.agentTools ? 'on' : 'off',
  )
}
