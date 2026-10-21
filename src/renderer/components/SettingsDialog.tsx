import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { SchedulePanel } from './SchedulePanel'
import type { ScheduleConfig, Settings } from '../../main/settings'

export interface SettingsDialogProps {
  settings: Settings
  onClose: () => void
  /** Open the guide to getting a Google client id and secret. */
  onShowSetup: () => void
  /** Save part of the schedule. */
  onScheduleChange: (patch: Partial<ScheduleConfig>) => Promise<void>
  /** Sync everything now. */
  onSyncNow: () => void
  /** Archive the manifest and start a new one, for a different account. */
  onStartFreshManifest: () => void
}

/**
 * The settings.
 *
 * The client secret is write-only. It is sent to the main process, which
 * encrypts it, and it is never read back into this window - the field
 * starts empty every time, and shows a placeholder instead of the stored
 * value. There is no code path that could put it on the screen.
 */
export function SettingsDialog({
  settings,
  onClose,
  onShowSetup,
  onScheduleChange,
  onSyncNow,
  onStartFreshManifest,
}: SettingsDialogProps): JSX.Element {
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

  async function signOut(): Promise<void> {
    setBusy(true)
    setStatus(null)
    try {
      await window.driveMirror.signOut()
      setStatus('Signed out of Google. The client id and secret are still stored.')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The sign-out did not work.')
    } finally {
      setBusy(false)
    }
  }

  async function resetConnection(): Promise<void> {
    const agreed = window.confirm(
      'Clear the Google connection?\n\n' +
        'The sign-in, the client id and the client secret are forgotten. Your ' +
        'manifest, your mirrors, your schedule and your backups are not touched.',
    )
    if (!agreed) return
    setBusy(true)
    setStatus(null)
    try {
      await window.driveMirror.resetConnection()
      setStatus('The connection was cleared. Paste in a new client id and secret.')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The connection was not cleared.')
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
          <p className="field__hint">
            <button
              type="button"
              className="link"
              onClick={onShowSetup}
            >
              How do I get a client id and secret?
            </button>
          </p>
        </section>

        <SchedulePanel
          schedule={settings.schedule}
          onSave={onScheduleChange}
          onRunNow={onSyncNow}
        />

        <section className="dialog__section">
          <h3>The Google connection</h3>
          <p className="field__hint">
            Clearing the connection forgets the sign-in and the client id and secret. It
            does not touch your manifest, your mirrors, your schedule or your backups.
          </p>
          <div className="dialog__row">
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => void signOut()}
            >
              Sign out of Google
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => void resetConnection()}
            >
              Reset the connection
            </button>
          </div>
          <p className="field__hint">
            The manifest belongs to the Google account that made it. If you sign in as
            somebody else, the app stops and says so. Starting a new manifest archives
            the old one and begins again - the old one is kept, so nothing is lost.
          </p>
          <div className="dialog__row">
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => {
                const agreed = window.confirm(
                  'Start a new manifest?\n\n' +
                    'The current manifest is archived and a new one is begun. The ' +
                    'copy in your Drive is not touched.',
                )
                if (agreed) onStartFreshManifest()
              }}
            >
              Start a new manifest
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
              <dt>Backups of the manifest</dt>
              <dd>{settings.backupPaths.join(', ')}</dd>
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
