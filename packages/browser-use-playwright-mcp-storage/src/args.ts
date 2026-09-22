/**
 * Configuration and command-line composition for the storage-capable Playwright
 * MCP provider. Kept free of Cordis and browser imports so the exact argument
 * list is unit-testable without a DSH boot.
 * @module
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

/** Browser provider name written into `ctx.browserUse` and the tool namespace. */
export const BROWSER_PROVIDER_NAME = 'playwright-mcp'

/** Capabilities enabled in addition to the always-on `core*` tool families. */
export const DEFAULT_CAPABILITIES = ['storage'] as const

/**
 * Well-known system browser locations, per platform.
 *
 * The pinned Playwright MCP server otherwise insists on its own
 * `chrome-for-testing` download, which no fresh machine has. Reusing an already
 * installed Chrome keeps a check-out working without a ~150 MB download and is
 * what the design recommends for internal development machines.
 */
export const SYSTEM_BROWSER_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: [
    join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ],
}

/**
 * Find an installed system browser.
 *
 * Purely a lookup: no network, no install, no side effect.
 * @param platform - target platform; defaults to the running one.
 * @param exists - file-existence predicate; defaults to `fs.existsSync`.
 * @returns the first candidate that exists, or `undefined`.
 */
export function detectExecutablePath(
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return (SYSTEM_BROWSER_CANDIDATES[platform] ?? []).find((candidate) => exists(candidate))
}

/** Provider configuration as declared in a profile patch row. */
export interface Config {
  /** Launch an isolated Chromium per live Session, or attach to an existing one. */
  mode?: 'launch' | 'attach'
  /** Whether the launched Chromium runs without a visible window. */
  headless?: boolean
  /** Chromium executable; omission uses upstream browser discovery. */
  executablePath?: string
  /** Debugging endpoint; required by `attach` and rejected by `launch`. */
  endpoint?: string
  /** Per-call timeout override in milliseconds. */
  toolCallTimeoutMs?: number
  /** `@playwright/mcp` capabilities to enable; defaults to `['storage']`. */
  caps?: string[]
  /**
   * Allow the browser tools to touch paths outside the Session workspace, which
   * the account state directory requires. Also lifts the `file:` navigation block.
   */
  allowUnrestrictedFileAccess?: boolean
  /** Extra raw arguments appended to the pinned server invocation. */
  extraArgs?: string[]
  /**
   * Probe well-known system browser locations when {@link Config.executablePath}
   * is unset; defaults to true so a check-out works without the Playwright
   * `chrome-for-testing` download.
   */
  autoExecutablePath?: boolean
}

/** Loader defaults and validation for the provider configuration. */
export const Config = Schema.object({
  mode: Schema.union([Schema.const('launch'), Schema.const('attach')]).default('launch'),
  headless: Schema.boolean().default(true),
  executablePath: Schema.string(),
  endpoint: Schema.string(),
  toolCallTimeoutMs: Schema.number().min(1),
  caps: Schema.array(Schema.string()).default([...DEFAULT_CAPABILITIES]),
  allowUnrestrictedFileAccess: Schema.boolean().default(true),
  extraArgs: Schema.array(Schema.string()).default([]),
  autoExecutablePath: Schema.boolean().default(true),
})

/** Resolved configuration after schema defaults. */
export type ResolvedConfig = Required<
  Pick<Config, 'mode' | 'headless' | 'caps' | 'allowUnrestrictedFileAccess' | 'extraArgs' | 'autoExecutablePath'>
> &
  Omit<
    Config,
    'mode' | 'headless' | 'caps' | 'allowUnrestrictedFileAccess' | 'extraArgs' | 'autoExecutablePath'
  >

/**
 * Reject a configuration that cannot start a browser before any resource is reserved.
 * @param config - schema-resolved provider configuration.
 */
export function validate(config: ResolvedConfig): void {
  if (config.mode === 'attach') {
    if (config.endpoint === undefined || config.endpoint.trim() === '') {
      throw new Error('browser-use-playwright-mcp-storage: attach mode requires a debugging endpoint')
    }
    let endpoint: URL
    try {
      endpoint = new URL(config.endpoint)
    } catch (error) {
      throw new Error('browser-use-playwright-mcp-storage: endpoint must be a valid HTTP(S) or WS(S) URL', {
        cause: error,
      })
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
      throw new Error(
        'browser-use-playwright-mcp-storage: endpoint must be a valid HTTP(S) or WS(S) URL without whitespace',
      )
    }
  }
  if (config.mode === 'launch' && config.endpoint !== undefined) {
    throw new Error('browser-use-playwright-mcp-storage: endpoint requires attach mode')
  }
  if (config.mode === 'attach' && config.executablePath !== undefined) {
    throw new Error('browser-use-playwright-mcp-storage: executablePath requires launch mode')
  }
}

/** Absolute path of the pinned `@playwright/mcp` CLI shipped with this package. */
export function playwrightCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
}

/**
 * Decide which browser binary the launched server should use.
 * @param config - schema-resolved provider configuration.
 * @param detected - an already-probed system browser; defaults to a fresh probe.
 * @returns the explicit path, the detected one, or `undefined` for upstream discovery.
 */
export function resolveExecutablePath(
  config: ResolvedConfig,
  detected: string | undefined = config.autoExecutablePath ? detectExecutablePath() : undefined,
): string | undefined {
  return config.executablePath ?? detected
}

/**
 * Compose the pinned server invocation.
 * @param config - schema-resolved provider configuration.
 * @param cli - absolute path of the `@playwright/mcp` CLI; defaults to the pinned one.
 * @param executable - browser binary to pass; defaults to {@link resolveExecutablePath}.
 * @returns the CLI path plus the arguments handed to the MCP client.
 */
export function buildArgs(
  config: ResolvedConfig,
  cli: string = playwrightCliPath(),
  executable: string | undefined = resolveExecutablePath(config),
): string[] {
  const args = [cli, '--browser', 'chromium']
  if (config.mode === 'attach') args.push('--cdp-endpoint', config.endpoint as string)
  else {
    args.push('--isolated')
    if (config.headless) args.push('--headless')
    if (executable !== undefined) args.push('--executable-path', executable)
    if (config.allowUnrestrictedFileAccess) args.push('--allow-unrestricted-file-access')
  }
  if (config.caps.length > 0) args.push(`--caps=${config.caps.join(',')}`)
  args.push(...config.extraArgs)
  return args
}

/**
 * Resolve a partial configuration through the loader schema and validate it.
 * @param input - raw profile configuration.
 * @returns the configuration with schema defaults applied.
 */
export function resolveConfig(input: Config = {}): ResolvedConfig {
  const config = Config(input) as ResolvedConfig
  validate(config)
  return config
}
