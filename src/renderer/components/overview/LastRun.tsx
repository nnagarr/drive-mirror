import type { JSX } from 'react'
import type { RunSummary } from '../../../main/ipc'
import { relativeTime, formatRunStatus, formatFriendlyDate } from '../../format'

/** The one-line Last run strip at the bottom of Overview. */
interface LastRunProps {
  summary: RunSummary | null
  onViewAll: () => void
}

export function LastRun({ summary, onViewAll }: LastRunProps): JSX.Element {
  if (!summary) {
    return (
      <div className="last-run">
        <span>No run yet.</span>
        <span>The first sync will show what changed.</span>
        <button type="button" className="link" onClick={onViewAll}>
          Sync now
        </button>
      </div>
    )
  }

  const friendly = formatFriendlyDate(summary.finishedAt)
  const relative = relativeTime(summary.finishedAt)
  const when = friendly ? `${friendly} (${relative})` : relative

  const line = formatRunStatus(summary)

  return (
    <div className="last-run">
      <span>Last run {when}</span>
      <span>{line}</span>
      <button type="button" className="link" onClick={onViewAll}>
        View all
      </button>
    </div>
  )
}
