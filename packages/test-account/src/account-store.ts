/**
 * The account metadata registry: `accounts.json` plus one storageState file per
 * account. Deliberately free of browser, Cordis, and DSH imports so it is
 * unit-testable on its own.
 * @module
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import {
  type AccountInput,
  type AccountPatch,
  type AccountsFile,
  type AccountStateInfo,
  type TestAccount,
} from './types.ts'

/** Accepted account ids: a lowercase slug safe as a file name. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u

/** Current `accounts.json` schema version. */
export const ACCOUNTS_FILE_VERSION = 1

/** A store failure carrying a stable code the Remote layer forwards verbatim. */
export class AccountStoreError extends Error {
  /** Stable machine-readable code. */
  readonly code: string
  /**
   * @param code - stable code such as `duplicate-id`.
   * @param message - human-readable explanation.
   * @param options - standard error options.
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AccountStoreError'
    this.code = code
  }
}

/** Metadata directory layout. */
export const ACCOUNTS_FILE_NAME = 'accounts.json'
/** Directory holding one storageState file per account. */
export const STATES_DIR_NAME = 'states'

/**
 * Write a file so a reader never observes a half-written document.
 * @param path - destination path.
 * @param contents - complete UTF-8 contents.
 */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Read a UTF-8 file, mapping a missing file to `undefined`.
 * @param path - file to read.
 * @returns the contents, or `undefined` when absent.
 */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Trim and validate a user-supplied account id.
 * @param id - raw id.
 * @returns the normalized id.
 */
export function normalizeId(id: string): string {
  const normalized = id.trim().toLowerCase()
  if (!ID_PATTERN.test(normalized)) {
    throw new AccountStoreError(
      'invalid-id',
      `账号 ID “${id}” 不合法：只允许小写字母、数字、点、下划线、连字符，且需以字母或数字开头（最长 64 字符）`,
    )
  }
  return normalized
}

/**
 * Normalize a display name.
 * @param name - raw name.
 * @returns the trimmed name.
 */
export function normalizeName(name: string): string {
  const normalized = name.trim()
  if (normalized === '') throw new AccountStoreError('invalid-name', '账号名称不能为空')
  return normalized
}

/**
 * Normalize the optional tag list.
 * @param tags - raw tags.
 * @returns trimmed, de-duplicated tags, or `undefined` when empty.
 */
export function normalizeTags(tags: readonly string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined
  const seen = new Set<string>()
  for (const tag of tags) {
    const normalized = tag.trim()
    if (normalized !== '') seen.add(normalized)
  }
  return seen.size === 0 ? undefined : [...seen]
}

/**
 * Normalize the optional site label.
 * @param site - raw site.
 * @returns the trimmed site, or `undefined` when blank.
 */
export function normalizeSite(site: string | undefined | null): string | undefined {
  if (site === undefined || site === null) return undefined
  const normalized = site.trim()
  return normalized === '' ? undefined : normalized
}

/**
 * Validate one parsed account record.
 * @param value - parsed JSON value.
 * @param index - position in the file, for the error message.
 * @returns the validated record.
 */
function parseAccount(value: unknown, index: number): TestAccount {
  if (typeof value !== 'object' || value === null) {
    throw new AccountStoreError('invalid-file', `accounts[${index}] 不是对象`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) {
    throw new AccountStoreError('invalid-file', `accounts[${index}].id 不合法`)
  }
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    throw new AccountStoreError('invalid-file', `accounts[${index}].name 不合法`)
  }
  if (typeof record.stateFile !== 'string' || record.stateFile.trim() === '') {
    throw new AccountStoreError('invalid-file', `accounts[${index}].stateFile 不合法`)
  }
  const account: TestAccount = { id: record.id, name: record.name, stateFile: record.stateFile }
  const site = normalizeSite(typeof record.site === 'string' ? record.site : undefined)
  if (site !== undefined) account.site = site
  const tags = normalizeTags(Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : undefined)
  if (tags !== undefined) account.tags = tags
  if (typeof record.updatedAt === 'string') account.updatedAt = record.updatedAt
  return account
}

/**
 * Validate a parsed `accounts.json` document.
 * @param value - parsed JSON value.
 * @returns the validated document.
 */
export function parseAccountsFile(value: unknown): AccountsFile {
  if (typeof value !== 'object' || value === null) {
    throw new AccountStoreError('invalid-file', 'accounts.json 顶层不是对象')
  }
  const record = value as Record<string, unknown>
  const rawAccounts = record.accounts
  if (rawAccounts !== undefined && !Array.isArray(rawAccounts)) {
    throw new AccountStoreError('invalid-file', 'accounts.json 的 accounts 字段不是数组')
  }
  const accounts = (rawAccounts ?? []).map(parseAccount)
  const ids = new Set<string>()
  for (const account of accounts) {
    if (ids.has(account.id)) throw new AccountStoreError('invalid-file', `accounts.json 中存在重复 id：${account.id}`)
    ids.add(account.id)
  }
  return { version: ACCOUNTS_FILE_VERSION, accounts }
}

/**
 * The account store rooted at one directory.
 *
 * The store owns both halves of an account: its metadata row in
 * `accounts.json` and its storageState file under `states/`. It never touches a
 * browser; callers pass already-serialized storageState JSON in and out.
 */
export class AccountStore {
  /** Absolute account-store directory. */
  readonly root: string

