import type { JSX } from 'react'
import type { Verdict } from '../../status'

/** The one-sentence answer to "is my stuff safe?", plus a subline and the
 * primary action. Rendered at the top of Overview so it never scrolls away. */
interface VerdictProps {
  verdict: Verdict
  /** Fires the verdict's primary action. */
  onPrimary: () => void
  /** Fires the secondary "Sync now" when there is one (attention/error). */
  onSecondary?: () => void
}

export function Verdict({ verdict, onPrimary, onSecondary }: VerdictProps): JSX.Element {
  const dotClass = `verdict__dot verdict__dot--${verdict.dot}`
  return (
    <section className="verdict" aria-live="polite">
      <span className={dotClass} aria-hidden="true" />
      <div className="verdict__body">
        <h1 className="verdict__sentence">{verdict.sentence}</h1>
        <p className="verdict__subline">{verdict.subline}</p>
      </div>
      <div className="verdict__actions">
        <button type="button" className="button button--primary" onClick={onPrimary}>
          {verdict.action}
        </button>
        {onSecondary && (
          <button type="button" className="button button--sage" onClick={onSecondary}>
            Sync now
          </button>
        )}
      </div>
    </section>
  )
}
