import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AppSettings } from '../../../main/settings'
import { Dialog } from '../ui/Dialog'

interface AppSettingsTabProps {
  settings: AppSettings
  running: boolean
  onConnectAccount: () => void
  onSaveCredentials: (clientId: string, clientSecret: string) => Promise<{ ok: boolean }>
  onResetConnection: () => Promise<void>
  onSaveSettings: (patch: {
    guardThreshold?: number
    startWithWindows?: boolean
    extraBackupPath?: string | null
  }) => Promise<void>
}

export function AppSettingsTab({
  settings,
  running,
  onConnectAccount,
  onSaveCredentials,
  onResetConnection,
  onSaveSettings,
}: AppSettingsTabProps): JSX.Element {
  const [clientId, setClientId] = useState(settings.clientId)
  const [clientSecret, setClientSecret] = useState('')
  const [guardThreshold, setGuardThreshold] = useState(settings.guardThreshold)
  const [startWithWindows, setStartWithWindows] = useState(settings.startWithWindows)
  const [credentialsChanged, setCredentialsChanged] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => {
    setClientId(settings.clientId)
    setGuardThreshold(settings.guardThreshold)
    setStartWithWindows(settings.startWithWindows)
    setCredentialsChanged(false)
  }, [settings.clientId, settings.guardThreshold, settings.startWithWindows])

  const idChanged = clientId.trim() !== settings.clientId.trim()
  const secretRequired = idChanged && !settings.clientSecretSet
  const saveCredentialsDisabled =
    running ||
    !clientId.trim() ||
    (secretRequired && !clientSecret.trim()) ||
    (!idChanged && !clientSecret.trim())

  async function saveCredentials(): Promise<void> {
    setStatus(null)
    const result = await onSaveCredentials(clientId.trim(), clientSecret.trim())
    if (result.ok) {
      setCredentialsChanged(false)
      setClientSecret('')
      setStatus('Credentials saved.')
    } else {
      setStatus('Could not save credentials.')
    }
  }

  async function saveAppSettings(): Promise<void> {
    setStatus(null)
    try {
      await onSaveSettings({
        guardThreshold: Math.max(1, Math.floor(guardThreshold)),
        startWithWindows,
        extraBackupPath: null,
      })
      setStatus('Settings saved.')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The settings could not be saved.')
    }
  }

  async function resetConnection(): Promise<void> {
    setConfirmOpen(true)
  }

  return (
    <section className="settings-tab">
      <div className="settings-tab__card">
        <h3 className="settings-tab__section__title">Google app</h3>
        <div className="settings-tab__field">
          <label className="field__label">Client id</label>
          <input
            className="field__input"
            value={clientId}
            spellCheck={false}
            onChange={(event) => {
              setClientId(event.target.value)
              setCredentialsChanged(true)
            }}
            placeholder="1234567890-abcdef.apps.googleusercontent.com"
          />
          <span className="field__hint">
            Your own Google OAuth client id. It identifies this app to Google.
          </span>
        </div>
        <div className="settings-tab__field">
          <label className="field__label">Client secret</label>
          <input
            className="field__input"
            type="password"
            value={clientSecret}
            spellCheck={false}
            onChange={(event) => {
              setClientSecret(event.target.value)
              setCredentialsChanged(true)
            }}
            placeholder={
              settings.clientSecretSet && !idChanged
                ? 'Stored — type to replace it'
                : secretRequired
                  ? 'Required for a new client id'
                  : 'Paste the secret'
            }
          />
          <span className="field__hint">
            Stored encrypted with your Windows account. It is never shown again.
            Changing the client id needs the secret again.
          </span>
        </div>
        <div className="settings-tab__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={saveCredentialsDisabled}
            onClick={saveCredentials}
          >
            Save credentials
          </button>
          <button
            type="button"
            className="button button--sage"
            disabled={credentialsChanged}
            onClick={onConnectAccount}
          >
            Connect an account
          </button>
        </div>
        {status && <p className="settings-tab__status">{status}</p>}
      </div>

      <div className="settings-tab__section">
        <h3 className="settings-tab__section__title">Connection</h3>
        <p className="settings-tab__hint">
          Clearing the connection signs every account out and forgets the client id
          and secret. It does not touch your manifests, your mirrors, your schedules
          or your backups.
        </p>
        <div className="settings-tab__actions">
          <button
            type="button"
            className="button button--quiet settings-tab__danger__button"
            disabled={running}
            onClick={resetConnection}
          >
            Reset the Google connection
          </button>
        </div>
      </div>

      <div className="settings-tab__section">
        <h3 className="settings-tab__section__title">Safety check</h3>
        <p className="settings-tab__hint">
          Protects your Google Drive files against accidental mass deletion if a drive disconnects, files are deleted by mistake, or a folder is wiped out locally.
        </p>
        <div className="settings-tab__field">
          <label className="field__label">Minimum files to activate safety check</label>
          <input
            className="field__input field__input--number"
            type="number"
            min={1}
            value={guardThreshold}
            onChange={(event) => setGuardThreshold(Number(event.target.value))}
          />
          <span className="field__hint">
            If a folder loses more than half (50%) of its files between syncs, the app pauses sync for that folder to prevent deleting them in Google Drive. Folders holding fewer files than this are exempt so regular editing is not interrupted.
          </span>
        </div>
      </div>

      <div className="settings-tab__section">
        <h3 className="settings-tab__section__title">Startup</h3>
        <div className="settings-tab__field settings-tab__field--check">
          <label className="field--inline">
            <input
              type="checkbox"
              checked={startWithWindows}
              onChange={(event) => setStartWithWindows(event.target.checked)}
            />
            <span>Start with Windows</span>
          </label>
          <span className="field__hint">
            The app starts when you sign in, so a schedule runs even when you have not
            opened it.
          </span>
        </div>
      </div>

      <div className="settings-tab__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={running}
          onClick={saveAppSettings}
        >
          Save changes
        </button>
      </div>

      {confirmOpen && (
        <Dialog
          title="Reset the Google connection?"
          consequence="Every account is signed out. The client id and secret are forgotten. Your folders, schedules, history, last-run details and backups are not touched."
          actionLabel="Reset connection"
          disabled={running}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            await onResetConnection()
            setClientId('')
            setClientSecret('')
            setCredentialsChanged(false)
            setStatus('The Google connection has been reset.')
            setConfirmOpen(false)
          }}
        />
      )}
    </section>
  )
}
