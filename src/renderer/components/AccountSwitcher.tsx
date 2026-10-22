import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AccountSummary } from '../../main/settings'

export interface AccountSwitcherProps {
  /** Every account the app knows about. */
  accounts: AccountSummary[]
  /** Which one the app is showing. */
  currentAccountId: string | null
  /** Show a different account. */
  onSwitch: (id: string) => void
  /** Sign in, and make a new account if the address is new. */
  onConnect: () => void
  /** Remove an account: its files, its copies and its place on the list. */
  onRemove: (id: string) => void
  /** The account being removed, while it is being removed. */
  removingId: string | null
}

/**
 * The account switcher.
 *
 * The app is in one account at a time. The button shows which one, and the
 * list holds the others: each with a mark for whether it is signed in, how
 * many folders it mirrors, and a mark when it has something to say.
 */
export function AccountSwitcher({
  accounts,
  currentAccountId,
  onSwitch,
  onConnect,
  onRemove,
  removingId,
}: AccountSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const current = accounts.find((account) => account.id === currentAccountId) ?? null

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onClick = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [open])

  return (
    <div className="switcher" ref={root}>
      <button
        type="button"
        className="switcher__button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="switcher__current">
          {current ? current.email : 'Connect an account'}
        </span>
        <span className="switcher__caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="switcher__list" role="menu">
          {accounts.length === 0 && (
            <p className="switcher__empty">No Google account is connected yet.</p>
          )}

          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              role="menuitem"
              className={
                account.id === currentAccountId
                  ? 'switcher__item switcher__item--current'
                  : 'switcher__item'
              }
              onClick={() => {
                onSwitch(account.id)
                setOpen(false)
              }}
            >
              <span className="switcher__email">{account.email}</span>
              <span className="switcher__meta">
                {account.signedIn ? 'signed in' : 'not signed in'}
                {` · ${account.mirrorCount} ${account.mirrorCount === 1 ? 'folder' : 'folders'}`}
                {account.hasNotice ? ' · has a note' : ''}
              </span>
            </button>
          ))}

          <div className="switcher__divider" />

          <button
            type="button"
            role="menuitem"
            className="switcher__item"
            onClick={() => {
              onConnect()
              setOpen(false)
            }}
          >
            Connect another account
          </button>

          {current && (
            <button
              type="button"
              role="menuitem"
              className="switcher__item switcher__item--danger"
              disabled={removingId === current.id}
              onClick={() => {
                onRemove(current.id)
                setOpen(false)
              }}
            >
              {removingId === current.id ? 'Removing this account…' : 'Remove this account'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
