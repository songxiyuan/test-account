/**
 * Per-Session mounting for the upstream Playwright MCP server.
 *
 * DSH's shipped browser stack only exists on the 0.1.6+ line, so this provider
 * mounts `@playwright/mcp` itself instead of registering with `ctx.browserUse`.
 * Every live Agent gets its own scoped `@deepseek-ai/dsh-mcp-client` instance,
 * which is what makes two Sessions run two browsers and see two independent
 * `mcp__<name>__*` tool namespaces.
 *
 * The mount mirrors the lifecycle DSH's own browser runtime used: one stdio
 * child per live Agent, opened when that Agent is created, closed when the
 * Agent (or the whole plugin) is disposed.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
// Loads the `tools/execute` waterfall on `Events`; without it the tool-ownership
// guard below cannot be typed.
import type {} from '@deepseek-ai/dsh-tools'

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity, also the `mcp__<name>__` tool namespace. */
  readonly name: string
  /** Whether only one live Session may hold the server; set for `attach` mode. */
  readonly exclusive: boolean
  /** Executable used to start the installed MCP server. */
  readonly command: string
  /** Arguments passed directly, without shell interpolation. */
  readonly args: readonly string[]
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  readonly env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  readonly toolCallTimeoutMs?: number
}

/** One mounted Session server and its scope disposer. */
interface MountedSession {
  /** Dispose the scope, which closes the stdio child. Idempotent. */
  close(): Promise<void>
}

/** MCP resource tools are global and address a server through `arguments.server`. */
const RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])

/**
 * Mount one Playwright MCP server per live Agent.
 *
 * The handler runs `prepend` so the tool catalog exists before the Agent's first
 * turn, matching how a browser tool must be visible the moment a Session starts.
 * @param ctx - provider context supplying the Agent registry and tool runtime.
 * @param options - provider identity, exclusivity, and launch configuration.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void {
  const toolPrefix = `mcp__${options.name}__`
  const sessions = new Map<Agent, MountedSession>()
  let stopping = false

  ctx.effect(
    () => async () => {
      stopping = true
      const closing = [...sessions.values()].map((session) => session.close().catch(() => undefined))
      sessions.clear()
      await Promise.all(closing)
    },
    `${options.name}.sessions`,
  )

  ctx.on(
    'agent/created',
    async ({ agent }) => {
      if (stopping) return
      // `attach` hands one externally owned browser to a single live Session;
      // later Sessions simply start without browser tools.
      if (options.exclusive && sessions.size > 0) return
      const scope = createScope(ctx, agent)
      agent.ctx.effect(
        () => async () => {
          sessions.delete(agent)
          await scope.dispose()
        },
        `${options.name}.activation`,
      )
      try {
        await scope.ctx.plugin(
          McpClient,
          McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: [...options.args],
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }),
            ...(options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs }),
            failOnStartupError: true,
            reconnect: { enabled: false },
          }),
        )
        sessions.set(agent, { close: () => scope.dispose() })
      } catch (error) {
        await scope.dispose()
        throw error
      }
    },
    { prepend: true },
  )

  // One Session's browser must never answer another Session's tool call.
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource =
      RESOURCE_TOOLS.has(exec.name) &&
      typeof exec.arguments === 'object' &&
      exec.arguments !== null &&
      (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    if (exec.agent === undefined || !sessions.has(exec.agent)) {
      throw new Error(`${options.name}: browser tool belongs to another Session`)
    }
    return next()
  })
}
