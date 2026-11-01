import type { JSX } from 'react'
import type { AccountSummary } from '../../../main/settings'
import { AccountSwitcher } from './AccountSwitcher'
import { Nav } from './Nav'

interface SidebarProps {
  accounts: AccountSummary[]
  currentAccountId: string | null
  view: 'overview' | 'activity' | 'settings'
  activeAccount: AccountSummary | null
  /** Active folder count for "In this account". */
  activeFolderCount: number
  /** Next backup time, when scheduled. */
  nextBackup?: string | null
  onSwitch: (id: string) => void
  onConnect: () => void
  onSelect: (view: 'overview' | 'activity' | 'settings') => void
}

export function Sidebar({
  accounts,
  currentAccountId,
  view,
  activeAccount,
  activeFolderCount,
  nextBackup,
  onSwitch,
  onConnect,
  onSelect,
}: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <AccountSwitcher
        accounts={accounts}
        currentAccountId={currentAccountId}
        onSwitch={onSwitch}
        onConnect={onConnect}
      />
      <Nav view={view} onSelect={onSelect} />
      <div className="sidebar__account">
        <div className="sidebar__account__label">In this account</div>
        <div className="sidebar__account__count">{activeFolderCount} files</div>
        <div className="sidebar__account__count">{activeAccount?.mirrorCount ?? 0} folders</div>
      </div>
      <div className="sidebar__next-backup">
        <div className="sidebar__next-backup__label">Next backup</div>
        <div className="sidebar__next-backup__time">
          {nextBackup ? nextBackup : '—'}
        </div>
      </div>
    </aside>
  )
}
