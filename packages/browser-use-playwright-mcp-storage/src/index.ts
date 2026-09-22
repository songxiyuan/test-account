/**
 * Playwright MCP browser provider with the upstream `storage` capability on.
 *
 * The shipped provider (`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp`)
 * hard-codes its `@playwright/mcp` arguments, so the storage-gated tools
 * (`browser_storage_state` / `browser_set_storage_state`) are filtered out of the
 * tool catalog and cannot be reached by any Agent. This provider reuses the same
 * session lifecycle (`mountSessionMcp`) and only changes the process arguments:
 *
 * - `--caps=storage` adds the storage tool family.
 * - `--allow-unrestricted-file-access` (opt-in, on by default) lets those tools
 *   read and write the account state directory outside the Session workspace.
 *
 * A deployment may mount only one browser-use provider at a time, so this
 * package replaces the shipped Playwright provider rather than joining it.
 * @module @dsh-test-account/browser-use-playwright-mcp-storage
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { BROWSER_PROVIDER_NAME, buildArgs, resolveConfig, resolveExecutablePath, type Config } from './args.ts'

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

/** Cordis identity for this provider plugin. */
export const name = 'browser-use-playwright-mcp-storage'

/** Services required before the provider can reserve browser use. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt']

/**
 * Expose the storage-capable Playwright tool catalog in each live Session's scope.
 * @param ctx - provider context supplying browser use, Agents, tools, and prompts.
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
  // of browser configuration, and the shipped provider scrubs them the same way.
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
