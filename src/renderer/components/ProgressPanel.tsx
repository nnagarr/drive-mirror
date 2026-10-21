import type { JSX } from 'react'

export interface ProgressPanelProps {
  /** The folder being worked on. */
  mirror: string
  /** The file being worked on. */
  relPath: string
  /** The phase, e.g. `uploads`. */
  phase: string
  /** How many files are done. */
  done: number
  /** How many files there are. */
  total: number
}

/**
 * What the run is doing right now.
 *
 * The panel only exists while a run is in progress, so it never takes up
 * space when there is nothing to say.
 */
export function ProgressPanel({
  mirror,
  relPath,
  phase,
  done,
  total,
}: ProgressPanelProps): JSX.Element {
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <section className="progress" aria-live="polite">
      <div className="progress__bar">
        <div className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress__row">
        <span className="progress__phase">{phaseLabel(phase)}</span>
        <span className="progress__file" title={relPath}>
          {relPath || mirror}
        </span>
        {total > 0 && (
          <span className="progress__count">
            {done} of {total}
          </span>
        )}
      </div>
    </section>
  )
}

/** The phase, in words. */
function phaseLabel(phase: string): string {
  switch (phase) {
    case 'folders':
      return 'Creating folders'
    case 'uploads':
      return 'Uploading'
    case 'downloads':
      return 'Downloading'
    case 'trashes':
      return 'Moving to the Drive trash'
    default:
      return phase
  }
}
