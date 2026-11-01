import type { JSX } from 'react'
import type { RecoveredFile } from '../../../main/ipc'
import { relativeTime } from '../../format'

/** Files the app trashed that the user has since restored on Drive, waiting
 * to come back. Blocked rows use attention. */
interface RecoveredFilesProps {
  files: RecoveredFile[]
  onBringBack: (driveFileId: string) => void
}

export function RecoveredFiles({ files, onBringBack }: RecoveredFilesProps): JSX.Element {
  const blocked = files.filter((f) => !!f.blocked)
  const free = files.filter((f) => !f.blocked)

  return (
    <section className="recovered" aria-label="Waiting to come back">
      <h3 className="recovered__title">
        {files.length} file{files.length === 1 ? '' : 's'} waiting to come back
      </h3>
      {free.length > 0 && (
        <div className="recovered__group">
          <span className="recovered__group__label">Ready to bring back</span>
          {free.map((file) => (
            <div key={file.driveFileId} className="recovered__row">
              <span className="recovered__path">{file.path}</span>
              <span className="recovered__when">{relativeTime(file.at)}</span>
              <button
                type="button"
                className="button button--sage"
                onClick={() => void onBringBack(file.driveFileId)}
              >
                Bring it back
              </button>
            </div>
          ))}
        </div>
      )}
      {blocked.length > 0 && (
        <div className="recovered__group recovered__group--blocked">
          <span className="recovered__group__label">Blocked</span>
          {blocked.map((file) => (
            <div key={file.driveFileId} className="recovered__row">
              <span className="recovered__path">{file.path}</span>
              <span className="recovered__reason" title={file.blocked}>
                {file.blocked}
              </span>
              <button
                type="button"
                className="button button--quiet"
                disabled
                title={file.blocked}
              >
                Bring it back
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