  /**
   * @param root - absolute account-store directory.
   */
  constructor(root: string) {
    this.root = resolve(root)
  }

  /** Absolute path of `accounts.json`. */
  get accountsPath(): string {
    return resolve(this.root, ACCOUNTS_FILE_NAME)
  }

  /** Absolute path of the `states/` directory. */
  get statesDir(): string {
    return resolve(this.root, STATES_DIR_NAME)
  }

  /**
   * Resolve one account's storageState path, refusing anything outside `states/`.
   * @param account - account whose `stateFile` to resolve.
   * @returns the absolute state file path.
   */
  statePath(account: Pick<TestAccount, 'stateFile'>): string {
    const target = resolve(this.root, ...account.stateFile.split('/'))
    const boundary = this.statesDir + sep
    if (!target.startsWith(boundary)) {
      throw new AccountStoreError('invalid-state-file', `账号登录态路径越界：${account.stateFile}`)
    }
    return target
  }

  /**
   * Read the whole document, treating a missing file as an empty registry.
   * @returns the validated document.
   */
  async read(): Promise<AccountsFile> {
    const raw = await readOptional(this.accountsPath)
    if (raw === undefined) return { version: ACCOUNTS_FILE_VERSION, accounts: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new AccountStoreError('invalid-json', `${this.accountsPath} 不是合法 JSON`, { cause: error })
    }
    return parseAccountsFile(parsed)
  }

  /**
   * Persist the whole document atomically.
   * @param file - document to write.
   */
  async write(file: AccountsFile): Promise<void> {
    const document: AccountsFile = { version: ACCOUNTS_FILE_VERSION, accounts: file.accounts }
    await writeFileAtomic(this.accountsPath, `${JSON.stringify(document, null, 2)}\n`)
  }

  /**
   * List every account in file order.
   * @returns the account records.
   */
  async list(): Promise<TestAccount[]> {
    return (await this.read()).accounts
  }

  /**
   * Look one account up by id.
   * @param id - account id.
   * @returns the record, or `undefined`.
   */
  async get(id: string): Promise<TestAccount | undefined> {
    return (await this.list()).find((account) => account.id === id)
  }

