import type { JSX } from 'react'

/** The empty state shown when there are no accounts, no folders, or no run. */
interface EmptyStateProps {
  kind: 'no-credentials' | 'no-accounts' | 'no-account-on-screen' | 'no-folders' | 'no-run' | 'first-backup' | 'signed-out'
  onSetupCredentials?: () => void
  onConnect: () => void
  onChooseAccount: () => void
  onAddFolder: () => void
  onSignIn: () => void
  onSync: () => void
}

export function EmptyState({
  kind,
  onSetupCredentials,
  onConnect,
  onChooseAccount,
  onAddFolder,
  onSignIn,
  onSync,
}: EmptyStateProps): JSX.Element {
  return (
    <section className="empty" aria-label="Empty state">
      <h2>{heading(kind)}</h2>
      <p>{body(kind)}</p>
      <div className="empty__actions">
        {actions(kind, { onSetupCredentials, onConnect, onChooseAccount, onAddFolder, onSignIn, onSync })}
      </div>
    </section>
  )
}

function heading(kind: EmptyStateProps['kind']): string {
  switch (kind) {
    case 'no-credentials':
      return 'Google app credentials needed'
    case 'no-accounts':
      return 'No Google account is connected'
    case 'no-account-on-screen':
      return 'Choose an account'
    case 'no-folders':
      return 'Nothing is mirrored yet'
    case 'no-run':
      return 'No run yet'
    case 'first-backup':
      return 'Ready for the first backup'
    case 'signed-out':
      return 'This account is signed out'
  }
}

function body(kind: EmptyStateProps['kind']): string {
  switch (kind) {
    case 'no-credentials':
      return 'The app needs your own Google OAuth client id and secret before it can connect and sync.'
    case 'no-accounts':
      return 'Connect your Google account to start mirroring folders to Google Drive.'
    case 'no-account-on-screen':
      return 'Pick an account to see its folders, or connect a new one.'
    case 'no-folders':
      return 'Press Add a folder to mirror a folder on this computer up to your Google Drive.'
    case 'no-run':
      return 'The first sync will show what changed.'
    case 'first-backup':
      return 'Your folders are set up. The first sync will copy them to Drive.'
    case 'signed-out':
      return 'Sign in to resume. Your folders and history are safe.'
  }
}

function actions(
  kind: EmptyStateProps['kind'],
  handlers: { onSetupCredentials?: () => void; onConnect: () => void; onChooseAccount: () => void; onAddFolder: () => void; onSignIn: () => void; onSync: () => void },
): JSX.Element | null {
  const { onSetupCredentials, onConnect, onChooseAccount, onAddFolder, onSignIn, onSync } = handlers
  switch (kind) {
    case 'no-credentials':
      return (
        <button type="button" className="button button--primary" onClick={onSetupCredentials ?? onConnect}>
          Set up Google app
        </button>
      )
    case 'no-accounts':
      return (
        <button type="button" className="button button--primary" onClick={onConnect}>
          Connect account
        </button>
      )
    case 'no-account-on-screen':
      return (
        <>
          <button type="button" className="button button--primary" onClick={onChooseAccount}>
            Choose account
          </button>
          <button type="button" className="button button--sage" onClick={onConnect}>
            Connect another account
          </button>
        </>
      )
    case 'no-folders':
      return <button type="button" className="button button--primary" onClick={onAddFolder}>Add a folder</button>
    case 'no-run':
      return <button type="button" className="button button--primary" onClick={() => onSync()}>Sync now</button>
    case 'first-backup':
      return <button type="button" className="button button--primary" onClick={() => onSync()}>Sync now</button>
    case 'signed-out':
      return <button type="button" className="button button--primary" onClick={onSignIn}>Sign in</button>
  }
}
