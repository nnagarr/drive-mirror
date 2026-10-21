import type { JSX } from 'react'
import type { RunSummary } from '../../main/ipc'

export interface LogViewProps {
  summary: RunSummary | null
}

/**
 * The detail of the last run, grouped by folder.
 *
 * The changed files come first, because they are what the user was
 * waiting to see. The reports come after: they are the paths the app
 * deliberately left alone, and the reason why.
 */
export function LogView({ summary }: LogViewProps): JSX.Element | null {
  if (!summary) return null

  const mirrors = new Set<string>()
  for (const change of summary.changed) mirrors.add(change.mirror)
  for (const report of summary.reports) mirrors.add(report.relPath.split('/')[0] ?? '')

  if (mirrors.size === 0 && summary.reports.length === 0) {
    return <p className="log__quiet">Nothing was changed and nothing was reported.</p>
  }

  return (
    <div className="log">
      {summary.changed.length > 0 && (
        <section className="log__section">
          <h3 className="log__heading">Changed files</h3>
          <ul className="log__list">
            {summary.changed.map((change, index) => (
              <li key={`${change.mirror}:${change.relPath}:${index}`} className="log__item">
                <span className="log__mirror">{change.mirror}</span>
                <span className="log__path">{change.relPath}</span>
                <span className={`log__action log__action--${change.action}`}>
                  {actionLabel(change.action)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.reports.length > 0 && (
        <section className="log__section">
          <h3 className="log__heading">Left alone, and why</h3>
          <ul className="log__list">
            {summary.reports.map((report, index) => (
              <li key={`${report.relPath}:${index}`} className="log__item">
                <span className="log__path">{report.relPath}</span>
                <span className="log__message">{report.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** The word for what was done to a path. */
function actionLabel(action: string): string {
  switch (action) {
    case 'upload':
      return 'uploaded'
    case 'replace-content':
      return 'updated'
    case 'download':
      return 'downloaded'
    case 'export-native':
      return 'exported'
    case 'trash':
      return 'trashed'
    case 'untrash':
      return 'restored'
    case 'create-folder':
      return 'folder created'
    default:
      return action
  }
}
