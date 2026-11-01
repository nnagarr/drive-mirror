import { useState } from 'react'
import type { JSX } from 'react'

interface CredentialsFormProps {
  onSaveAndConnect: (clientId: string, clientSecret: string) => Promise<{ ok: boolean; message?: string }>
  onSkip: () => void
}

export function CredentialsForm({ onSaveAndConnect, onSkip }: CredentialsFormProps): JSX.Element {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(): Promise<void> {
    setBusy(true)
    setStatus(null)
    try {
      const result = await onSaveAndConnect(clientId.trim(), clientSecret.trim())
      if (!result.ok) {
        setStatus(result.message ?? 'The sign-in did not finish. Check the client id and secret.')
        return
      }
      // On success the parent closes onboarding; do not clear typed values
      // here, the parent handles it.
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The sign-in did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-step__title">Paste the client id and secret, then connect.</h2>
      <div className="onboarding-step__field">
        <label className="field__label">Client id</label>
        <input
          className="field__input"
          value={clientId}
          spellCheck={false}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="1234567890-abcdef.apps.googleusercontent.com"
          disabled={busy}
        />
      </div>
      <div className="onboarding-step__field">
        <label className="field__label">Client secret</label>
        <input
          className="field__input"
          type="password"
          value={clientSecret}
          spellCheck={false}
          onChange={(event) => setClientSecret(event.target.value)}
          placeholder="Paste the secret"
          disabled={busy}
        />
      </div>
      {status && <p className="onboarding-step__status">{status}</p>}
      <div className="onboarding-step__actions">
        <button type="button" className="button button--primary" disabled={busy || !clientId.trim() || !clientSecret.trim()} onClick={() => void save()}>
          {busy ? 'Saving...' : 'Save and connect'}
        </button>
        <button type="button" className="button button--quiet" onClick={onSkip}>
          Skip for now
        </button>
      </div>
    </div>
  )
}
