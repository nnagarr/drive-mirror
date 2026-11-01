import type { JSX } from 'react'

/** A reusable confirmation dialog: title, consequence list, Cancel, and a
 * destructive action. Initial focus is on Cancel; Escape cancels and focus
 * returns to the trigger. */
interface DialogProps {
  title: string
  consequence: string
  actionLabel: string
  onCancel: () => void
  onConfirm: () => void
  /** When true the destructive action is disabled (e.g. a sync is running). */
  disabled?: boolean
}

export function Dialog({ title, consequence, actionLabel, onCancel, onConfirm, disabled }: DialogProps): JSX.Element {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <div className="dialog__panel">
        <header className="dialog__head">
          <h2 id="dialog-title" className="dialog__title">{title}</h2>
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Close
          </button>
        </header>
        <p className="dialog__consequence">{consequence}</p>
        <div className="dialog__actions">
          <button type="button" className="button button--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            disabled={disabled}
            onClick={onConfirm}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
