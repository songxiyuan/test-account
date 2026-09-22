/**
 * Browser-side contract for the test-account panel.
 *
 * These types mirror the DSH client contracts this plugin consumes
 * (`ctx.slots`, `ctx.sidebarRightTabs`, `ctx.sidebarRight`, `ctx.connection.rpc`
 * and the Session-scoped standard props). They are declared locally on purpose:
 * the client bundle then has no runtime or type dependency beyond React, so a
 * DSH upgrade cannot break the build.
 * @module
 */

/** One Remote failure, mirroring the Connection RPC envelope. */
export interface RemoteFailure {
  code: string
  message: string
  details: object
}

/** The Connection RPC success/failure envelope. */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/** The authenticated route the Host serves this plugin's endpoints on. */
export const TEST_ACCOUNT_API_PATH = '/api/test-account'

/** Endpoints served on {@link TEST_ACCOUNT_API_PATH}. */
export const Endpoint = {
  list: 'accounts/list',
  create: 'accounts/create',
  update: 'accounts/update',
  delete: 'accounts/delete',
  saveState: 'accounts/saveState',
  use: 'accounts/use',
  current: 'accounts/current',
} as const

/** One account as the panel renders it. */
export interface AccountView {
  id: string
  name: string
  site?: string
  tags?: string[]
  stateFile: string
  updatedAt?: string
  hasState: boolean
  stateBytes?: number
  stateUpdatedAt?: string
}

/** Everything one render of the panel needs. */
export interface AccountsSnapshot {
  root: string
  currentAccountId?: string
  accounts: AccountView[]
}

/** Fields the add dialog collects. */
export interface AccountDraft {
  id: string
  name: string
  site: string
  tags: string
}

/** The Cordis effect scope this plugin registers into. */
export interface EffectScope {
  effect(execute: () => (() => void) | void, label?: string): () => void
}

/** The client context surface the account panel is applied to. */
export interface TestAccountContext extends EffectScope {
  slots: Slots
  sidebarRight: SidebarRight
  sidebarRightTabs: SidebarRightTabs
}
/** One registered right-Sidebar page type. */
export interface TabDefinition {
  id: string
  kind: string
  priority?: 'extension' | 'builtin' | 'fallback'
  title: (address: string) => string
  guide?: readonly { order?: number; title: (address: string) => string; description?: string }[]
}

/** The registration surface for right-Sidebar page types. */
export interface SidebarRightTabs {
  register(definition: TabDefinition): () => void
}

/** The navigating half of the right Sidebar. */
export interface SidebarRight {
  openTab(kind: string, options?: { replaceTab?: string }): void
}

/** One slot registration. */
export interface SlotRegistration {
  name: string
  key?: string
  id?: string
  order?: number
  [field: string]: unknown
}

/** The browser slot registry. */
export interface Slots {
  register(config: SlotRegistration, component: unknown): () => void
  inject(name: string, callback: () => unknown): () => void
}

/** The Cordis effect scope this plugin registers into. */
export interface EffectScope {
  effect(execute: () => (() => void) | void, label?: string): () => void
}

/**
 * The client context surface the account panel is applied to.
 *
 * `connection` is declared as a Cordis dependency by the plugin's `inject` but
 * never read: the panel talks to the Host with a plain same-origin POST to the
 * Connection `/api` prefix that plugin owns.
 */
export interface TestAccountContext extends EffectScope {
  slots: Slots
  sidebarRight: SidebarRight
  sidebarRightTabs: SidebarRightTabs
}

/** A failed Remote call, surfaced to the user as-is. */
export class RemoteCallError extends Error {
  /** Stable code from the Host. */
  readonly code: string
  /**
   * @param code - stable Host code.
   * @param message - human-readable Host message.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteCallError'
    this.code = code
  }
}

/**
 * Call one Host endpoint and unwrap the success envelope.
 *
 * The request rides the Connection `/api` prefix, whose physical carrier has
 * already applied the Host/Origin fence and browser authentication, so a plain
 * same-origin POST carries the session cookie and nothing else is needed.
 * @param endpoint - channel-relative endpoint name.
 * @param payload - endpoint payload.
 * @param signal - caller cancellation.
 * @returns the endpoint value.
 */
export async function callRemote<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(TEST_ACCOUNT_API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new RemoteCallError(`http-${response.status}`, `${endpoint} 请求失败：HTTP ${response.status}`)
  }
  const result = (await response.json()) as RemoteResult<T>
  if (!result.ok) throw new RemoteCallError(result.error.code, result.error.message)
  return result.value
}

/**
 * Render an ISO timestamp as `MM-DD HH:mm`.
 * @param iso - ISO timestamp.
 * @returns the short local time, or an empty string when unparseable.
 */
export function shortTime(iso: string | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Render a byte count compactly.
 * @param bytes - byte count.
 * @returns the human-readable size.
 */
export function shortBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}
