import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { AddMirrorDialog } from './components/AddMirrorDialog'
import { Onboarding } from './components/onboarding/Onboarding'
import { Overview } from './components/overview/Overview'
import { FolderDrawer } from './components/folder/FolderDrawer'
import { ActivityPage } from './components/activity/ActivityPage'
import { SettingsPage } from './components/settings/SettingsPage'
import { TitleBar } from './components/shell/TitleBar'
import { Sidebar } from './components/shell/Sidebar'
import type { AppEvent, AppState, RunSummary } from '../main/ipc'
import type { UpdateInfo } from '../main/updater'
import type { AppSettings } from '../main/settings'
import type { AccountSettings } from '../main/accountSettings'
import { suggestDrivePath } from '../core/mirrorConfig'
import { nextFireAt } from '../core/schedule'
import { formatFriendlyDate } from './format'

function autoMirrorName(folderPath: string): string {
  const segment = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (/^[A-Za-z]:$/.test(segment)) {
    return `Drive ${segment[0]?.toUpperCase()}`
  }
  return segment.replace(/[<>:"/\\|?*]/g, '-').trim()
}

/** The guard the banner is showing. */
interface GuardInfo {
  mirror: string
  reason: string
  message: string
  canOverride: boolean
}

/** The run in progress. */
interface ProgressInfo {
  mirror: string
  relPath: string
  phase: string
  done: number
  total: number
}

/**
 * The app.
 *
 * It holds the state, listens for what the main process says, and lays the
 * window out. It never reaches the disk or the network itself.
 */
export function App(): JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [accountSettings, setAccountSettings] = useState<AccountSettings | null>(null)
  const [guard, setGuard] = useState<GuardInfo | null>(null)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [summary, setSummary] = useState<RunSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Something the user was not there to see. */
  const [notice, setNotice] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  /** The mirror being added, or the one being changed. */
  const [editing, setEditing] = useState<{ name: string; root: string; drivePath: string } | null>(
    null,
  )
  /** Which section is on screen: Overview, Activity or Settings. */
  const [view, setView] = useState<'overview' | 'activity' | 'settings'>('overview')
  /** The folder whose drawer is open, or null. */
  const [drawerFolder, setDrawerFolder] = useState<string | null>(null)
  /** A confirmation dialog waiting for an answer, or null. */
  const [confirm, setConfirm] = useState<{
    kind: 'remove-folder' | 'remove-account' | 'reset-history' | 'reset-connection'
    title: string
    consequence: string
    action: string
    onConfirm: () => Promise<void>
  } | null>(null)
  /** Whether the onboarding checklist is open. */
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  /** The app's icon, shown next to the title. */
  const [icon, setIcon] = useState('')
  /**
   * The account on screen, for the event listener.
   *
   * The listener is set up once, so it cannot see the account through a
   * closed-over value that has gone stale. A ref always holds the latest
   * one.
   */
  const currentAccountRef = useRef<string | null>(null)

  /**
   * Re-read everything the screen shows.
   *
   * Switching, connecting or removing an account changes the app's
   * settings, the account's settings and the state, so all three are read
   * again. Reading only the state would leave the switcher showing the
   * old account.
   */
  const refresh = useCallback(async () => {
    try {
      const [app, account, state] = await Promise.all([
        window.driveMirror.getSettings(),
        window.driveMirror.getAccountSettings(),
        window.driveMirror.getState(),
      ])
      setSettings(app)
      setAccountSettings(account)
      setState(state)
      setSummary(state.lastRun)
      // A problem that happened while nobody was watching is waiting in
      // the account's settings. It is shown once, and then it is cleared.
      if (account.pendingNotice) {
        setNotice(account.pendingNotice.message)
        void window.driveMirror.saveAccountSettings({ pendingNotice: null })
      }
    } catch {
      // The state will be right the next time something happens.
    }
  }, [])

  useEffect(() => {
    const api = window.driveMirror
    if (!api) {
      setError('The app bridge is not available.')
      return
    }

    const off = api.onEvent((event: AppEvent) => {
      // An event from another account is not about what is on screen. A
      // scheduled run of another account happens in the background, and it
      // must not paint over this one's folders.
      const current = currentAccountRef.current
      if (event.accountId !== null && event.accountId !== current) return
      switch (event.type) {
        case 'state':
          setState(event.state)
          setSummary(event.state.lastRun)
          // A banner about a guard that is no longer tripping is stale
          // news. It goes when the mirror it was about is no longer
          // being skipped.
          setGuard((current) => {
            if (!current) return current
            const mirror = event.state.mirrors.find((m) => m.name === current.mirror)
            return mirror && mirror.status === 'skipped' ? current : null
          })
          break
        case 'progress':
          setProgress({
            mirror: event.mirror,
            relPath: event.relPath,
            phase: event.phase,
            done: event.done,
            total: event.total,
          })
          break
        case 'finished':
          setSummary(event.summary)
          setProgress(null)
          break
        case 'guard':
          setGuard({
            mirror: event.mirror,
            reason: event.reason,
            message: event.message,
            canOverride: event.canOverride,
          })
          break
        case 'notice':
          setNotice(event.message)
          break
                case 'error':
          setError(event.message)
          break
        case 'update-status':
          setUpdateInfo(event.status)
          break
      }
    })

    void api.appIcon().then(setIcon).catch(() => undefined)
    void api
      .getSettings()
      .then((loaded) => {
        setSettings(loaded)
        if (!loaded.clientId || !loaded.clientSecretSet) {
          // The app cannot do anything without a client of its own, so
          // the guide to getting one is the first thing a new user sees.
          setOnboardingOpen(true)
        }
      })
      .catch(() => undefined)

    // The state, the account's settings, and the note left by a run the
    // user did not watch.
    void refresh()
    void window.driveMirror.getUpdateStatus().then(setUpdateInfo).catch(() => undefined)

    return off
  }, [refresh])

  const sync = useCallback(async (mirrorName?: unknown) => {
    setError(null)
    const name = typeof mirrorName === 'string' ? mirrorName : undefined
    if (!settings?.clientId || !settings?.clientSecretSet) {
      setOnboardingOpen(true)
      return
    }
    if ((settings?.accounts.length ?? 0) === 0) {
      setError('No Google account is connected. Connect an account first.')
      return
    }
    try {
      const result = await window.driveMirror.syncNow(name)
      setSummary(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The sync could not be started.')
    }
  }, [settings])

  const saveMirror = useCallback(
    async (config: { name: string; root: string; drivePath: string }) => {
      setError(null)
      const isUpdating = Boolean(editing && editing.name)
      const result = isUpdating
        ? await window.driveMirror.updateMirror({ name: editing!.name, drivePath: config.drivePath })
        : await window.driveMirror.addMirror(config)
      if (result.ok) await refresh()
      return result
    },
    [editing, refresh],
  )

  const addFolder = useCallback(async () => {
    setError(null)
    try {
      const chosen = await window.driveMirror.chooseFolder()
      if (!chosen) return
      const name = autoMirrorName(chosen)
      if (!name) return
      const drivePath = suggestDrivePath(name)
      const result = await window.driveMirror.addMirror({
        name,
        root: chosen,
        drivePath,
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The folder could not be added.')
    }
  }, [refresh])

  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      await window.driveMirror.setMirrorEnabled(name, enabled)
      await refresh()
    },
    [refresh],
  )

  const removeMirror = useCallback(
    async (name: string) => {
      const agreed = window.confirm(
        `Remove ${name} from the app?\n\n` +
          'The copy in your Drive is left exactly as it is. The app forgets this ' +
          'mirror in 30 days, and its history goes with it.',
      )
      if (!agreed) return
      await window.driveMirror.removeMirror(name)
      await refresh()
      if (drawerFolder === name) setDrawerFolder(null)
    },
    [refresh, drawerFolder],
  )

  const download = useCallback(
    async (mirrorName: string, driveFileId: string) => {
      setError(null)
      try {
        const result = await window.driveMirror.downloadRestored(mirrorName, driveFileId)
        if (!result.ok) {
          setError(result.message)
          return
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The file could not be brought back.')
      }
    },
    [refresh],
  )

  const mirrors = state?.mirrors ?? []
  currentAccountRef.current = settings?.currentAccountId ?? null

  /**
   * Show a different account.
   *
   * Everything on screen changes with it: the folders, the schedule and
   * the note the other account left behind.
   */
  const switchAccount = useCallback(
    async (id: string) => {
      await window.driveMirror.switchAccount(id)
      await refresh()
    },
    [refresh],
  )

  /** Sign in, and make a new account if the address is new. */
  const connectAccount = useCallback(async () => {
    setError(null)
    if (!settings?.clientId || !settings?.clientSecretSet) {
      setOnboardingOpen(true)
      return
    }
    const result = await window.driveMirror.authenticate()
    if (!result.ok) {
      setError(result.message ?? 'The sign-in did not finish. Nothing was changed.')
      return
    }
    await refresh()
  }, [refresh, settings])

  const nextBackup = useMemo(() => {
    if (!accountSettings?.schedule?.enabled) return null
    if (accountSettings.schedule.nextRunAt) {
      const formatted = formatFriendlyDate(accountSettings.schedule.nextRunAt)
      if (formatted) return formatted
    }
    try {
      const nextDate = nextFireAt(accountSettings.schedule.shape, new Date(), accountSettings.schedule.lastRunAt)
      return formatFriendlyDate(nextDate.toISOString())
    } catch {
      return null
    }
  }, [accountSettings?.schedule])

  return (
    <div className="app">
      <TitleBar
        section={view === 'overview' ? undefined : view === 'activity' ? 'Activity' : 'Settings'}
        icon={icon}
        version={updateInfo?.currentVersion}
      />
      <div className="shell">
        <Sidebar
          accounts={settings?.accounts ?? []}
          currentAccountId={settings?.currentAccountId ?? null}
          view={view}
          activeAccount={settings?.accounts.find((a) => a.id === settings?.currentAccountId) ?? null}
          activeFolderCount={mirrors.reduce((n, m) => n + m.fileCount, 0)}
          nextBackup={nextBackup}
          updateInfo={updateInfo}
          isSyncing={state?.running ?? false}
          onSwitch={(id) => void switchAccount(id)}
          onConnect={() => void connectAccount()}
          onSelect={(next) => void setView(next)}
          onDownloadUpdate={() => void window.driveMirror.downloadUpdate()}
          onInstallUpdate={() => window.driveMirror.installUpdate()}
        />
        <main className="main">
          <div className="main-inner">
            {error && (
              <div className="error" role="alert">
                <span>{error}</span>
                <button type="button" className="button button--quiet" onClick={() => setError(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {notice && (
              <div className="notice" role="status">
                <span>{notice}</span>
                <button type="button" className="button button--quiet" onClick={() => setNotice(null)}>
                  Dismiss
                </button>
              </div>
            )}
            {view === 'overview' && (
              <Overview
                state={state}
                summary={summary}
                guard={guard}
                progress={progress}
                settings={settings}
                onPrimary={() => void sync()}
                onSecondary={() => void sync()}
                onSync={(name) => void sync(name)}
                onEdit={(name) => void setDrawerFolder(name)}
                onViewAll={() => void setView('activity')}
                onSetupCredentials={() => setOnboardingOpen(true)}
                onConnect={() => void connectAccount()}
                onChooseAccount={() => void setView('overview')}
                onSignIn={() => void connectAccount()}
                onAddFolder={() => void addFolder()}
                onPauseResume={(name, enabled) => void setEnabled(name, enabled)}
              />
            )}
            {view === 'activity' && (
              <ActivityPage
                summary={summary}
                running={state?.running ?? false}
                signedOut={state?.needsAuth ?? false}
                onSync={() => void sync()}
              />
            )}
            {view === 'settings' && settings && accountSettings && (
              <SettingsPage
                settings={settings}
                accountSettings={accountSettings}
                running={state?.running ?? false}
                updateInfo={updateInfo}
                onCheckForUpdates={async () => {
                  const next = await window.driveMirror.checkForUpdates()
                  setUpdateInfo(next)
                }}
                onDownloadUpdate={async () => {
                  await window.driveMirror.downloadUpdate()
                }}
                onInstallUpdate={() => {
                  window.driveMirror.installUpdate()
                }}
                onClose={() => void setView('overview')}
                onSyncNow={() => void sync()}
                onConnectAccount={() => void connectAccount()}
                onSignIn={() => void connectAccount()}
                onSignOut={() => {
                  const id = settings.currentAccountId
                  if (id) void window.driveMirror.signOut(id)
                  void refresh()
                }}
                onSaveSchedule={async (patch) => {
                  const id = settings.currentAccountId
                  if (!id) return
                  const next = await window.driveMirror.saveSchedule(patch, id)
                  setAccountSettings((current) =>
                    current ? { ...current, schedule: next } : current,
                  )
                }}
                onResetHistory={async () => {
                  const id = settings.currentAccountId
                  if (!id) return
                  await window.driveMirror.startFreshManifest(id)
                  await refresh()
                }}
                onRemoveAccount={async () => {
                  const id = settings.currentAccountId
                  if (!id) return
                  await window.driveMirror.removeAccount(id)
                  await refresh()
                }}
                onSaveCredentials={async (clientId, clientSecret) => {
                  return window.driveMirror.setCredentials(clientId, clientSecret)
                }}
                onResetConnection={async () => {
                  await window.driveMirror.resetConnection()
                  await refresh()
                }}
                onSaveSettings={async (patch) => {
                  await window.driveMirror.saveSettings(patch)
                  await refresh()
                }}
              />
            )}
          </div>
        </main>
      </div>

      {drawerFolder && (() => {
        const mirror = mirrors.find((m) => m.name === drawerFolder)
        if (!mirror) return null
        const signedOut = state?.needsAuth ?? false
        return (
          <FolderDrawer
            mirror={mirror}
            isSyncing={mirror.status === 'syncing'}
            signedOut={signedOut}
            onClose={() => setDrawerFolder(null)}
            onSync={(name) => void sync(name)}
            onPauseResume={(name, enabled) => void setEnabled(name, enabled)}
            onChangeDrive={() =>
              void setEditing({ name: mirror.name, root: mirror.localRoot, drivePath: mirror.drivePath })
            }
            onRemove={(name) => void removeMirror(name)}
            onDownload={(mirrorName, fileId) => void download(mirrorName, fileId)}
          />
        )
      })()}

      {editing && (
        <AddMirrorDialog
          mirror={
            editing.name
              ? {
                  name: editing.name,
                  root: editing.root,
                  drivePath: editing.drivePath,
                }
              : undefined
          }
          onClose={() => setEditing(null)}
          onSave={saveMirror}
        />
      )}

      {confirm && (
        <div className="confirm" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="dialog__panel">
            <header className="dialog__head">
              <h2 id="confirm-title">{confirm.title}</h2>
              <button type="button" className="button button--quiet" onClick={() => setConfirm(null)}>
                Close
              </button>
            </header>
            <p className="dialog__consequence">{confirm.consequence}</p>
            <div className="dialog__actions">
              <button type="button" className="button button--quiet" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={async () => {
                  await confirm.onConfirm()
                  setConfirm(null)
                }}
              >
                {confirm.action}
              </button>
            </div>
          </div>
        </div>
      )}

      {onboardingOpen && (
        <Onboarding
          onClose={() => setOnboardingOpen(false)}
          onConnectAccount={async () => {
            const result = await window.driveMirror.authenticate()
            if (result.ok) await refresh()
            return result
          }}
          onSaveCredentials={async (clientId, clientSecret) => {
            const result = await window.driveMirror.setCredentials(clientId, clientSecret)
            return result
          }}
          onRefresh={() => void refresh()}
        />
      )}
    </div>
  )
}
