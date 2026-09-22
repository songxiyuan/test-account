/**
 * The account service: every operation the plugin offers, over one store, one
 * browser bridge, and one per-Session current-account map.
 *
 * Both faces of the Host side drive this object — the `/api/test-account` route
 * and the Agent tools — so neither duplicates the other's rules (id
 * normalization, state measurement, Session liveness, error codes).
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { AccountStore, AccountStoreError } from './account-store.ts'
import { BrowserStorageError, type StorageFileAccess } from './browser-storage.ts'
import type { AccountInput, AccountPatch, AccountsSnapshot, AccountView, TestAccount } from './types.ts'

/** The browser half the service needs; satisfied by {@link BrowserStorageBridge}. */
export interface StorageBridge {
  /**
   * Capture the live browser's cookies and local storage into an account.
   * @param agent - the Session's live Agent, which owns the browser.
   * @param access - where the account's state file lives.
   * @param signal - caller cancellation.
   */
  save(agent: Agent, access: StorageFileAccess, signal: AbortSignal): Promise<void>
  /**
   * Restore an account's saved login state into the live browser.
   * @param agent - the Session's live Agent, which owns the browser.
   * @param access - where the account's state file lives.
   * @param signal - caller cancellation.
   */
  restore(agent: Agent, access: StorageFileAccess, signal: AbortSignal): Promise<void>
  /**
   * Report which storage tools this Session exposes.
   * @param agent - live Agent whose scope is inspected.
   */
  availability(agent: Agent): { save: boolean; restore: boolean }
}

/** The Agent lookup the service needs; satisfied by `ctx.agents`. */
export interface AgentLookup {
  /**
   * Resolve one live Agent.
   * @param sessionId - Session id.
   * @returns the Agent, or `undefined` when the Session is not live.
   */
  get(sessionId: string): Agent | undefined
}

/** Log sink the service writes operation lines to. */
export interface ServiceLogger {
  info(format: unknown, ...params: unknown[]): void
  warn(format: unknown, ...params: unknown[]): void
}

/** Everything {@link AccountService} depends on. */
export interface AccountServiceDeps {
  store: AccountStore
  bridge: StorageBridge
  agents: AgentLookup
  log?: ServiceLogger
}

/** The result of restoring one account into a Session. */
export interface UseAccountResult {
  account: AccountView
  currentAccountId: string
}

/**
 * Account operations shared by the Remote route and the Agent tools.
 *
 * The current-account map is memory-only and keyed by Session id, so two Sessions
 * may hold two different accounts at the same time without either overwriting the
 * other; the browser's real authentication state stays with the browser.
 */
export class AccountService {
  private readonly deps: AccountServiceDeps
  /** Session id to account id, for this process lifetime only. */
  private readonly currentAccounts = new Map<string, string>()

  /**
   * @param deps - store, browser bridge, Agent lookup, and optional log sink.
   */
  constructor(deps: AccountServiceDeps) {
    this.deps = deps
  }

  /** Absolute account-store directory. */
  get root(): string {
    return this.deps.store.root
  }

  /**
   * Project one stored account onto the UI shape.
   * @param account - stored record.
   * @returns the account plus its measured state facts.
   */
  async view(account: TestAccount): Promise<AccountView> {
    const info = await this.deps.store.stateInfo(account)
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
  async list(sessionId?: string): Promise<AccountsSnapshot> {
    const accounts = await Promise.all((await this.deps.store.list()).map((account) => this.view(account)))
    const snapshot: AccountsSnapshot = { root: this.root, accounts }
    const current = sessionId === undefined ? undefined : this.currentAccounts.get(sessionId)
    if (current !== undefined) snapshot.currentAccountId = current
    return snapshot
  }

  /**
   * Create an account's metadata. No login state is written.
   * @param input - user-supplied fields.
   * @returns the created account.
   */
  async create(input: AccountInput): Promise<AccountView> {
    const account = await this.deps.store.create(input)
    this.deps.log?.info('created account %s', account.id)
    return this.view(account)
  }

  /**
   * Patch an account's metadata.
   * @param id - account id.
   * @param patch - fields to change; `null` clears an optional one.
   * @returns the updated account.
   */
  async update(id: string, patch: AccountPatch): Promise<AccountView> {
    return this.view(await this.deps.store.update(id, patch))
  }

  /**
   * Delete an account, its login state, and every Session's claim on it.
   * @param id - account id.
   * @returns the deleted id.
   */
  async remove(id: string): Promise<{ id: string }> {
    await this.deps.store.remove(id)
    for (const [sessionId, accountId] of this.currentAccounts) {
      if (accountId === id) this.currentAccounts.delete(sessionId)
    }
    this.deps.log?.info('deleted account %s', id)
    return { id }
  }

  /**
   * Require one stored account by id.
   * @param id - account id.
   * @returns the stored record.
   */
  async requireAccount(id: string): Promise<TestAccount> {
    const account = await this.deps.store.get(id)
    if (account === undefined) throw new AccountStoreError('unknown-account', `账号 “${id}” 不存在`)
    return account
  }

  /**
   * Capture the live browser of one Session into an account.
   * @param sessionId - Session whose browser to read.
   * @param id - account to save into.
   * @param signal - caller cancellation.
   * @returns the refreshed account.
   */
  async saveState(sessionId: string, id: string, signal: AbortSignal): Promise<AccountView> {
    const agent = this.requireAgent(sessionId)
    const account = await this.requireAccount(id)
    await this.deps.bridge.save(agent, this.accessFor(account), signal)
    const updated = await this.deps.store.touch(account.id)
    this.deps.log?.info('saved login state for %s from session %s', id, sessionId)
    return this.view(updated)
  }

  /**
   * Restore one account into a Session's live browser and mark it current.
   * @param sessionId - Session whose browser to write.
   * @param id - account to restore.
   * @param signal - caller cancellation.
   * @returns the restored account and the new current account id.
   */
  async use(sessionId: string, id: string, signal: AbortSignal): Promise<UseAccountResult> {
    const agent = this.requireAgent(sessionId)
    const account = await this.requireAccount(id)
    await this.deps.bridge.restore(agent, this.accessFor(account), signal)
    this.currentAccounts.set(sessionId, id)
    this.deps.log?.info('session %s switched to account %s', sessionId, id)
    return { account: await this.view(account), currentAccountId: id }
  }

  /**
   * Read the account one Session currently uses.
   * @param sessionId - Session id.
   * @returns the account id when one was chosen.
   */
  current(sessionId: string): { currentAccountId?: string } {
    const accountId = this.currentAccounts.get(sessionId)
    return accountId === undefined ? {} : { currentAccountId: accountId }
  }

  /**
   * Resolve one Session's live Agent.
   * @param sessionId - Session id.
   * @returns the live Agent.
   */
  requireAgent(sessionId: string): Agent {
    const agent = this.deps.agents.get(sessionId)
    if (agent === undefined) {
      throw new BrowserStorageError('session-not-live', `Session ${sessionId} 当前不活跃，无法操作浏览器登录态`)
    }
    return agent
  }

  /**
   * Wrap one account's storageState file for the browser bridge.
   * @param account - account whose file is read or written.
   * @returns the file access the bridge needs.
   */
  private accessFor(account: TestAccount): StorageFileAccess {
    return {
      path: this.deps.store.statePath(account),
      read: () => this.deps.store.readState(account),
      write: (contents) => this.deps.store.writeState(account, contents),
    }
  }
}
