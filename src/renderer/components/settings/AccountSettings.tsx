import { useState } from 'react'
import type { JSX } from 'react'
import type { AppSettings } from '../../../main/settings'
import type { AccountSettings as AccountSettingsData } from '../../../main/accountSettings'
import { Dialog } from '../ui/Dialog'
import { SchedulePanel } from '../SchedulePanel'

interface AccountSettingsTabProps {
  settings: AppSettings
  accountSettings: AccountSettingsData
  running: boolean
  onConnectAccount: () => void
  onSignIn: () => void
  onSignOut: () => void
  onSaveSchedule: (patch: any) => Promise<void>
  onSyncNow: () => void
  onResetHistory: () => Promise<void>
  onRemoveAccount: () => Promise<void>
}

export function AccountSettingsTab({
  settings,
  accountSettings,
  running,
  onConnectAccount,
  onSignIn,
  onSignOut,
  onSaveSchedule,
  onSyncNow,
  onResetHistory,
  onRemoveAccount,
}: AccountSettingsTabProps): JSX.Element {
  const currentAccount =
    settings.accounts.find((account) => account.id === settings.currentAccountId) ?? null
  const activeFolderCount = accountSettings.mirrors.filter((m) => !m.removedAt).length
  const [confirmOpen, setConfirmOpen] = useState<'history' | 'account' | null>(null)
  const [confirmEmail, setConfirmEmail] = useState('')

  const account = currentAccount

  if (!settings.accounts || settings.accounts.length === 0) {
    return (
      <section className="settings-tab">
        <div className="settings-tab__card">
          <h3 className="settings-tab__section__title">No account connected</h3>
          <p className="settings-tab__hint">
            The app needs a Google account before it can back anything up. Connect
            your Google account to get started.
          </p>
          <div className="settings-tab__actions">
            <button type="button" className="button button--primary" onClick={onConnectAccount}>
              Connect an account
            </button>
          </div>
        </div>
      </section>
    )
  }

  if (settings.currentAccountId === null) {
    return (
      <section className="settings-tab">
        <div className="settings-tab__card">
          <h3 className="settings-tab__section__title">No account selected</h3>
          <p className="settings-tab__hint">
            The app remembers more than one account. Pick one to see its folders,
            or connect a new one.
          </p>
          <div className="settings-tab__actions">
            <button type="button" className="button button--primary" onClick={onConnectAccount}>
              Choose an account
            </button>
            <button type="button" className="button button--sage" onClick={onConnectAccount}>
              Connect another account
            </button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="settings-tab">
      <div className="settings-tab__card">
        <div className="settings-tab__account">
          <span className="settings-tab__avatar" aria-hidden="true">
            {account?.email?.charAt(0).toUpperCase() ?? 'G'}
          </span>
          <div>
            <div className="settings-tab__email">{account?.email}</div>
            <div className="settings-tab__meta">
              {account?.signedIn ? 'Signed in' : 'Signed out'} · {activeFolderCount} folder{activeFolderCount === 1 ? '' : 's'}
            </div>
          </div>
          <div className="settings-tab__account-actions">
            {!account?.signedIn && (
              <button type="button" className="button button--sage" disabled={running} onClick={onSignIn}>
                Sign in
              </button>
            )}
            {account?.signedIn && (
              <button type="button" className="button button--quiet" disabled={running} onClick={onSignOut}>
                Sign out
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="settings-tab__section">
        <h3 className="settings-tab__section__title">Schedule</h3>
        <SchedulePanel
          schedule={accountSettings.schedule}
          onSave={onSaveSchedule}
          onRunNow={onSyncNow}
        />
        <p className="settings-tab__hint">
          {accountSettings.schedule.enabled ? 'The schedule runs on its own.' : 'Sync only when you ask.'}
        </p>
      </div>

      <div className="settings-tab__section settings-tab__danger">
        <h3 className="settings-tab__section__title">Danger zone</h3>
        <p className="settings-tab__hint">
          Resetting the history archives the old sync record and begins again. The copy
          in your Drive is not touched. Removing the account deletes its folder, its
          schedule, its history and its Windows task; your files stay where they are.
        </p>
        <div className="settings-tab__actions">
          <button
            type="button"
            className="button button--quiet settings-tab__danger__button"
            disabled={running}
            onClick={() => setConfirmOpen('history')}
          >
            Reset this account's history
          </button>
          <button
            type="button"
            className="button button--danger"
            disabled={running}
            onClick={() => setConfirmOpen('account')}
          >
            Remove this account
          </button>
        </div>
      </div>

      {confirmOpen === 'history' && (
        <Dialog
          title="Reset this account's history?"
          consequence="The current record is archived and a new one begins. The last-run details are cleared. The copy in your Drive is not touched."
          actionLabel="Reset history"
          disabled={running}
          onCancel={() => setConfirmOpen(null)}
          onConfirm={async () => {
            await onResetHistory()
            setConfirmOpen(null)
          }}
        />
      )}

      {confirmOpen === 'account' && (
        <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="remove-account-title">
          <div className="dialog__panel">
            <header className="dialog__head">
              <h2 id="remove-account-title" className="dialog__title">Remove {account?.email}?</h2>
              <button type="button" className="button button--quiet" onClick={() => setConfirmOpen(null)}>
                Close
              </button>
            </header>
            <p className="dialog__consequence">
              This deletes its folder, its schedule, its history, its last-run details,
              copies of its sync record, its log lines and its Windows task. Your files
              stay on this computer and in Google Drive. Nothing on Drive is deleted.
              This cannot be undone.
            </p>
            <div className="field">
              <label className="field__label">Type the email to confirm</label>
              <input
                className="field__input"
                value={confirmEmail}
                onChange={(event) => setConfirmEmail(event.target.value)}
                placeholder={account?.email}
              />
            </div>
            <div className="dialog__actions">
              <button type="button" className="button button--quiet" onClick={() => setConfirmOpen(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--danger"
                disabled={running || confirmEmail.trim().toLowerCase() !== account?.email.trim().toLowerCase()}
                onClick={async () => {
                  await onRemoveAccount()
                  setConfirmOpen(null)
                }}
              >
                Remove account
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
