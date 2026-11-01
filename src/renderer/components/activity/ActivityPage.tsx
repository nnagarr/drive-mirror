import type { JSX } from 'react'
import type { RunSummary } from '../../../main/ipc'
import { relativeTime, formatLastRunCounts, countWith } from '../../format'
import { ChangedTable } from './ChangedTable'
import { ReportsTable } from './ReportsTable'

interface ActivityPageProps {
  summary: RunSummary | null
  running: boolean
  signedOut: boolean
  onSync: () => void
}

export function ActivityPage({ summary, running, signedOut, onSync }: ActivityPageProps): JSX.Element {
  const run = summary
  const hasRun = !!run

  return (
    <section className="activity">
      <header className="activity__header">
        <h1 className="activity__title">Activity</h1>
        <p className="activity__subline">
          <span>{hasRun ? `The most recent run · ${relativeTime(run.finishedAt)}.` : 'No run yet.'}</span>{' '}
          <span className="activity__note">Kept across restarts; older runs are not kept.</span>
        </p>
        <button
          type="button"
          className="button button--sage"
          disabled={running || signedOut}
          onClick={onSync}
        >
          Sync now
        </button>
      </header>

      <div className="activity__summary">
        {!hasRun ? (
          <div className="run-card run-card--empty">
            <h2>No run yet.</h2>
            <p>The first sync will show what changed.</p>
          </div>
        ) : run.skipped ? (
          <>
            <div className="run-card run-card--skipped">
              <h2>The last attempt was skipped.</h2>
              <p>
                Another sync was already going; the schedule will catch up.
              </p>
            </div>
            {summary && <RunCard summary={summary} />}
          </>
        ) : (
          <RunCard summary={run} />
        )}
      </div>

      {hasRun && (
        <>
          <ChangedTable changed={run.changed} />
          {run.reports.length > 0 && <ReportsTable reports={run.reports} />}
        </>
      )}
    </section>
  )
}

function RunCard({ summary }: { summary: RunSummary }): JSX.Element {
  const totals = formatLastRunCounts({
    uploaded: summary.uploaded,
    updated: summary.updated,
    downloaded: summary.downloaded,
    trashed: summary.trashed,
    errors: summary.errors,
  })
  const quiet =
    summary.uploaded === 0 &&
    summary.updated === 0 &&
    summary.downloaded === 0 &&
    summary.trashed === 0 &&
    summary.errors === 0 &&
    summary.reports.length === 0

  return (
    <div className="run-card">
      <div className="run-card__times">
        <span className="run-card__label">Started</span>{' '}
        <span className="run-card__value">{relativeTime(summary.startedAt)}</span>
      </div>
      <div className="run-card__times">
        <span className="run-card__label">Finished</span>{' '}
        <span className="run-card__value">{relativeTime(summary.finishedAt)}</span>
      </div>
      <div className="run-card__counts">{totals}</div>
      <p className="run-card__note">
        {quiet
          ? 'The last run found nothing to do.'
          : `${countWith(summary.uploaded, 'file')} uploaded, ${countWith(summary.updated, 'file')} updated, ${countWith(summary.downloaded, 'file')} downloaded, ${countWith(summary.trashed, 'file')} moved to trash, ${countWith(summary.errors, 'error')}.`}
      </p>
    </div>
  )
}
