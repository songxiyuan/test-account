/**
 * Browser half of the test-account plugin.
 *
 * It contributes one right-Sidebar page type ("测试账号"), its body, and a
 * conversation-header shortcut that opens it. All state lives on the Host; this
 * half only calls the `/test-account` Remote channel.
 * @module @dsh-test-account/test-account/client
 */

import { createAccountPanel } from './AccountPanel.tsx'
import type { TestAccountContext } from './contract.ts'

/** The page kind `ctx.sidebarRight.openTab` names. */
export const PANEL_KIND = 'test-account'

/** This implementation's identity in the tab system. */
export const PANEL_ID = '@dsh-test-account/test-account'

/** Client services required before the panel can register. */
export const inject = ['connection', 'slots', 'sidebarRight', 'sidebarRightTabs']

/** Props of a Session-scoped header action; `sessionId` is a standard prop. */
export interface HeaderActionProps {
  sessionId: string
}

/**
 * Register the panel type, its body, and the header shortcut.
 * @param ctx - client root context.
 */
export function apply(ctx: TestAccountContext): void {
  const AccountPanel = createAccountPanel()

  /**
   * Conversation-header shortcut into the account panel.
   * @param props - the Session this header belongs to.
   */
  function OpenAccountPanel({ sessionId }: HeaderActionProps): JSX.Element {
    return (
      <button
        type="button"
        title={`测试账号（Session ${sessionId}）`}
        style={headerButton}
        onClick={() => ctx.sidebarRight.openTab(PANEL_KIND)}
      >
        测试账号
      </button>
    )
  }

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: PANEL_ID,
        kind: PANEL_KIND,
        priority: 'extension',
        title: () => '测试账号',
        guide: [{ order: 20, title: () => '测试账号', description: '保存 / 切换测试账号登录态' }],
      }),
    'test-account: sidebar page type',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, AccountPanel),
      ),
    'test-account: sidebar body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'test-account-open', order: 30 },
          OpenAccountPanel,
        ),
      ),
    'test-account: header shortcut',
  )
}

const headerButton = {
  padding: '2px 8px',
  fontSize: '11px',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '6px',
  cursor: 'pointer',
} as const
