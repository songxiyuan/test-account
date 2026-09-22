/**
 * Shared shapes for the test-account plugin: the on-disk account metadata, the
 * UI-facing projection, and the Host/Client Remote payloads.
 * @module
 */

/** One test account's metadata as persisted in `accounts.json`. */
export interface TestAccount {
  /** Stable slug used in the state file name and in every Remote call. */
  id: string
  /** Human-readable display name. */
  name: string
  /** Optional product or site the account belongs to, used for grouping. */
  site?: string
  /** Optional free-form labels such as `vip`, `us`, `admin`. */
  tags?: string[]
  /** Account-relative path of the saved Playwright storageState file. */
  stateFile: string
  /** ISO timestamp of the last successful login-state save. */
  updatedAt?: string
}

/** The whole persisted file. `version` exists so the shape can migrate later. */
export interface AccountsFile {
  version: 1
  accounts: TestAccount[]
}

/** What a user supplies when creating an account. No credentials are ever stored. */
export interface AccountInput {
  id: string
  name: string
  site?: string
  tags?: string[]
}

/** What a user may change on an existing account. `null` clears an optional field. */
export interface AccountPatch {
  name?: string
  site?: string | null
  tags?: string[] | null
}

/** Live state of one account's storageState file, measured when a list is built. */
export interface AccountStateInfo {
  exists: boolean
  bytes?: number
  /** ISO modification time of the state file. */
  updatedAt?: string
}

/** An account plus the state facts the panel renders. */
export interface AccountView extends TestAccount {
  hasState: boolean
  stateBytes?: number
  stateUpdatedAt?: string
}

/** Everything the panel needs for one render, for one Session. */
export interface AccountsSnapshot {
  /** Absolute account-store directory, shown in the panel footer. */
  root: string
  /** Account in force for this Session, when one was chosen. */
  currentAccountId?: string
  accounts: AccountView[]
}

/** One Remote failure, mirroring the Connection RPC envelope. */
export interface RemoteFailure {
  code: string
  message: string
  details: object
}

/** The Connection RPC success/failure envelope. */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/**
 * Exact Fetch route owned by this plugin, on the Connection `/api` channel.
 *
 * `test-account` does NOT use `ctx.connection.rpc.handle`: that call mounts the
 * channel through the service's own context and Cordis refuses the traced
 * `webServer` read outside the service's scope. The exact Fetch route on the
 * authenticated `/api` prefix is the documented extension point for a route the
 * JSON Remote gateway does not own. The path must be absolute *including* the
 * `/api` prefix, because the shared-channel dispatcher matches it verbatim.
 */
export const TEST_ACCOUNT_ROUTE = '/api/test-account'

/** Endpoints served on {@link TEST_ACCOUNT_ROUTE}. */
export const Endpoint = {
  list: 'accounts/list',
  create: 'accounts/create',
  update: 'accounts/update',
  delete: 'accounts/delete',
  saveState: 'accounts/saveState',
  use: 'accounts/use',
  current: 'accounts/current',
} as const

/** Every endpoint name, for exhaustive dispatch. */
export type EndpointName = (typeof Endpoint)[keyof typeof Endpoint]
