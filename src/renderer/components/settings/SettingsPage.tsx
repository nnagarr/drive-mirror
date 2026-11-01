import { useState } from 'react'
import type { JSX } from 'react'
import { AccountSettingsTab } from './AccountSettings'
import { AppSettingsTab } from './AppSettings'
import type { UpdateInfo } from '../../../main/updater'

interface SettingsPageProps {
  settings: any
  accountSettings: any
  running: boolean
  updateInfo?: UpdateInfo | null
  onClose: () => void
  onSyncNow: () => void
  onConnectAccount: () => void
  onSignIn: () => void
  onSignOut: () => void
  onSaveSchedule: (patch: any) => Promise<void>
  onResetHistory: () => Promise<void>
  onRemoveAccount: () => Promise<void>
  onSaveCredentials: (clientId: string, clientSecret: string) => Promise<{ ok: boolean }>
  onResetConnection: () => Promise<void>
  onSaveSettings: (patch: {
    guardThreshold?: number
    startWithWindows?: boolean
    extraBackupPath?: string | null
    autoCheckUpdates?: boolean
  }) => Promise<void>
  onCheckForUpdates?: () => Promise<void>
  onDownloadUpdate?: () => Promise<void>
  onInstallUpdate?: () => void
}

export function SettingsPage({
  settings,
  accountSettings,
  running,
  updateInfo,
  onClose,
  onSyncNow,
  onConnectAccount,
  onSignIn,
  onSignOut,
  onSaveSchedule,
  onResetHistory,
  onRemoveAccount,
  onSaveCredentials,
  onResetConnection,
  onSaveSettings,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
}: SettingsPageProps): JSX.Element {
  const [tab, setTab] = useState<'account' | 'app'>('account')

  return (
    <section className="settings-page">
      <header className="settings-page__head">
        <h1 className="settings-page__title">Settings</h1>
        <button type="button" className="button button--quiet" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="settings-page__tabs">
        <button
          type="button"
          className={`settings-page__tab ${tab === 'account' ? 'settings-page__tab--active' : ''}`}
          aria-pressed={tab === 'account'}
          onClick={() => setTab('account')}
        >
          This account
        </button>
        <button
          type="button"
          className={`settings-page__tab ${tab === 'app' ? 'settings-page__tab--active' : ''}`}
          aria-pressed={tab === 'app'}
          onClick={() => setTab('app')}
        >
          This app
        </button>
      </div>

      <div className="settings-page__body">
        {tab === 'account' ? (
          <AccountSettingsTab
            settings={settings}
            accountSettings={accountSettings}
            running={running}
            onConnectAccount={onConnectAccount}
            onSignIn={onSignIn}
            onSignOut={onSignOut}
            onSaveSchedule={onSaveSchedule}
            onSyncNow={onSyncNow}
            onResetHistory={onResetHistory}
            onRemoveAccount={onRemoveAccount}
          />
        ) : (
          <AppSettingsTab
            settings={settings}
            running={running}
            updateInfo={updateInfo}
            onSaveCredentials={onSaveCredentials}
            onConnectAccount={onConnectAccount}
            onResetConnection={onResetConnection}
            onSaveSettings={onSaveSettings}
            onCheckForUpdates={onCheckForUpdates}
            onDownloadUpdate={onDownloadUpdate}
            onInstallUpdate={onInstallUpdate}
          />
        )}
      </div>
    </section>
  )
}
