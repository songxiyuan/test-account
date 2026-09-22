/**
 * The bridge from the account store to the live Session's browser.
 *
 * This plugin never starts a browser: it drives the Playwright MCP storage tools
 * that DSH already exposes in the current Session's tool scope. Two facts about
 * those tools shape this module:
 *
 * - They only exist when the mounted browser provider enables the upstream
 *   `storage` capability, so a missing tool is reported as an actionable setup
 *   error rather than a generic failure.
 * - They resolve file names against the Session workspace and refuse paths
 *   outside it unless the provider launched with
 *   `--allow-unrestricted-file-access`. {@link BrowserStorageBridge} therefore
 *   supports a staged mode, and falls back to it when a direct path is refused.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

/** Upstream Playwright MCP tool that captures the current browser storage state. */
export const SAVE_STATE_TOOL = 'browser_storage_state'
/** Upstream Playwright MCP tool that restores a browser storage state. */
export const RESTORE_STATE_TOOL = 'browser_set_storage_state'

/** A bridge failure carrying a stable code the Remote layer forwards verbatim. */
export class BrowserStorageError extends Error {
  /** Stable machine-readable code. */
  readonly code: string
  /**
   * @param code - stable code such as `browser-tool-unavailable`.
   * @param message - human-readable explanation.
   * @param options - standard error options.
   */
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserStorageError'
    this.code = code
  }
}

/** How the bridge reaches the account store's file. */
export interface StorageFileAccess {
  /** Preferred absolute path inside the account store. */
  readonly path: string
  /** Read the stored state JSON. */
  read(): Promise<string>
  /** Write the stored state JSON. */
  write(contents: string): Promise<void>
}

/** The slice of the Session's tool runtime the bridge needs. */
export interface StorageBridgeHost {
  readonly tools: Pick<ToolRuntime, 'get' | 'execute'>
}

/** Bridge configuration derived from the plugin config. */
export interface StorageBridgeOptions {
  /** Browser provider name, i.e. the `mcp__<provider>__` tool namespace. */
  provider: string
  /** `direct` writes the account path straight through; `staged` round-trips the workspace. */
  stateAccess: 'direct' | 'staged'
  /** File-name prefix used for the temporary workspace copy in staged mode. */
  stagePrefix: string
  /** Upper bound on one browser storage tool call. */
  toolTimeoutMs: number
}

/**
 * Compose one MCP tool name.
 * @param provider - browser provider name.
 * @param tool - upstream tool name.
 * @returns the fully qualified DSH tool name.
 */
export function storageToolName(provider: string, tool: string): string {
  return `mcp__${provider}__${tool}`
}

/**
 * Flatten a tool result's content blocks into text.
 * @param content - result content blocks.
 * @returns the concatenated text blocks.
 */
function contentToText(content: readonly { type?: string; text?: unknown }[] | undefined): string {
  if (content === undefined) return ''
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * Whether a tool failure is the workspace file-access fence.
 * @param error - thrown value.
 * @returns true when a staged retry can succeed.
 */
export function isFileAccessDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /outside allowed roots|File access denied|Access to "file:" protocol is blocked/iu.test(message)
}

/**
 * Build an actionable suffix for a missing-browser failure.
 *
 * The pinned Playwright MCP server defaults to its own `chrome-for-testing`
 * download, which a fresh machine does not have; without this hint the user sees
 * an upstream installer line with no context about the DSH side.
 * @param detail - the tool's failure text.
 * @returns a guidance suffix, or an empty string when unrelated.
 */
