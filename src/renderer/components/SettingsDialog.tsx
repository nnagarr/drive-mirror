import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Settings } from '../../main/settings'

export interface SettingsDialogProps {
  settings: Settings
  onClose: () => void
}

/**
 * The settings.
 *
 * The client secret is write-only. It is sent to the main process, which
 * encrypts it, and it is never read back into this window - the field
 * starts empty every time, and shows a placeholder instead of the stored
 * value. There is no code path that could put it on the screen.
 */
export function SettingsDialog({ settings, onClose }: SettingsDialogProps): JSX.Element {
  const [clientId, setClientId] = useState(settings.clientId)
  const [clientSecret, setClientSecret] = useState('')
  const [guardThreshold, setGuardThreshold] = useState(settings.guardThreshold)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save(): Promise<void> {
    setBusy(true)
    setStatus(null)
    try {
      if (clientSecret.length > 0) {
        const result = await window.driveMirror.setCredentials(clientId, clientSecret)
        if (!result.ok) {
          setStatus('The secret could not be stored. Nothing was written.')
          return
        }
        setClientSecret('')
      }
      await window.driveMirror.saveSettings({
        clientId,
        guardThreshold: Math.max(1, Math.floor(guardThreshold)),
      })
      setStatus('Saved.')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The settings could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  async function test(): Promise<void> {
    setBusy(true)
    setStatus('Testing...')
    try {
      const result = await window.driveMirror.authenticate()
      setStatus(
        result.ok
          ? 'The connection works.'
          : 'The connection could not be made. Check the client id and secret.',
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The connection could not be tested.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="dialog__panel">
        <header className="dialog__head">
          <h2>Settings</h2>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="dialog__section">
          <h3>Google sign-in</h3>
          <label className="field">
            <span className="field__label">Client id</span>
            <input
              className="field__input"
              value={clientId}
              spellCheck={false}
              onChange={(event) => setClientId(event.target.value)}
              placeholder="1234567890-abcdef.apps.googleusercontent.com"
            />
          </label>
          <label className="field">
            <span className="field__label">Client secret</span>
            <input
              className="field__input"
              type="password"
              value={clientSecret}
              spellCheck={false}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder={
                settings.clientSecretSet ? 'Stored - type to replace it' : 'Paste the secret'
              }
            />
            <span className="field__hint">
              Stored encrypted with your Windows account. It is never shown again.
            </span>
          </label>
          <div className="dialog__row">
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => void test()}
            >
              Test connection
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </section>

        <section className="dialog__section">
          <h3>Where things are kept</h3>
          <dl className="field__paths">
            <div>
              <dt>Manifest</dt>
              <dd>{settings.manifestPath}</dd>
            </div>
            <div>
              <dt>Backup</dt>
              <dd>{settings.backupPaths.join(', ')}</dd>
            </div>
            <div>
              <dt>Superseded copies</dt>
              <dd>{settings.supersededPath}</dd>
            </div>
          </dl>
        </section>

        <section className="dialog__section">
          <h3>The guard</h3>
          <label className="field">
            <span className="field__label">Minimum files before the guard applies</span>
            <input
              className="field__input field__input--number"
              type="number"
              min={1}
              value={guardThreshold}
              onChange={(event) => setGuardThreshold(Number(event.target.value))}
            />
            <span className="field__hint">
              A folder that loses more than half its files stops the sync, unless it held
              fewer than this many files.
            </span>
          </label>
        </section>

        {status && <p className="dialog__status">{status}</p>}
      </div>
    </div>
  )
}
