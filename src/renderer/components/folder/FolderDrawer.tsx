import type { JSX } from 'react'
import type { MirrorCard } from '../../../main/ipc'
import { rowStatus } from '../../status'
import { relativeTime } from '../../format'
import { CountGrid } from './CountGrid'
import { RecoveredFiles } from './RecoveredFiles'

/** The right-side folder drawer. Overlays the rest of the window with a
 * scrim; click outside or Escape closes. Focus is trapped and returns to
 * the row on close. */
interface FolderDrawerProps {
  mirror: MirrorCard
  /** Whether this folder's sync is in flight. */
  isSyncing: boolean
  /** Whether the account is signed out. */
  signedOut: boolean
  onClose: () => void
  onSync: (name: string) => void
  onPauseResume: (name: string, enabled: boolean) => void
  onChangeDrive: (name: string, drivePath: string) => void
  onRemove: (name: string) => void
  onDownload: (mirrorName: string, fileId: string) => void
}

const disabledWhileSyncing = (isSyncing: boolean) => ({
  disabled: isSyncing,
  title: isSyncing ? 'Wait for this sync to finish.' : undefined,
})

export function FolderDrawer({
  mirror,
  isSyncing,
  signedOut,
  onClose,
  onPauseResume,
  onChangeDrive,
  onRemove,
  onDownload,
  onSync,
}: FolderDrawerProps): JSX.Element {
  const status = rowStatus(mirror)
  const paused = !mirror.enabled
  const racingDisabled = isSyncing || signedOut

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <div className="drawer__scrim" aria-hidden="true" onClick={onClose} />
      <div className="drawer__panel">
        <div className="drawer__header">
          <div className="drawer__icon">
            <span className="icon icon--folder" aria-hidden="true" />
          </div>
          <div className="drawer__title-group">
            <h2 id="drawer-title" className="drawer__title">{mirror.name}</h2>
            <span className={`status-dot status-dot--${status === 'error' ? 'error' : status === 'syncing' ? 'syncing' : 'safe'}`} aria-hidden="true" />
            <span className="drawer__status">{status.charAt(0).toUpperCase() + status.slice(1)}</span>
          </div>
          <button type="button" className="button button--quiet" onClick={onClose} aria-label="Close drawer">
            ✕
          </button>
        </div>

        <div className="drawer__body">
          <div className="drawer__section">
            <div className="drawer__section__label">Paths</div>
            <div className="drawer__path-row">
              <span className="drawer__path__kind">On this computer</span>
              <span className="drawer__path__note">This stays the same.</span>
            </div>
            <div className="drawer__path__value">{mirror.localRoot}</div>
            <div className="drawer__path-row">
              <span className="drawer__path__kind">On Drive</span>
              <button
                type="button"
                className="button button--sage"
                {...disabledWhileSyncing(racingDisabled)}
                onClick={() => void onChangeDrive(mirror.name, mirror.drivePath)}
              >
                Change
              </button>
            </div>
            <div className="drawer__path__value">{`My Drive/${mirror.drivePath}`}</div>
            <p className="drawer__hint">
              Changing edits the Drive destination only. The folder on this
              computer stays the same.
            </p>
          </div>

          <div className="drawer__section">
            <div className="drawer__section__label">Facts</div>
            <div className="drawer__fact-row">
              <span className="drawer__fact__label">File count</span>
              <span className="drawer__fact__value">{mirror.fileCount.toLocaleString()}</span>
            </div>
            <div className="drawer__fact-row">
              <span className="drawer__fact__label">Last synced</span>
              <span className="drawer__fact__value">
                {mirror.lastSyncedAt ? relativeTime(mirror.lastSyncedAt) : 'Not synced yet'}
              </span>
            </div>
            <div className="drawer__fact-row">
              <span className="drawer__fact__label">State</span>
              <span className="drawer__fact__value">
                {paused ? 'Paused' : isSyncing ? 'Syncing' : 'Active'}
              </span>
            </div>
          </div>

          {mirror.recovered.length > 0 && (
            <RecoveredFiles files={mirror.recovered} onBringBack={(id) => void onDownload(mirror.name, id)} />
          )}

          <div className="drawer__section">
            <div className="drawer__section__label">Last run</div>
            <CountGrid counts={mirror.counts} />
          </div>

          <div className="drawer__actions">
            {!paused ? (
              <button
                type="button"
                className="button button--primary"
                {...disabledWhileSyncing(racingDisabled)}
                onClick={() => void onSync(mirror.name)}
              >
                {isSyncing ? 'Syncing…' : 'Sync this folder'}
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                {...disabledWhileSyncing(racingDisabled)}
                onClick={() => void onPauseResume(mirror.name, true)}
              >
                Resume
              </button>
            )}
            {!paused && !isSyncing && !signedOut && (
              <button
                type="button"
                className="button button--sage"
                onClick={() => void onPauseResume(mirror.name, false)}
              >
                Pause
              </button>
            )}
            <button
              type="button"
              className="button button--sage"
              {...disabledWhileSyncing(racingDisabled)}
              onClick={() => void onChangeDrive(mirror.name, mirror.drivePath)}
            >
              Change Drive folder
            </button>
            <button type="button" className="button button--danger" onClick={() => void onRemove(mirror.name)}>
              Remove folder
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