  /**
   * Create an account's metadata. No login state is written.
   * @param input - user-supplied account fields.
   * @returns the created record.
   */
  async create(input: AccountInput): Promise<TestAccount> {
    const id = normalizeId(input.id)
    const file = await this.read()
    if (file.accounts.some((account) => account.id === id)) {
      throw new AccountStoreError('duplicate-id', `账号 ID “${id}” 已存在`)
    }
    const account: TestAccount = {
      id,
      name: normalizeName(input.name),
      stateFile: `${STATES_DIR_NAME}/${id}.json`,
    }
    const site = normalizeSite(input.site)
    if (site !== undefined) account.site = site
    const tags = normalizeTags(input.tags)
    if (tags !== undefined) account.tags = tags
    await this.write({ version: ACCOUNTS_FILE_VERSION, accounts: [...file.accounts, account] })
    return account
  }

  /**
   * Patch an account's metadata. `stateFile` and `id` are immutable.
   * @param id - account id.
   * @param patch - fields to change; `null` clears an optional one.
   * @returns the updated record.
   */
  async update(id: string, patch: AccountPatch): Promise<TestAccount> {
    const file = await this.read()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new AccountStoreError('unknown-account', `账号 “${id}” 不存在`)
    const current = file.accounts[index] as TestAccount
    const next: TestAccount = { ...current }
    if (patch.name !== undefined) next.name = normalizeName(patch.name)
    if (patch.site !== undefined) {
      const site = normalizeSite(patch.site)
      if (site === undefined) delete next.site
      else next.site = site
    }
    if (patch.tags !== undefined) {
      const tags = normalizeTags(patch.tags ?? [])
      if (tags === undefined) delete next.tags
      else next.tags = tags
    }
    const accounts = [...file.accounts]
    accounts[index] = next
    await this.write({ version: ACCOUNTS_FILE_VERSION, accounts })
    return next
  }

  /**
   * Delete an account and its saved login state.
   * @param id - account id.
   */
  async remove(id: string): Promise<void> {
    const file = await this.read()
    const account = file.accounts.find((candidate) => candidate.id === id)
    if (account === undefined) throw new AccountStoreError('unknown-account', `账号 “${id}” 不存在`)
    await this.write({ version: ACCOUNTS_FILE_VERSION, accounts: file.accounts.filter((candidate) => candidate.id !== id) })
    await rm(this.statePath(account), { force: true })
  }

  /**
   * Record that login state was refreshed.
   * @param id - account id.
   * @param updatedAt - ISO timestamp; defaults to now.
   * @returns the updated record.
   */
  async touch(id: string, updatedAt: string = new Date().toISOString()): Promise<TestAccount> {
    const file = await this.read()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new AccountStoreError('unknown-account', `账号 “${id}” 不存在`)
    const next: TestAccount = { ...(file.accounts[index] as TestAccount), updatedAt }
    const accounts = [...file.accounts]
    accounts[index] = next
    await this.write({ version: ACCOUNTS_FILE_VERSION, accounts })
    return next
  }

  /**
   * Measure one account's storageState file.
   * @param account - account to inspect.
   * @returns existence, size, and modification time.
   */
  async stateInfo(account: Pick<TestAccount, 'stateFile'>): Promise<AccountStateInfo> {
    try {
      const stats = await stat(this.statePath(account))
      return { exists: true, bytes: stats.size, updatedAt: stats.mtime.toISOString() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
      throw error
    }
  }

  /**
   * Read one account's storageState JSON.
   * @param account - account to read.
   * @returns the raw JSON text.
   */
  async readState(account: Pick<TestAccount, 'id' | 'stateFile'>): Promise<string> {
    const contents = await readOptional(this.statePath(account))
    if (contents === undefined) {
      throw new AccountStoreError('state-missing', `账号 “${account.id}” 还没有保存登录态`)
    }
    return contents
  }

  /**
   * Write one account's storageState JSON.
   * @param account - account to write.
   * @param contents - complete JSON text.
   */
  async writeState(account: Pick<TestAccount, 'stateFile'>, contents: string): Promise<void> {
    await writeFileAtomic(this.statePath(account), contents)
  }
}
