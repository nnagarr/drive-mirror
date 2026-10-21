import type { JSX } from 'react'
import { relativeTime } from '../format'
import type { MirrorCard } from '../../main/ipc'

export interface RecoveredPanelProps {
  mirror: MirrorCard
  onDownload: (mirror: string, driveFileId: string) => void
}

/**
 * The files the app trashed that have been restored on Drive.
 *
 * A file the app trashed stays in the Drive trash for thirty days. If the
 * user brings it back, the app knows about it, and can pull it down to the
 * disk again.
 */
export function RecoveredPanel({
  mirror,
  onDownload,
}: RecoveredPanelProps): JSX.Element | null {
  if (mirror.recovered.length === 0) return null

  return (
    <section className="recovered">
      <h3 className="recovered__title">Waiting to be brought back</h3>
      <p className="recovered__hint">
        These were trashed by this app and have been restored in your Drive. Nothing is
        downloaded until you ask for it.
      </p>
      <ul className="recovered__list">
        {mirror.recovered.map((file) => (
          <li key={file.driveFileId} className="recovered__item">
            <span className="recovered__path">{file.path}</span>
            <span className="recovered__when">{relativeTime(file.at)}</span>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => onDownload(mirror.name, file.driveFileId)}
            >
              Download to E:
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
