import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { suggestDrivePath } from '../../core/mirrorConfig'

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

function autoMirrorName(folderPath: string): string {
  const segment = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (/^[A-Za-z]:$/.test(segment)) {
    return `Drive ${segment[0]?.toUpperCase()}`
  }
  return segment.replace(/[<>:"/\\|?*]/g, '-').trim()
}

/**
 * Add a folder to mirror, or change where an existing one lives on Drive.
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
      const base = autoMirrorName(chosen)
      setName(base)
      setDrivePath(suggestDrivePath(base))
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
              disabled={busy || !!mirror}
              onClick={() => void choose()}
            >
              {mirror ? 'The folder on this computer stays the same' : root ? 'Choose a different folder' : 'Choose a folder'}
            </button>
            <span className="field__hint">
              {mirror
                ? 'The local root is fixed when changing a mirror; only the Drive destination can change.'
                : root || 'No folder chosen yet.'}
            </span>
          </div>
        </section>

        {!mirror && root && (
          <section className="dialog__section">
            <span className="field__hint">
              Destination on Google Drive: <strong>{drivePath || name}</strong> (will be created if it does not exist)
            </span>
          </section>
        )}

        {mirror && (
          <section className="dialog__section">
            <h3>Folder in your Drive</h3>
            <label className="field">
              <input
                className="field__input"
                value={drivePath}
                spellCheck={false}
                onChange={(event) => setDrivePath(event.target.value)}
                placeholder="Photos"
              />
              <span className="field__hint">
                Where it lives in your Drive, under My Drive. Changing this moves the folder on Drive.
              </span>
            </label>
          </section>
        )}

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
