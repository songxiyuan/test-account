/**
 * Model-facing account tools.
 *
 * A human can switch accounts from the panel, but an Agent cannot see that
 * choice unless it can ask — and requirement 5 of the design ("让 Agent 基于指定
 * 身份继续 Browser Use / E2E / 排障") is only satisfied when the Agent can both
 * read and change the identity itself. The three tools below are thin adapters
 * over {@link AccountService}, so they share the route's validation, error codes,
 * and Session bookkeeping.
 *
 * They carry no credentials: `account_use` restores a previously saved
 * Playwright `storageState` into the calling Session's own browser.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AccountService } from './accounts.ts'
import type { AccountsSnapshot } from './types.ts'

/** Model-facing tool names, as listed in the design's Phase 5. */
export const ACCOUNT_TOOL_NAMES = {
  list: 'account_list',
  use: 'account_use',
  current: 'account_current',
} as const

/** Render one text block. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/**
 * Require the calling Agent, which owns the Session the tools act on.
 * @param agent - the calling Agent, when the call came from a model turn.
 * @returns the Session id.
 */
function requireSessionId(agent: Agent | undefined): string {
  if (agent === undefined) {
    throw new Error('account_* 工具必须在一次 Agent 调用中执行：没有调用方 Session 就没有可操作的浏览器')
  }
  return agent.id
}

/**
 * Format a snapshot for the model.
 * @param snapshot - the account snapshot.
 * @returns a compact multi-line summary.
 */
function formatSnapshot(snapshot: AccountsSnapshot): string {
  const lines = [`账号目录：${snapshot.root}`]
  const current = snapshot.accounts.find((account) => account.id === snapshot.currentAccountId)
  lines.push(
    current === undefined
      ? '当前 Session 未选择测试账号（浏览器沿用现状）'
      : `当前 Session 使用：${current.name}（${current.id}）`,
  )
  if (snapshot.accounts.length === 0) {
    lines.push('还没有任何测试账号，用户需要在 DSH 右侧栏「测试账号」面板里添加。')
    return lines.join('\n')
  }
  for (const account of snapshot.accounts) {
    const tags = account.tags === undefined ? '' : ` [${account.tags.join(', ')}]`
    const site = account.site === undefined ? '' : ` @${account.site}`
    const state = account.hasState
      ? `登录态已保存${account.stateUpdatedAt === undefined ? '' : ` (${account.stateUpdatedAt})`}`
      : '登录态未保存（不能 account_use）'
    lines.push(`- ${account.id}  ${account.name}${site}${tags}  ${state}`)
  }
  return lines.join('\n')
}

/**
 * Register the three account tools in the plugin's fiber.
 * @param ctx - Host context whose tool registry receives the definitions.
 * @param service - the shared account service.
 */
export function registerAgentTools(ctx: Context, service: AccountService): void {
  const listTool = defineTool({
    name: ACCOUNT_TOOL_NAMES.list,
    description:
      '列出当前 DSH 的测试账号（id、名称、站点、标签、登录态是否已保存），并指出本 Session 正在使用哪个账号。' +
      '只读，不会启动或改变浏览器。需要切换身份时先用它拿到账号 id。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', description: '账号目录绝对路径' },
          currentAccountId: { type: 'string', description: '本 Session 当前使用的账号 id' },
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                site: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                hasState: { type: 'boolean', description: '是否已保存登录态' },
                stateUpdatedAt: { type: 'string', description: '登录态文件更新时间（ISO）' },
              },
            },
          },
        },
      },
      render: (_args, value) => text(formatSnapshot(value as AccountsSnapshot)),
    },
    async execute(_args, exec) {
      const snapshot = await service.list(exec.agent?.id)
      return {
        root: snapshot.root,
        ...(snapshot.currentAccountId === undefined ? {} : { currentAccountId: snapshot.currentAccountId }),
        accounts: snapshot.accounts.map((account) => ({
          id: account.id,
          name: account.name,
          ...(account.site === undefined ? {} : { site: account.site }),
          ...(account.tags === undefined ? {} : { tags: [...account.tags] }),
          hasState: account.hasState,
          ...(account.stateUpdatedAt === undefined ? {} : { stateUpdatedAt: account.stateUpdatedAt }),
        })),
      }
    },
  })

  const useTool = defineTool({
    name: ACCOUNT_TOOL_NAMES.use,
    description:
      '把某个测试账号已经保存的登录态（Playwright storageState：cookies 与 localStorage）恢复到本 Session 的浏览器，' +
      '并把本 Session 的当前账号标记为该账号。会覆盖浏览器现有的 cookies 与 localStorage，' +
      '之后需要自行重新导航到目标页面确认身份。账号必须已经保存过登录态。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '账号 id，取值来自 account_list 的 id 字段',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
          hasState: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const result = value as { accountId: string; name: string; hasState: boolean }
        return text(
          `本 Session 已切换为 ${result.name}（${result.accountId}），浏览器登录态已恢复。` +
            '请重新打开目标业务页面确认身份，不要假设当前页面已经刷新。',
        )
      },
    },
    async execute(args, exec) {
      const sessionId = requireSessionId(exec.agent)
      const result = await service.use(sessionId, args.id, exec.signal)
      return { accountId: result.currentAccountId, name: result.account.name, hasState: result.account.hasState }
    },
  })

  const currentTool = defineTool({
    name: ACCOUNT_TOOL_NAMES.current,
    description: '查询本 Session 正在使用哪个测试账号。只读。返回空表示用户还没有为这个 Session 选择账号。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const result = value as { accountId?: string; name?: string }
        return text(
          result.accountId === undefined
            ? '本 Session 未选择测试账号：浏览器当前登录的是谁就是谁。'
            : `本 Session 正在使用 ${result.name ?? ''}（${result.accountId}）。`,
        )
      },
    },
    async execute(_args, exec) {
      const sessionId = requireSessionId(exec.agent)
      const { currentAccountId } = service.current(sessionId)
      if (currentAccountId === undefined) return {}
      const account = await service.requireAccount(currentAccountId).catch(() => undefined)
      return { accountId: currentAccountId, ...(account === undefined ? {} : { name: account.name }) }
    },
  })

  const definitions = [listTool, useTool, currentTool]
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `test-account: ${definition.name} tool`)
  }
}