export function browserInstallHint(detail: string): string {
  if (!/is not installed|install-browser|Executable doesn't exist|Failed to launch/iu.test(detail)) return ''
  return (
    '\n提示：浏览器本体没找到。任选其一：' +
    '（1）运行 `npx @playwright/mcp install-browser chrome-for-testing` 安装 Playwright 自带 Chromium；' +
    '（2）在 profile 里给 provider 配 `executablePath` 复用本机 Chrome（例如 macOS：' +
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome）。provider 也会自动探测常见安装路径。'
  )
}

/**
 * Drive the Session's Playwright MCP storage tools.
 *
 * A bridge is stateless; it reads the provider namespace and access mode from
 * its options and resolves the live browser through the Agent it is given.
 */
export class BrowserStorageBridge {
  private readonly host: StorageBridgeHost
  private readonly options: StorageBridgeOptions

  /**
   * @param host - Session-scoped tool runtime.
   * @param options - provider namespace and access mode.
   */
  constructor(host: StorageBridgeHost, options: StorageBridgeOptions) {
    this.host = host
    this.options = options
  }

  /**
   * Name of the tool used to capture login state.
   * @returns the qualified save tool name.
   */
  get saveToolName(): string {
    return storageToolName(this.options.provider, SAVE_STATE_TOOL)
  }

  /**
   * Name of the tool used to restore login state.
   * @returns the qualified restore tool name.
   */
  get restoreToolName(): string {
    return storageToolName(this.options.provider, RESTORE_STATE_TOOL)
  }

  /**
   * Report the tools this Session actually exposes.
   * @param agent - live Agent whose scope is inspected.
   * @returns which of the two storage tools are visible.
   */
  availability(agent: Agent): { save: boolean; restore: boolean } {
    return {
      save: this.host.tools.get(this.saveToolName, agent) !== undefined,
      restore: this.host.tools.get(this.restoreToolName, agent) !== undefined,
    }
  }

  /**
   * Capture the live browser's cookies and local storage into the account store.
   * @param agent - the Session's live Agent, which owns the browser.
   * @param access - where the account's state file lives.
   * @param signal - caller cancellation.
   */
  async save(agent: Agent, access: StorageFileAccess, signal: AbortSignal): Promise<void> {
    this.requireTool(agent, this.saveToolName)
    if (this.options.stateAccess === 'direct') {
      try {
        await this.invoke(agent, this.saveToolName, access.path, signal)
        return
      } catch (error) {
        if (!isFileAccessDenied(error)) throw error
      }
    }
    await this.withStagedFile(agent, signal, async (staged) => {
      await this.invoke(agent, this.saveToolName, staged, signal)
      await access.write(await readFile(staged, 'utf8'))
    })
  }

  /**
   * Restore the account's saved login state into the live browser.
   * @param agent - the Session's live Agent, which owns the browser.
   * @param access - where the account's state file lives.
   * @param signal - caller cancellation.
   */
  async restore(agent: Agent, access: StorageFileAccess, signal: AbortSignal): Promise<void> {
    this.requireTool(agent, this.restoreToolName)
    const contents = await access.read()
    if (this.options.stateAccess === 'direct') {
      try {
        await this.invoke(agent, this.restoreToolName, access.path, signal)
        return
      } catch (error) {
        if (!isFileAccessDenied(error)) throw error
      }
    }
    await this.withStagedFile(agent, signal, async (staged) => {
      await writeFile(staged, contents, 'utf8')
      await this.invoke(agent, this.restoreToolName, staged, signal)
    })
  }

  /**
   * Run one storage tool call in the Agent's scope.
   * @param agent - live Agent owning the browser.
   * @param name - qualified tool name.
   * @param filename - path handed to the upstream tool.
   * @param signal - caller cancellation.
   */
  private async invoke(agent: Agent, name: string, filename: string, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.toolTimeoutMs)
    const fused = AbortSignal.any([signal, timeout])
    let result: Awaited<ReturnType<ToolRuntime['execute']>>
    try {
      result = await this.host.tools.execute({
        callId: `test-account:${randomUUID()}` as unknown as ToolCallId,
        name,
        arguments: { filename },
        agent,
        signal: fused,
      })
    } catch (error) {
      if (timeout.aborted) {
        throw new BrowserStorageError('browser-tool-timeout', `调用 ${name} 超时（${this.options.toolTimeoutMs}ms）`, {
          cause: error,
        })
      }
      throw error
    }
    if (result.isError) {
      const detail = contentToText(result.content) || result.error.message
      throw new BrowserStorageError('browser-tool-failed', `${name} 执行失败：${detail}${browserInstallHint(detail)}`)
    }
  }

  /**
   * Run one operation against a temporary file inside the Session workspace.
   * @param agent - live Agent whose Session supplies the workspace root.
   * @param signal - caller cancellation.
   * @param run - operation receiving the temporary absolute path.
   */
  private async withStagedFile(agent: Agent, signal: AbortSignal, run: (path: string) => Promise<void>): Promise<void> {
    const workspace = agent.session.header.cwd
    if (workspace === undefined || workspace === '') {
      throw new BrowserStorageError(
        'no-workspace',
        '当前 Session 没有工作目录，无法用临时文件方式读写登录态。请在挂载浏览器 provider 时开启 allowUnrestrictedFileAccess。',
      )
    }
    await mkdir(join(workspace), { recursive: true })
    const staged = join(workspace, `${this.options.stagePrefix}${randomUUID()}.json`)
    try {
      signal.throwIfAborted()
      await run(staged)
    } finally {
      await rm(staged, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Fail early with setup guidance when the storage tools are not in scope.
   * @param agent - live Agent whose scope is inspected.
   * @param name - qualified tool name that must exist.
   */
  private requireTool(agent: Agent, name: string): void {
    if (this.host.tools.get(name, agent) === undefined) {
      throw new BrowserStorageError(
        'browser-tool-unavailable',
        `当前 Session 看不到浏览器工具 ${name}。请确认 profile 已挂载带 storage 能力的 Playwright MCP provider` +
          '（@dsh-test-account/browser-use-playwright-mcp-storage），并且本 Session 已经启动过浏览器。',
      )
    }
  }
}
