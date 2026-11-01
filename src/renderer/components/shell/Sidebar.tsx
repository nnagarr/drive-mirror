import type { JSX } from 'react'
import type { AccountSummary } from '../../../main/settings'
import type { UpdateInfo } from '../../../main/updater'
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
  /** Current in-app update status. */
  updateInfo?: UpdateInfo | null
  /** Whether sync is active (prevents restarting to install). */
  isSyncing?: boolean
  onSwitch: (id: string) => void
  onConnect: () => void
  onSelect: (view: 'overview' | 'activity' | 'settings') => void
  onDownloadUpdate?: () => void
  onInstallUpdate?: () => void
}

export function Sidebar({
  accounts,
  currentAccountId,
  view,
  activeAccount,
  activeFolderCount,
  nextBackup,
  updateInfo,
  isSyncing,
  onSwitch,
  onConnect,
  onSelect,
  onDownloadUpdate,
  onInstallUpdate,
}: SidebarProps): JSX.Element {
  const hasUpdate =
    updateInfo != null &&
    (updateInfo.status === 'available' ||
      updateInfo.status === 'downloading' ||
      updateInfo.status === 'downloaded')

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <AccountSwitcher
        accounts={accounts}
        currentAccountId={currentAccountId}
        onSwitch={onSwitch}
        onConnect={onConnect}
        onManage={() => onSelect('settings')}
      />
      <Nav view={view} hasUpdate={hasUpdate} onSelect={onSelect} />

      {hasUpdate && (
        <div
          className={`sidebar__update ${updateInfo.status === 'downloaded' ? 'sidebar__update--ready' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div className="sidebar__update__header">
            <span className="sidebar__update__title">
              {updateInfo.status === 'downloaded'
                ? 'Update ready'
                : updateInfo.status === 'downloading'
                  ? 'Downloading update'
                  : 'Update available'}
            </span>
            {updateInfo.availableVersion && (
              <span className="sidebar__update__version">v{updateInfo.availableVersion}</span>
            )}
          </div>

          {updateInfo.status === 'downloading' && (
            <div className="sidebar__update__progress">
              <div
                className="sidebar__update__progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, updateInfo.progress ?? 0))}%` }}
              />
            </div>
          )}

          {updateInfo.status === 'available' && onDownloadUpdate && (
            <button
              type="button"
              className="button button--primary sidebar__update__action"
              onClick={onDownloadUpdate}
            >
              Download
            </button>
          )}

          {updateInfo.status === 'downloaded' && onInstallUpdate && (
            <button
              type="button"
              className="button button--sage sidebar__update__action"
              disabled={isSyncing}
              title={isSyncing ? 'Cannot restart while sync is running' : undefined}
              onClick={onInstallUpdate}
            >
              Restart & Install
            </button>
          )}
        </div>
      )}

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
