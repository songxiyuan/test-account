/**
 * The test-account panel: the list of accounts, the current account for the
 * Session it is rendered in, and every action the Host Remote exposes.
 * @module
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AccountForm } from './AccountForm.tsx'
import {
  callRemote,
  Endpoint,
  shortBytes,
  shortTime,
  type AccountDraft,
  type AccountsSnapshot,
  type AccountView,
} from './contract.ts'

/** Props of the panel body; `sessionId` is a Session-scoped standard prop. */
export interface AccountPanelProps {
  sessionId: string
}

/**
 * Group accounts by their optional site label.
 * @param accounts - accounts to group.
 * @returns group label and members, in first-seen order.
 */
function groupBySite(accounts: readonly AccountView[]): { site: string; accounts: AccountView[] }[] {
  const groups = new Map<string, AccountView[]>()
  for (const account of accounts) {
    const key = account.site ?? '未分组'
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [account])
    else bucket.push(account)
  }
  return [...groups].map(([site, members]) => ({ site, accounts: members }))
}

/**
 * Read a user-facing message off a thrown value.
 * @param error - thrown value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the Session-scoped account panel component.
 * @returns the panel component.
 */
export function createAccountPanel(): (props: AccountPanelProps) => JSX.Element {
  /**
   * One Session's account panel.
   * @param props - the Session this instance belongs to.
   */
  return function AccountPanel({ sessionId }: AccountPanelProps): JSX.Element {
    const [snapshot, setSnapshot] = useState<AccountsSnapshot | undefined>(undefined)
    const [error, setError] = useState<string | undefined>(undefined)
    const [notice, setNotice] = useState<string | undefined>(undefined)
    const [busy, setBusy] = useState<string | undefined>(undefined)
    const [editing, setEditing] = useState<'new' | string | undefined>(undefined)
    const [confirmingDelete, setConfirmingDelete] = useState<string | undefined>(undefined)

    const refresh = useCallback(
      async (signal?: AbortSignal) => {
        try {
          const next = await callRemote<AccountsSnapshot>(Endpoint.list, { sessionId }, signal)
          setSnapshot(next)
          setError(undefined)
        } catch (failure) {
          if (signal?.aborted === true) return
          setError(messageOf(failure))
        }
      },
      [sessionId],
    )

    useEffect(() => {
      const controller = new AbortController()
      void refresh(controller.signal)
      return () => controller.abort()
    }, [refresh])

    /**
     * Run one Remote action under a busy key, then refresh the list.
     * @param key - busy marker (an account id, or a synthetic one).
     * @param action - the Remote call.
     * @param done - success notice.
     */
    const run = useCallback(
      async (key: string, action: () => Promise<unknown>, done: string) => {
        setBusy(key)
        setError(undefined)
        setNotice(undefined)
        try {
          await action()
          setNotice(done)
          await refresh()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(undefined)
        }
      },
      [refresh],
    )

    const groups = useMemo(() => groupBySite(snapshot?.accounts ?? []), [snapshot])
    const currentId = snapshot?.currentAccountId
    const current = snapshot?.accounts.find((account) => account.id === currentId)

    return (
      <div style={styles.root} data-test-account-panel="">
        <header style={styles.header}>
          <div>
            <h2 style={styles.title}>测试账号</h2>
            <p style={styles.subtitle}>
              当前账号：{current === undefined ? '未选择（沿用浏览器现状）' : current.name}
            </p>
          </div>
          <button
            type="button"
            style={{ ...styles.button, ...styles.primary }}
            onClick={() => {
              setNotice(undefined)
              setEditing(editing === 'new' ? undefined : 'new')
            }}
            disabled={busy !== undefined}
          >
            {editing === 'new' ? '收起' : '+ 添加'}
          </button>
        </header>

        {editing === 'new' && (
          <AccountForm
            busy={busy === 'new'}
            onCancel={() => setEditing(undefined)}
            onSubmit={(draft: AccountDraft) => {
              void run(
                'new',
                () =>
                  callRemote(Endpoint.create, {
                    input: {
                      id: draft.id,
                      name: draft.name,
                      ...(draft.site === '' ? {} : { site: draft.site }),
                      ...(draft.tags === ''
                        ? {}
                        : { tags: draft.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '') }),
                    },
                  }),
                `已添加账号 ${draft.name}`,
              ).then(() => setEditing(undefined))
            }}
          />
        )}

        {error !== undefined && <p style={styles.error}>{error}</p>}
        {notice !== undefined && <p style={styles.notice}>{notice}</p>}

        {snapshot === undefined && error === undefined && <p style={styles.empty}>正在读取账号列表…</p>}
        {snapshot !== undefined && snapshot.accounts.length === 0 && (
          <p style={styles.empty}>还没有测试账号。点击「+ 添加」创建第一个。</p>
        )}

        {groups.map((group) => (
          <section key={group.site} style={styles.group}>
            <h3 style={styles.groupTitle}>{group.site}</h3>
            {group.accounts.map((account) => (
              <article
                key={account.id}
                style={{ ...styles.card, ...(account.id === currentId ? styles.cardCurrent : {}) }}
              >
                <div style={styles.cardHead}>
                  <span style={{ ...styles.dot, ...(account.id === currentId ? styles.dotOn : {}) }} />
                  <span style={styles.cardName}>{account.name}</span>
                </div>
                <div style={styles.meta}>
                  <code style={styles.code}>{account.id}</code>
                  {(account.tags ?? []).map((tag) => (
                    <span key={tag} style={styles.tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <p style={account.hasState ? styles.stateOn : styles.stateOff}>
                  {account.hasState
                    ? `登录态已保存${account.stateBytes === undefined ? '' : ` · ${shortBytes(account.stateBytes)}`}${
                        account.stateUpdatedAt === undefined ? '' : ` · ${shortTime(account.stateUpdatedAt)}`
                      }`
                    : '登录态未保存'}
                </p>

                {editing === account.id && (
                  <AccountForm
                    account={account}
                    busy={busy === account.id}
                    onCancel={() => setEditing(undefined)}
                    onSubmit={(draft: AccountDraft) => {
                      void run(
                        account.id,
                        () =>
                          callRemote(Endpoint.update, {
                            id: account.id,
                            patch: {
                              name: draft.name,
                              site: draft.site === '' ? null : draft.site,
                              tags:
                                draft.tags === ''
                                  ? null
                                  : draft.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
                            },
                          }),
                        `已更新账号 ${draft.name}`,
                      ).then(() => setEditing(undefined))
                    }}
                  />
                )}

                <div style={styles.actions}>
                  <button
                    type="button"
                    style={{ ...styles.button, ...(account.hasState ? styles.primary : {}) }}
                    disabled={busy !== undefined || !account.hasState}
                    title={account.hasState ? undefined : '先保存登录态才能使用'}
                    onClick={() =>
                      void run(
                        account.id,
                        () => callRemote(Endpoint.use, { sessionId, id: account.id }),
                        `当前 Session 已切换为 ${account.name}`,
                      )
                    }
                  >
                    {busy === account.id ? '处理中…' : '使用账号'}
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    disabled={busy !== undefined}
                    onClick={() =>
                      void run(
                        account.id,
                        () => callRemote(Endpoint.saveState, { sessionId, id: account.id }),
                        `已${account.hasState ? '更新' : '保存'} ${account.name} 的登录态`,
                      )
                    }
                  >
                    {account.hasState ? '更新登录态' : '保存当前登录态'}
                  </button>
                  <button
                    type="button"
                    style={styles.button}
                    disabled={busy !== undefined}
                    onClick={() => setEditing(editing === account.id ? undefined : account.id)}
                  >
                    编辑
                  </button>
                  {confirmingDelete === account.id ? (
                    <button
                      type="button"
                      style={{ ...styles.button, ...styles.danger }}
                      disabled={busy !== undefined}
                      onClick={() =>
                        void run(
                          account.id,
                          () => callRemote(Endpoint.delete, { id: account.id }),
                          `已删除账号 ${account.name}`,
                        ).then(() => setConfirmingDelete(undefined))
                      }
                    >
                      确认删除
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={styles.button}
                      disabled={busy !== undefined}
                      onClick={() => setConfirmingDelete(account.id)}
                    >
                      删除
                    </button>
                  )}
                </div>
              </article>
            ))}
          </section>
        ))}

        {snapshot !== undefined && <p style={styles.footer}>账号目录：{snapshot.root}</p>}
      </div>
    )
  }
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '10px 12px 16px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary)',
    overflowY: 'auto',
    height: '100%',
    boxSizing: 'border-box',
  },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' },
  title: { margin: 0, fontSize: '13px', fontWeight: 600 },
  subtitle: { margin: '2px 0 0', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
  group: { display: 'flex', flexDirection: 'column', gap: '6px' },
  groupTitle: {
    margin: '4px 0 0',
    fontSize: '11px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px 10px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  cardCurrent: { borderColor: 'var(--dsw-alias-brand-primary)' },
  cardHead: { display: 'flex', alignItems: 'center', gap: '6px' },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    border: '1px solid var(--dsw-alias-border-l3)',
    flex: 'none',
  },
  dotOn: { background: 'var(--dsw-alias-state-success-primary)', borderColor: 'transparent' },
  cardName: { fontSize: '12px', fontWeight: 500 },
  meta: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' },
  code: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  tag: {
    padding: '0 5px',
    fontSize: '10px',
    lineHeight: '16px',
    color: 'var(--dsw-alias-label-secondary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '999px',
  },
  stateOn: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-state-success-primary)' },
  stateOff: { margin: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
  actions: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' },
  button: {
    padding: '3px 8px',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-button-tool-bar-fill)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '6px',
    cursor: 'pointer',
  },
  primary: {
    color: 'var(--dsw-alias-label-primary-foreground)',
    background: 'var(--dsw-alias-button-primary-fill)',
    borderColor: 'transparent',
  },
  danger: {
    color: 'var(--dsw-alias-state-error-primary)',
    borderColor: 'var(--dsw-alias-state-error-primary)',
  },
  error: {
    margin: 0,
    padding: '6px 8px',
    fontSize: '11px',
    color: 'var(--dsw-alias-state-error-primary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-state-error-primary)',
    borderRadius: '6px',
    wordBreak: 'break-word',
  },
  notice: {
    margin: 0,
    padding: '6px 8px',
    fontSize: '11px',
    color: 'var(--dsw-alias-state-success-primary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '6px',
  },
  empty: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
  footer: {
    margin: '4px 0 0',
    fontSize: '10px',
    color: 'var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary))',
    wordBreak: 'break-all',
  },
} as const
