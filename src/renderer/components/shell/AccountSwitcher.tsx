import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AccountSummary } from '../../../main/settings'

export interface AccountSwitcherProps {
  /** Every account the app knows about. */
  accounts: AccountSummary[]
  /** Which one the app is showing. Null when none is on screen. */
  currentAccountId: string | null
  /** Show a different account. */
  onSwitch: (id: string) => void
  /** Sign in, and make a new account if the address is new. */
  onConnect: () => void
  /** Manage accounts in settings. */
  onManage?: () => void
}

export interface AccountSwitcherMeta {
  /** The account's email. */
  email: string
  /** Whether it is signed in. */
  signedIn: boolean
  /** Active folder count. */
  mirrorCount: number
  /** Whether it has a notice waiting. */
  hasNotice: boolean
}

export function AccountSwitcher({
  accounts,
  currentAccountId,
  onSwitch,
  onConnect,
  onManage,
}: AccountSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const current = accounts.find((account) => account.id === currentAccountId) ?? null
  const noAccounts = accounts.length === 0
  const noneCurrent = currentAccountId === null && accounts.length > 0

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
        <span className="switcher__avatar" aria-hidden="true">
          {current ? current.email.charAt(0).toUpperCase() : noAccounts ? 'G' : '?'}
        </span>
        <div className="switcher__info">
          <div className="switcher__text">
            {current ? current.email : noAccounts ? 'Connect an account' : 'Choose an account'}
          </div>
          <div className="switcher__meta">
            {current
              ? `${current.mirrorCount} ${current.mirrorCount === 1 ? 'folder' : 'folders'} · ${
                  current.signedIn ? 'Signed in' : 'Signed out'
                }`
              : noAccounts
                ? 'Connect your Google account'
                : 'Pick an account'}
          </div>
        </div>
        <span className="switcher__caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="switcher__list" role="menu">
          <div className="switcher__header">
            <span className="switcher__header__label">Accounts</span>
            <button
              type="button"
              className="switcher__header__manage"
              onClick={() => {
                setOpen(false)
                onManage?.()
              }}
            >
              Manage
            </button>
          </div>

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
              <span className="switcher__avatar" aria-hidden="true">
                {account.email.charAt(0).toUpperCase()}
              </span>
              <span className="switcher__email">{account.email}</span>
              <span className="switcher__meta">
                {account.signedIn ? 'Signed in' : 'Signed out'}
                {` · ${account.mirrorCount} ${account.mirrorCount === 1 ? 'folder' : 'folders'}`}{' '}
                {account.hasNotice ? ' · Has a note' : ''}
              </span>
              {account.id === currentAccountId && (
                <span className="switcher__check" aria-hidden="true">✓</span>
              )}
            </button>
          ))}

          <div className="switcher__divider" />

          <button
            type="button"
            role="menuitem"
            className="switcher__item switcher__item--connect"
            onClick={() => {
              onConnect()
              setOpen(false)
            }}
          >
            <span className="switcher__avatar" aria-hidden="true">+</span>
            {noneCurrent ? 'Choose an account' : 'Connect another account'}
          </button>
        </div>
      )}
    </div>
  )
}
