/**
 * Model-facing account tools.
 *
 * A human can switch accounts from the panel, but an Agent cannot see that
 * choice unless it can ask — and requirement 5 of the design ("让 Agent 基于指定
 * 身份继续 Browser Use / E2E / 排障") is only satisfied when the Agent can both
 * read and change the identity itself. The tools below are thin adapters over
 * {@link AccountService}, so they share the route's validation, error codes,
 * and Session bookkeeping. The panel no longer creates accounts: `account_save`
 * is the only way in, and it is driven by the Agent after it logs in.
 *
 * They carry no credentials: `account_save` captures the storageState the
 * browser already holds after the Agent typed the login form, and `account_use`
 * restores a previously saved one into the calling Session's own browser.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AccountService } from './accounts.ts'
import type { AccountInput, AccountsSnapshot } from './types.ts'

/** Model-facing tool names, as listed in the design's Phase 5. */
export const ACCOUNT_TOOL_NAMES = {
  list: 'account_list',
  save: 'account_save',
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
    lines.push('还没有任何测试账号。让用户在对话里给出站点、账号与密码，你用浏览器工具登录后用 account_save 保存。')
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
 * Register the account tools in the plugin's fiber.
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

  const saveTool = defineTool({
    name: ACCOUNT_TOOL_NAMES.save,
    description:
      '把一个测试账号登记进账号表，并把它当前浏览器里的登录态（Playwright storageState：cookies 与 localStorage）保存进该账号。' +
      '典型用法：用户在对话里给出网址、账号与密码后，你先用浏览器工具（browser_navigate / browser_type / browser_fill_form / ' +
      'browser_click）完成登录，确认页面已进入登录后状态，再调用本工具并传入 id 与 name（可选 site / tags）。' +
      'id 已存在时更新名称、站点、标签并覆盖登录态；保存成功后本 Session 的当前账号会被标记为该账号。' +
      '本工具不接收也不保存用户名、密码、验证码：凭据只应留在对话与页面输入框里，不要作为参数传进来。',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: '账号 id：小写字母、数字、点、下划线、连字符，最长 64 字符，例如 vip-us',
      },
      name: { type: 'string', required: true, description: '账号显示名称，例如「VIP 美国测试账号」' },
      site: { type: 'string', description: '站点或产品名，用于面板分组，例如 TeraBox' },
      tags: { type: 'array', items: { type: 'string' }, description: '自由标签，例如 ["vip", "us"]' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
          hasState: { type: 'boolean', description: '登录态是否已写入' },
          stateBytes: { type: 'number' },
          stateUpdatedAt: { type: 'string', description: '登录态文件更新时间（ISO）' },
        },
      },
      render: (_args, value) => {
        const result = value as { accountId: string; name: string; hasState: boolean }
        return text(
          `已保存账号 ${result.name}（${result.accountId}），登录态${result.hasState ? '已写入' : '未写入'}。` +
            '本 Session 的当前账号已标记为它。',
        )
      },
    },
    async execute(args, exec) {
      const sessionId = requireSessionId(exec.agent)
      const input: AccountInput = { id: args.id, name: args.name }
      if (args.site !== undefined) input.site = args.site
      if (args.tags !== undefined) input.tags = [...args.tags]
      const view = await service.saveAccount(sessionId, input, exec.signal)
      return {
        accountId: view.id,
        name: view.name,
        hasState: view.hasState,
        ...(view.stateBytes === undefined ? {} : { stateBytes: view.stateBytes }),
        ...(view.stateUpdatedAt === undefined ? {} : { stateUpdatedAt: view.stateUpdatedAt }),
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

  const definitions = [listTool, saveTool, useTool, currentTool]
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `test-account: ${definition.name} tool`)
  }
}
