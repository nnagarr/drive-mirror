import type { JSX } from 'react'
import { count, summaryIsQuiet } from '../format'
import type { RunSummary } from '../../main/ipc'

export interface SummaryBarProps {
  summary: RunSummary | null
  /** Whether the log is expanded. */
  expanded: boolean
  onToggle: () => void
}

/**
 * What the last run did.
 *
 * When nothing changed, the bar says so plainly and stops there. There is
 * no modal, no toast and no sound: a run that found nothing to do is the
 * normal case, and treating it as news trains the user to ignore the
 * moments that matter.
 */
export function SummaryBar({
  summary,
  expanded,
  onToggle,
}: SummaryBarProps): JSX.Element {
  if (!summary) {
    return (
      <section className="summary summary--empty">
        <p className="summary__quiet">No run yet.</p>
      </section>
    )
  }

  const nothing = summaryIsQuiet(summary)

  if (nothing) {
    return (
      <section className="summary summary--empty">
        <p className="summary__quiet">Everything is up to date - no changes.</p>
      </section>
    )
  }

  return (
    <section className="summary">
      <div className="summary__row">
        <Stat label="Uploaded" value={summary.uploaded} tone="up" />
        <Stat label="Updated" value={summary.updated} tone="up" />
        <Stat label="Downloaded" value={summary.downloaded} tone="down" />
        <Stat label="Trashed" value={summary.trashed} tone="trash" />
        <Stat label="Errors" value={summary.errors} tone="error" />
      </div>
      <button type="button" className="button button--quiet summary__toggle" onClick={onToggle}>
        {expanded ? 'Hide the details' : 'Show the details'}
      </button>
    </section>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: string
}): JSX.Element {
  return (
    <span className={`stat stat--${tone}`}>
      <span className="stat__value">{count(value)}</span>
      <span className="stat__label">{label}</span>
    </span>
  )
}
