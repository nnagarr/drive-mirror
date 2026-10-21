import type { JSX } from 'react'

export interface SetupWizardProps {
  onClose: () => void
  onOpenSettings: () => void
}

/**
 * How to get a Google client id and secret.
 *
 * The app talks to Drive with your own account, using your own OAuth
 * client. There is no service account and no shared drive: the client is
 * the piece that says which app is asking.
 *
 * These are the steps, in the order the Google console wants them in.
 */
export function SetupWizard({ onClose, onOpenSettings }: SetupWizardProps): JSX.Element {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label="How to connect">
      <div className="dialog__panel">
        <header className="dialog__head">
          <h2>Connecting to Google Drive</h2>
          <button type="button" className="button button--quiet" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="dialog__section">
          <p className="wizard__lead">
            Drive Mirror talks to Drive as <strong>you</strong>, with your own Google
            account. To do that it needs an OAuth client of your own — a client id and
            a client secret. Here is how to get one.
          </p>

          <ol className="wizard__steps">
            <li>
              <h3>Create a project</h3>
              <p>
                Open the Google Cloud console and make a project for this app. If you
                already have one, use it.
              </p>
              <button
                type="button"
                className="button button--quiet"
                onClick={() => void window.driveMirror.openExternal('https://console.cloud.google.com/')}
              >
                Open the console
              </button>
            </li>

            <li>
              <h3>Turn on the Drive API</h3>
              <p>
                In the project, open the API library and enable the Google Drive API.
                Without it the app cannot see your files.
              </p>
              <button
                type="button"
                className="button button--quiet"
                onClick={() =>
                  void window.driveMirror.openExternal('https://console.cloud.google.com/apis/library')
                }
              >
                Open the API library
              </button>
            </li>

            <li>
              <h3>Create the client</h3>
              <p>
                Open the credentials page and create an OAuth client id. Choose{' '}
                <strong>Desktop app</strong> — a web client will not work, because the
                app signs in through a short-lived address on your own machine.
              </p>
              <button
                type="button"
                className="button button--quiet"
                onClick={() =>
                  void window.driveMirror.openExternal('https://console.cloud.google.com/apis/credentials')
                }
              >
                Open the credentials page
              </button>
            </li>

            <li>
              <h3>Publish the consent screen</h3>
              <p>
                Set the OAuth consent screen to <strong>In production</strong>. The app
                asks for the full Drive scope, and Google only grants that to an app
                that is in production. Your own account is the only one that needs to
                be listed as a test user, but the screen still has to say In
                production.
              </p>
              <button
                type="button"
                className="button button--quiet"
                onClick={() =>
                  void window.driveMirror.openExternal('https://console.cloud.google.com/apis/consent')
                }
              >
                Open the consent screen
              </button>
            </li>

            <li>
              <h3>Paste the client id and the secret</h3>
              <p>
                Copy the client id and the client secret into the fields in Settings.
                The secret is stored encrypted with your Windows account and is never
                shown again.
              </p>
              <button
                type="button"
                className="button button--quiet"
                onClick={() => {
                  onClose()
                  onOpenSettings()
                }}
              >
                Open Settings
              </button>
            </li>
          </ol>

          <p className="field__hint">
            The client id is not a secret — Google shows it on the consent screen. The
            secret is. Keep it to yourself, and never put it in a repository, a
            screenshot or a chat.
          </p>
        </section>
      </div>
    </div>
  )
}
