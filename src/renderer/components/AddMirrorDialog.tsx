import { useEffect, useState } from 'react'
import type { JSX } from 'react'

export interface AddMirrorDialogProps {
  /** The mirror being edited, or null when a new one is being added. */
  mirror?: { name: string; root: string; drivePath: string }
  onClose: () => void
  onSave: (config: {
    name: string
    root: string
    drivePath: string
  }) => Promise<{ ok: true } | { ok: false; message: string }>
}

/**
 * Add a folder to mirror, or change where an existing one lives on Drive.
 *
 * The name is what the app calls the mirror. The Drive folder is where it
 * lives in your Drive, and it defaults to the same name under My Drive.
 */
export function AddMirrorDialog({
  mirror,
  onClose,
  onSave,
}: AddMirrorDialogProps): JSX.Element {
  const [root, setRoot] = useState(mirror?.root ?? '')
  const [name, setName] = useState(mirror?.name ?? '')
  const [drivePath, setDrivePath] = useState(mirror?.drivePath ?? '')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function choose(): Promise<void> {
    try {
      const chosen = await window.driveMirror.chooseFolder()
      if (!chosen) return
      setRoot(chosen)
      // The name and the Drive folder start as the folder's own name, but
      // only if the user has not typed one already.
      if (!name) {
        const base = chosen.split(/[\\/]/).filter(Boolean).pop() ?? ''
        setName(base)
        setDrivePath(base)
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The folder could not be chosen.')
    }
  }

  async function save(): Promise<void> {
    setBusy(true)
    setStatus('')
    try {
      const result = await onSave({
        name: name.trim(),
        root,
        drivePath: drivePath.trim(),
      })
      if (!result.ok) {
        setStatus(result.message)
        return
      }
      onClose()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The mirror could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Add a folder">
      <div className="dialog__panel">
        <header className="dialog__head">
          <h2>{mirror ? 'Change this mirror' : 'Mirror a folder'}</h2>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="dialog__section">
          <h3>The folder on this computer</h3>
          <div className="dialog__row">
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => void choose()}
            >
              {root ? 'Choose a different folder' : 'Choose a folder'}
            </button>
            <span className="field__hint">{root || 'No folder chosen yet.'}</span>
          </div>
        </section>

        <section className="dialog__section">
          <h3>What to call it</h3>
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="field__input"
              value={name}
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              placeholder="Photos"
            />
            <span className="field__hint">
              The name the app uses for this mirror. It has to be different from every
              other mirror.
            </span>
          </label>

          <label className="field">
            <span className="field__label">Folder in your Drive</span>
            <input
              className="field__input"
              value={drivePath}
              spellCheck={false}
              onChange={(event) => setDrivePath(event.target.value)}
              placeholder="Photos"
            />
            <span className="field__hint">
              Where it lives in your Drive, under My Drive. You can put it in a
              subfolder, such as <code>Archive/Photos</code>. Changing this later moves
              the folder on Drive rather than copying it.
            </span>
          </label>
        </section>

        {status && <p className="dialog__status">{status}</p>}

        <div className="dialog__row">
          <button
            type="button"
            className="button button--primary"
            disabled={busy || !root || !name.trim() || !drivePath.trim()}
            onClick={() => void save()}
          >
            {busy ? 'Saving...' : mirror ? 'Save the change' : 'Add this folder'}
          </button>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
