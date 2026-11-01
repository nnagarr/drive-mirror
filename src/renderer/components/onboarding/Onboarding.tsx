import { useState } from 'react'
import type { JSX } from 'react'
import { StepRail } from './StepRail'
import { CredentialsForm } from './CredentialsForm'

interface OnboardingProps {
  onClose: () => void
  onConnectAccount: () => Promise<{ ok: boolean; email?: string; message?: string }>
  onSaveCredentials: (clientId: string, clientSecret: string) => Promise<{ ok: boolean; message?: string }>
  onRefresh: () => void
}

const STEP_LINKS: Record<number, { url: string; label: string } | null> = {
  1: { url: 'https://console.cloud.google.com/', label: 'Open the console' },
  2: { url: 'https://console.cloud.google.com/apis/library', label: 'Open the API library' },
  3: { url: 'https://console.cloud.google.com/apis/credentials', label: 'Open the credentials page' },
  4: { url: 'https://console.cloud.google.com/apis/consent', label: 'Open the consent screen' },
  5: null,
}

const STEP_COPY: Record<number, { title: string; body: string; callout?: string; done: boolean }> = {
  1: {
    title: 'Create a Google Cloud project.',
    body: 'The app talks to Drive as you, with your own Google account. Open the Google Cloud console and create a new project.',
    done: true,
  },
  2: {
    title: 'Turn on the Drive API.',
    body: 'Open the API library and enable the Google Drive API for your project.',
    done: true,
  },
  3: {
    title: 'Create a Desktop OAuth client.',
    body: 'Open the credentials page and create an OAuth client of type Desktop app. A web client will not work.',
    done: true,
  },
  4: {
    title: 'Publish the consent screen.',
    body: 'Open the consent screen and click "Publish App" to set its status to In production.',
    callout: 'If left in "Testing" mode, Google automatically expires your authorization token every 7 days. This will break your background syncs and force you to sign in again every week. Setting it to "In production" keeps your sign-in active permanently. (You do not need Google verification since only your own account is using it).',
    done: true,
  },
  5: {
    title: 'Paste the client id and secret, then connect.',
    body: 'Paste the client id and secret from the Google console, then save and connect.',
    done: true,
  },
}

export function Onboarding({ onClose, onConnectAccount, onSaveCredentials, onRefresh }: OnboardingProps): JSX.Element {
  const [current, setCurrent] = useState(1)
  const [done, setDone] = useState<Set<number>>(new Set())

  function markDone(step: number): void {
    setDone((prev) => {
      const next = new Set(prev)
      next.add(step)
      return next
    })
  }

  return (
    <div className="onboarding">
      <StepRail current={current} done={done} onSelect={setCurrent} />
      <div className="onboarding-content">
        <div className="onboarding-top-bar">
          <button
            type="button"
            className="button button--quiet onboarding-close-btn"
            onClick={onClose}
          >
            Skip setup
          </button>
        </div>
        <div className="onboarding-step">
          <h2 className="onboarding-step__title">{STEP_COPY[current]?.title ?? ''}</h2>
          <p className="onboarding-step__body">{STEP_COPY[current]?.body ?? ''}</p>
          {STEP_COPY[current]?.callout && (
            <div className="onboarding-step__callout">
              <strong>Why this is required: </strong>
              {STEP_COPY[current]!.callout}
            </div>
          )}
          {current <= 4 && STEP_LINKS[current] && (
            <>
              <a
                className="onboarding-step__link"
                href={STEP_LINKS[current]!.url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault()
                  void window.driveMirror.openExternal(STEP_LINKS[current]!.url)
                }}
              >
                {STEP_LINKS[current]!.label}
              </a>
              <div className="onboarding-step__nav">
                <button
                  type="button"
                  className="button button--sage"
                  onClick={() => {
                    markDone(current)
                    setCurrent((c) => Math.min(5, c + 1))
                  }}
                >
                  Next
                </button>
                {current === 1 && (
                  <button type="button" className="button button--quiet" onClick={() => setCurrent(5)}>
                    I already have credentials
                  </button>
                )}
                <button
                  type="button"
                  className="button button--quiet onboarding-step__skip"
                  onClick={onClose}
                >
                  Skip for now
                </button>
              </div>
            </>
          )}
          {current === 5 && (
            <CredentialsForm
              onSaveAndConnect={async (clientId, clientSecret) => {
                const result = await onSaveCredentials(clientId, clientSecret)
                if (!result.ok) return result
                const connectResult = await onConnectAccount()
                if (!connectResult.ok) {
                  return { ok: false, message: connectResult.message ?? 'The sign-in did not finish.' }
                }
                onRefresh()
                onClose()
                return { ok: true }
              }}
              onSkip={onClose}
            />
          )}
        </div>
      </div>
    </div>
  )
}
