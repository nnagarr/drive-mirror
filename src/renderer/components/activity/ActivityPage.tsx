import { useState, type JSX } from 'react'
import type { RunSummary } from '../../../main/ipc'
import { relativeTime, formatLastRunCounts, countWith } from '../../format'
import { ChangedTable } from './ChangedTable'
import { ReportsTable } from './ReportsTable'

interface ActivityPageProps {
  summary: RunSummary | null
  history?: RunSummary[]
  running: boolean
  signedOut: boolean
  onSync: () => void
}

export function ActivityPage({ summary, history = [], running, signedOut, onSync }: ActivityPageProps): JSX.Element {
  const runs = history.length > 0 ? history : (summary ? [summary] : [])
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Bounds-check selectedIndex if runs change
  const activeIndex = selectedIndex < runs.length ? selectedIndex : 0
  const selectedRun = runs[activeIndex] ?? summary
  const hasRun = !!selectedRun

  return (
    <section className="activity">
      <header className="activity__header">
        <div>
          <h1 className="activity__title">Activity</h1>
          <p className="activity__subline">
            <span>{hasRun && runs[0] ? `The most recent run · ${relativeTime(runs[0].finishedAt)}.` : 'No run yet.'}</span>{' '}
            <span className="activity__note">Keeps your last 10 runs across restarts.</span>
          </p>
        </div>
        <button
          type="button"
          className="button button--sage"
          disabled={running || signedOut}
          onClick={onSync}
        >
          Sync now
        </button>
      </header>

      {runs.length > 1 && (
        <div className="activity__history-bar">
          <div className="activity__history-label">Recent runs</div>
          <div className="activity__history-list" role="tablist">
            {runs.map((r, idx) => {
              const isSelected = idx === activeIndex
              const isQuiet =
                r.uploaded === 0 &&
                r.updated === 0 &&
                r.downloaded === 0 &&
                r.trashed === 0 &&
                r.errors === 0
              const badge = r.errors > 0
                ? `${r.errors} errors`
                : r.uploaded > 0
                  ? `${r.uploaded} uploaded`
                  : isQuiet
                    ? 'All up to date'
                    : formatLastRunCounts(r)

              return (
                <button
                  key={`${r.finishedAt}-${idx}`}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  className={`activity__history-item ${isSelected ? 'activity__history-item--active' : ''}`}
                  onClick={() => setSelectedIndex(idx)}
                >
                  <span className="activity__history-time">{relativeTime(r.finishedAt)}</span>
                  <span className="activity__history-badge">{badge}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="activity__summary">
        {!hasRun ? (
          <div className="run-card run-card--empty">
            <h2>No run yet.</h2>
            <p>The first sync will show what changed.</p>
          </div>
        ) : selectedRun.skipped ? (
          <div className="run-card run-card--skipped">
            <h2>This attempt was skipped.</h2>
            <p>Another sync was already going; the schedule will catch up.</p>
          </div>
        ) : (
          <RunCard summary={selectedRun} />
        )}
      </div>

      {hasRun && (
        <>
          <ChangedTable changed={selectedRun.changed} />
          {selectedRun.reports.length > 0 && <ReportsTable reports={selectedRun.reports} />}
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
          ? 'All folders and files were scanned and verified up to date with Google Drive — no changes needed.'
          : `${countWith(summary.uploaded, 'file')} uploaded, ${countWith(summary.updated, 'file')} updated, ${countWith(summary.downloaded, 'file')} downloaded, ${countWith(summary.trashed, 'file')} moved to trash, ${countWith(summary.errors, 'error')}.`}
      </p>
    </div>
  )
}
