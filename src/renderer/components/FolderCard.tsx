import type { JSX } from 'react'
import { count, relativeTime } from '../format'
import type { MirrorCard } from '../../main/ipc'

export interface FolderCardProps {
  mirror: MirrorCard
  onSync: (name: string) => void
}

/**
 * One mirrored tree.
 *
 * The card answers the three questions a user actually has: which folder is
 * this, is it up to date, and what happened the last time it ran.
 */
export function FolderCard({ mirror, onSync }: FolderCardProps): JSX.Element {
  const { counts } = mirror
  const busy = mirror.status === 'syncing'

  return (
    <article className={`card card--${mirror.status}`} data-mirror={mirror.name}>
      <header className="card__head">
        <h2 className="card__name">{mirror.name}</h2>
        <span className={`chip chip--${mirror.status}`}>{statusLabel(mirror.status)}</span>
      </header>

      <dl className="card__paths">
        <div>
          <dt>On this computer</dt>
          <dd>{mirror.localRoot || 'not set'}</dd>
        </div>
        <div>
          <dt>On Drive</dt>
          <dd>{mirror.drivePath}</dd>
        </div>
      </dl>

      <div className="card__meta">
        <span className="card__files">{count(mirror.fileCount)} files</span>
        <span className="card__time">last synced {relativeTime(mirror.lastSyncedAt)}</span>
      </div>

      <div className="card__counts">
        <Count label="Up" value={counts.uploaded} tone="up" />
        <Count label="Upd" value={counts.updated} tone="up" />
        <Count label="Down" value={counts.downloaded} tone="down" />
        <Count label="Trash" value={counts.trashed} tone="trash" />
        <Count label="Err" value={counts.errors} tone="error" />
      </div>

      <footer className="card__foot">
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={() => onSync(mirror.name)}
        >
          {busy ? 'Syncing...' : 'Sync this folder'}
        </button>
      </footer>
    </article>
  )
}

function Count({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: string
}): JSX.Element {
  return (
    <span className={`count count--${tone} ${value === 0 ? 'count--zero' : ''}`}>
      <span className="count__value">{value}</span>
      <span className="count__label">{label}</span>
    </span>
  )
}

/** The word on the status chip. */
function statusLabel(status: MirrorCard['status']): string {
  switch (status) {
    case 'syncing':
      return 'Syncing'
    case 'skipped':
      return 'Skipped'
    case 'attention':
      return 'Needs you'
    case 'error':
      return 'Error'
    default:
      return 'Up to date'
  }
}
