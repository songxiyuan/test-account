/**
 * Edit form for one test account's metadata. Rendered inline in the panel
 * rather than as a floating dialog so it works in a narrow Sidebar without a
 * z-index seat. Accounts are created by the Agent's `account_save` tool, so this
 * form only ever edits an existing account.
 * @module
 */

import { useEffect, useState } from 'react'
import type { AccountDraft, AccountView } from './contract.ts'

/** Props of {@link AccountForm}. */
export interface AccountFormProps {
  /** Account being edited. */
  account: AccountView
  /** Whether a submit is in flight. */
  busy: boolean
  /** Cancel the form. */
  onCancel: () => void
  /**
   * Submit the draft.
   * @param draft - collected fields.
   */
  onSubmit: (draft: AccountDraft) => void
}

/**
 * Turn a stored account into the editable draft shape.
 * @param account - account being edited.
 * @returns the initial draft.
 */
function draftOf(account: AccountView): AccountDraft {
  return {
    id: account.id,
    name: account.name,
    site: account.site ?? '',
    tags: (account.tags ?? []).join(', '),
  }
}

/**
 * One account's edit form.
 * @param props - form props.
 */
export function AccountForm({ account, busy, onCancel, onSubmit }: AccountFormProps): JSX.Element {
  const [draft, setDraft] = useState<AccountDraft>(() => draftOf(account))

  useEffect(() => {
    setDraft(draftOf(account))
  }, [account])

  const valid = draft.name.trim() !== ''

  return (
    <form
      style={styles.form}
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid || busy) return
        onSubmit({
          id: draft.id,
          name: draft.name.trim(),
          site: draft.site.trim(),
          tags: draft.tags.trim(),
        })
      }}
    >
      <label style={styles.label}>
        <span style={styles.labelText}>名称</span>
        <input
          style={styles.input}
          value={draft.name}
          placeholder="VIP 美国测试账号"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label style={styles.label}>
        <span style={styles.labelText}>ID</span>
        <input style={{ ...styles.input, ...styles.inputDisabled }} value={draft.id} readOnly />
      </label>
      <label style={styles.label}>
        <span style={styles.labelText}>站点</span>
        <input
          style={styles.input}
          value={draft.site}
          placeholder="TeraBox"
          onChange={(event) => setDraft({ ...draft, site: event.target.value })}
        />
      </label>
      <label style={styles.label}>
        <span style={styles.labelText}>标签</span>
        <input
          style={styles.input}
          value={draft.tags}
          placeholder="VIP, US"
          onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
        />
      </label>
      <p style={styles.hint}>只保存在账号表里的身份元数据，不会记录用户名或密码。</p>
      <div style={styles.actions}>
        <button type="submit" style={{ ...styles.button, ...styles.primary }} disabled={!valid || busy}>
          {busy ? '提交中…' : '保存'}
        </button>
        <button type="button" style={styles.button} onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </form>
  )
}

const styles = {
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px',
    margin: '8px 0',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  label: { display: 'flex', flexDirection: 'column', gap: '2px' },
  labelText: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '4px 6px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '6px',
    outline: 'none',
  },
  inputDisabled: { opacity: 0.6 },
  hint: { margin: '2px 0 0', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
  actions: { display: 'flex', gap: '6px', marginTop: '4px' },
  button: {
    padding: '3px 10px',
    fontSize: '12px',
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
} as const
