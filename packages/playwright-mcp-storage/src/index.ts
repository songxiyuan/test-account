/**
 * Playwright MCP browser provider with the upstream `storage` capability on.
 *
 * DSH's shipped browser stack (`@deepseek-ai/dsh-browser-use` plus
 * `@deepseek-ai/dsh-experimental-browser-use-runtime`) only exists on the
 * 0.1.6+ line, and its Playwright provider hard-codes the `@playwright/mcp`
 * arguments, so the storage-gated tools (`browser_storage_state` /
 * `browser_set_storage_state`) never reach any Agent. This package replaces that
 * stack instead of plugging into it: it mounts the upstream Playwright MCP
 * server itself through `@deepseek-ai/dsh-mcp-client`, once per live Session,
 * and only adds the switches that matter:
 *
 * - `--caps=storage` adds the storage tool family.
 * - `--allow-unrestricted-file-access` (opt-in, on by default) lets those tools
 *   read and write the account state directory outside the Session workspace.
 *
 * @module @dsh-test-account/playwright-mcp-storage
 */

import type { Context } from '@deepseek-ai/cordis'
import { BROWSER_PROVIDER_NAME, buildArgs, resolveConfig, resolveExecutablePath, type Config } from './args.ts'
import { mountSessionMcp } from './session-mcp.ts'

export {
  BROWSER_PROVIDER_NAME,
  DEFAULT_CAPABILITIES,
  SYSTEM_BROWSER_CANDIDATES,
  buildArgs,
  detectExecutablePath,
  playwrightCliPath,
  resolveExecutablePath,
  validate,
  type ResolvedConfig,
} from './args.ts'
export { Config } from './args.ts'
export { mountSessionMcp, type SessionMcpOptions } from './session-mcp.ts'

/** Cordis identity for this provider plugin. */
export const name = 'playwright-mcp-storage'

/** Services required before the provider can mount a Session browser. */
export const inject = ['agents', 'tools']

/**
 * Expose the storage-capable Playwright tool catalog in each live Session's scope.
 * @param ctx - provider context supplying the Agent registry and tool runtime.
 * @param input - profile-owned launch or attachment configuration.
 */
export function apply(ctx: Context, input: Config = {}): void {
  const config = resolveConfig(input)
  const executable = resolveExecutablePath(config)
  if (config.mode === 'launch' && executable === undefined) {
    ctx.logger.warn(
      'no system Chrome found; falling back to the Playwright-managed browser. ' +
        'If it is missing, run `npx @playwright/mcp install-browser chrome-for-testing`, ' +
        'or set `executablePath` on this provider.',
    )
  }
  // Blank any inherited Playwright MCP switches: the profile is the only source
  // of browser configuration.
  const env = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
      .map((key) => [key, '']),
  )
  mountSessionMcp(ctx, {
    name: BROWSER_PROVIDER_NAME,
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args: buildArgs(config, undefined, executable),
    env,
    ...(config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs }),
  })
}
