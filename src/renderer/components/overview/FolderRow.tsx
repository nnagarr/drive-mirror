import type { JSX } from 'react'
import type { MirrorCard } from '../../../main/ipc'
import { rowStatus, folderNeedsYou } from '../../status'
import { relativeTime } from '../../format'

/** One folder row: name + path, status dot + label, last sync,
 * file count, and the action column (Review or Change). */
interface FolderRowProps {
  mirror: MirrorCard
  /** Runs (or reviews) this folder now. */
  onSync: (name: string) => void
  /** Opens the drawer to edit this folder. */
  onEdit: (name: string) => void
  /** Resumes or pauses this folder. */
  onPauseResume?: (name: string, enabled: boolean) => void
}

export function FolderRow({ mirror, onSync, onEdit, onPauseResume }: FolderRowProps): JSX.Element {
  const status = rowStatus(mirror)
  const isPaused = !mirror.enabled || status === 'paused'
  const needsYou = folderNeedsYou(mirror)
  const isSyncing = mirror.status === 'syncing'
  const label = isSyncing ? 'Syncing…' : status.charAt(0).toUpperCase() + status.slice(1)
  const note =
    mirror.status === 'skipped'
      ? 'The sync was stopped. Open to review.'
      : mirror.recovered.some((r) => !!r.blocked)
        ? "1 file can't come back yet."
        : mirror.recovered.length > 0
          ? `${mirror.recovered.length} files are waiting to come back.`
          : mirror.counts.errors > 0
            ? `${mirror.counts.errors} files had errors.`
            : undefined

  return (
    <div className="folder-row">
      <div className="folder-row__info">
        <div className="folder-row__name">{mirror.name}</div>
        <div className="folder-row__path">
          {mirror.localRoot} → My Drive/{mirror.drivePath.replace(/^My Drive\//, '')}
        </div>
        {note && <div className="folder-row__note">{note}</div>}
      </div>
      <div className="folder-row__status">
        <span
          className={`status-dot status-dot--${
            status === 'syncing' ? 'syncing' : status === 'error' ? 'error' : needsYou ? 'attention' : isPaused ? 'paused' : 'safe'
          }`}
          aria-hidden="true"
        />
        <span className="status-dot__label">{label}</span>
      </div>
      <div className="folder-row__last-sync">
        {mirror.lastSyncedAt ? `Last synced ${relativeTime(mirror.lastSyncedAt)}` : 'Not synced yet'}
      </div>
      <div className="folder-row__file-count">{mirror.fileCount.toLocaleString()} files</div>
      <div className="folder-row__action">
        <button
          type="button"
          className={`button ${needsYou || isSyncing ? 'button--danger' : isPaused ? 'button--primary' : 'button--sage'}`}
          onClick={() => {
            if (isPaused) {
              if (onPauseResume) {
                onPauseResume(mirror.name, true)
              } else {
                onSync(mirror.name)
              }
            } else {
              onSync(mirror.name)
            }
          }}
          disabled={isSyncing}
        >
          {isSyncing ? 'Syncing…' : needsYou ? 'Review' : isPaused ? 'Resume' : 'Sync this folder'}
        </button>
        <button type="button" className="button button--quiet" onClick={() => void onEdit(mirror.name)}>
          Change
        </button>
      </div>
    </div>
  )
}
