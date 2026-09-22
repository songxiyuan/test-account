/**
 * Host half of the test-account plugin.
 *
 * It is a metadata registry plus a Remote surface: it owns `accounts.json` and
 * the per-account storageState files, remembers which account each Session is
 * using, and drives the current Session's Playwright MCP storage tools on
 * request. It starts no browser and stores no credentials.
 * @module @dsh-test-account/test-account
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AccountStore, AccountStoreError } from './account-store.ts'
import { BrowserStorageBridge, BrowserStorageError, type StorageFileAccess } from './browser-storage.ts'
import {
  Endpoint,
  TEST_ACCOUNT_ROUTE,
  type AccountInput,
  type AccountPatch,
  type AccountsSnapshot,
  type AccountView,
  type RemoteResult,
  type TestAccount,
} from './types.ts'

/** Cordis identity for the account plugin. */
export const name = 'test-account'

/**
 * Services required before the Remote route can be served.
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
}

/** Loader defaults and validation for the account plugin configuration. */
export const Config = Schema.object({
  root: Schema.string(),
  mcpProvider: Schema.string(),
  stateAccess: Schema.union([Schema.const('direct'), Schema.const('staged')]),
  stagePrefix: Schema.string(),
  toolTimeoutMs: Schema.number().min(1),
})

/** Configuration with this plugin's defaults applied. */
interface ResolvedConfig {
  root: string
  mcpProvider: string
  stateAccess: 'direct' | 'staged'
  stagePrefix: string
  toolTimeoutMs: number
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
 * Host body of the account plugin.
 * @param ctx - plugin context supplying Connection, tools, and Agents.
 * @param input - profile configuration.
 */
export function apply(ctx: Context, input: Config = {}): void {
  const config = resolveConfig(input)
  const store = new AccountStore(config.root)
  const bridge = new BrowserStorageBridge(ctx, {
    provider: config.mcpProvider,
    stateAccess: config.stateAccess,
    stagePrefix: config.stagePrefix,
    toolTimeoutMs: config.toolTimeoutMs,
  })
  const log = ctx.logger('test-account')
  /** Session id to account id, for the current process lifetime only. */
  const currentAccounts = new Map<string, string>()
  const agents = ctx.agents as AgentRegistry

  /**
   * Resolve the live Agent for one Session.
   * @param sessionId - Session id from the Remote payload.
   * @returns the live Agent.
   */
  function requireAgent(sessionId: string): Agent {
    const agent = agents.get(sessionId as SessionId)
    if (agent === undefined) {
      throw new BrowserStorageError('session-not-live', `Session ${sessionId} 当前不活跃，无法操作浏览器登录态`)
    }
    return agent
  }

  /**
   * Project one stored account onto the UI shape.
   * @param account - stored record.
   * @returns the account plus its measured state facts.
   */
  async function view(account: TestAccount): Promise<AccountView> {
    const info = await store.stateInfo(account)
    const projected: AccountView = { ...account, hasState: info.exists }
    if (info.bytes !== undefined) projected.stateBytes = info.bytes
    const updatedAt = info.updatedAt ?? account.updatedAt
    if (updatedAt !== undefined) projected.stateUpdatedAt = updatedAt
    return projected
  }

  /**
   * Build the panel snapshot for one Session.
   * @param sessionId - Session whose current account to report, when known.
   * @returns the snapshot.
   */
  async function snapshot(sessionId: string | undefined): Promise<AccountsSnapshot> {
    const accounts = await Promise.all((await store.list()).map(view))
    const result: AccountsSnapshot = { root: store.root, accounts }
    const current = sessionId === undefined ? undefined : currentAccounts.get(sessionId)
    if (current !== undefined) result.currentAccountId = current
    return result
  }

  /**
   * Wrap one account's storageState file for the browser bridge.
   * @param account - account whose file is read or written.
   * @returns the file access the bridge needs.
   */
  function accessFor(account: TestAccount): StorageFileAccess {
    return {
      path: store.statePath(account),
      read: () => store.readState(account),
      write: (contents) => store.writeState(account, contents),
    }
  }

  /**
   * Require one stored account by id.
   * @param id - account id.
   * @returns the stored record.
   */
  async function requireAccount(id: string): Promise<TestAccount> {
    const account = await store.get(id)
    if (account === undefined) throw new AccountStoreError('unknown-account', `账号 “${id}” 不存在`)
    return account
  }

  /**
   * Dispatch one Remote endpoint.
   * @param endpoint - channel-relative endpoint name.
   * @param payload - decoded payload.
   * @param signal - caller cancellation.
   * @returns the endpoint result.
   */
  async function handle(endpoint: string, payload: unknown, signal: AbortSignal): Promise<RemoteResult<unknown>> {
    try {
      const fields = asObject(payload)
      switch (endpoint) {
        case Endpoint.list: {
          const sessionId = typeof fields.sessionId === 'string' ? fields.sessionId : undefined
          return ok(await snapshot(sessionId))
        }
        case Endpoint.current: {
          const sessionId = requireField(fields, 'sessionId')
          const accountId = currentAccounts.get(sessionId)
          return ok(accountId === undefined ? {} : { currentAccountId: accountId })
        }
        case Endpoint.create: {
          const raw = asObject(fields.input)
          const createInput: AccountInput = {
            id: requireField(raw, 'id'),
            name: requireField(raw, 'name'),
          }
          if (typeof raw.site === 'string') createInput.site = raw.site
          if (Array.isArray(raw.tags)) createInput.tags = raw.tags.filter((tag): tag is string => typeof tag === 'string')
          const account = await store.create(createInput)
          log.info('created account %s', account.id)
          return ok(await view(account))
        }
        case Endpoint.update: {
          const id = requireField(fields, 'id')
          const raw = asObject(fields.patch)
          const patch: AccountPatch = {}
          if (typeof raw.name === 'string') patch.name = raw.name
          if (raw.site === null) patch.site = null
          else if (typeof raw.site === 'string') patch.site = raw.site
          if (raw.tags === null) patch.tags = null
          else if (Array.isArray(raw.tags)) patch.tags = raw.tags.filter((tag): tag is string => typeof tag === 'string')
          const account = await store.update(id, patch)
          return ok(await view(account))
        }
        case Endpoint.delete: {
          const id = requireField(fields, 'id')
          await store.remove(id)
          for (const [sessionId, accountId] of currentAccounts) {
            if (accountId === id) currentAccounts.delete(sessionId)
          }
          log.info('deleted account %s', id)
          return ok({ id })
        }
        case Endpoint.saveState: {
          const sessionId = requireField(fields, 'sessionId')
          const id = requireField(fields, 'id')
          const agent = requireAgent(sessionId)
          const account = await requireAccount(id)
          await bridge.save(agent, accessFor(account), signal)
          const updated = await store.touch(account.id)
          log.info('saved login state for %s from session %s', id, sessionId)
          return ok(await view(updated))
        }
        case Endpoint.use: {
          const sessionId = requireField(fields, 'sessionId')
          const id = requireField(fields, 'id')
          const agent = requireAgent(sessionId)
          const account = await requireAccount(id)
          await bridge.restore(agent, accessFor(account), signal)
          currentAccounts.set(sessionId, id)
          log.info('session %s switched to account %s', sessionId, id)
          return ok({ account: await view(account), currentAccountId: id })
        }
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

  log.info('account store rooted at %s (provider %s, state access %s)', store.root, config.mcpProvider, config.stateAccess)
}
