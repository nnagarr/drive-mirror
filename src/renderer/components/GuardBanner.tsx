import type { JSX } from 'react'
import type { RunSummary } from '../../main/ipc'

export interface GuardBannerProps {
  guard: { mirror: string; reason: string; message: string; canOverride: boolean }
  onOverride: (mirror: string) => void
  onRebase: (mirror: string) => void
  onDismiss: () => void
}

/**
 * A guard stopped a mirror.
 *
 * The banner says which folder, what happened, and what the user can do
 * about it. The buttons are deliberately distinct: "Sync anyway" means
 * "I know, do it anyway", and "Re-approve" means "this is a different
 * drive now, and I accept that".
 */
export function GuardBanner({
  guard,
  onOverride,
  onRebase,
  onDismiss,
}: GuardBannerProps): JSX.Element {
  const volumeChanged = guard.reason === 'volume-changed'

  return (
    <section className="guard" role="alert">
      <div className="guard__text">
        <strong className="guard__title">{guard.mirror}: {titleFor(guard.reason)}</strong>
        <p className="guard__message">{guard.message}</p>
      </div>

      <div className="guard__actions">
        {volumeChanged ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => onRebase(guard.mirror)}
          >
            Re-approve this drive
          </button>
        ) : (
          guard.canOverride && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => onOverride(guard.mirror)}
            >
              Sync anyway
            </button>
          )
        )}
        <button type="button" className="button button--quiet" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  )
}

/** The heading for a reason. */
function titleFor(reason: string): string {
  switch (reason) {
    case 'missing-root':
      return 'the folder is not there'
    case 'volume-changed':
      return 'the drive changed'
    case 'count-drop':
      return 'a lot of files disappeared'
    case 'ambiguous-folder':
      return 'more than one folder has this name'
    default:
      return 'the sync was stopped'
  }
}
