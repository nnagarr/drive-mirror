import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { AddMirrorDialog } from './components/AddMirrorDialog'
import { FolderCard } from './components/FolderCard'
import { GuardBanner } from './components/GuardBanner'
import { LogView } from './components/LogView'
import { ProgressPanel } from './components/ProgressPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { SetupWizard } from './components/SetupWizard'
import { SummaryBar } from './components/SummaryBar'
import type { AppEvent, AppState, RunSummary } from '../main/ipc'
import type { Settings } from '../main/settings'

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
  const [settings, setSettings] = useState<Settings | null>(null)
  const [guard, setGuard] = useState<GuardInfo | null>(null)
  const [progress, setProgress] = useState<ProgressInfo | null>(null)
  const [summary, setSummary] = useState<RunSummary | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Something the user was not there to see. */
  const [notice, setNotice] = useState<string | null>(null)
  /** The mirror being added, or the one being changed. */
  const [editing, setEditing] = useState<{ name: string; root: string; drivePath: string } | null>(
    null,
  )
  const [wizardOpen, setWizardOpen] = useState(false)
  /** The app's icon, shown next to the title. */
  const [icon, setIcon] = useState('')

  const refresh = useCallback(async () => {
    try {
      setState(await window.driveMirror.getState())
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
      }
    })

    void api.getState().then(setState).catch(() => setError('The app state could not be read.'))
    void api.appIcon().then(setIcon).catch(() => undefined)
    void api
      .getSettings()
      .then((loaded) => {
        setSettings(loaded)
        // A problem that happened while nobody was watching is waiting in
        // the settings. It is shown once, and then it is cleared.
        if (loaded.pendingNotice) {
          setNotice(loaded.pendingNotice.message)
          void api.saveSettings({ pendingNotice: null })
        }
      })
      .catch(() => undefined)

    return off
  }, [])

  const sync = useCallback(async (mirrorName?: string) => {
    setError(null)
    try {
      const result = await window.driveMirror.syncNow(mirrorName)
      setSummary(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The sync could not be started.')
    }
  }, [])

  const override = useCallback(async (mirrorName: string) => {
    setGuard(null)
    try {
      const result = await window.driveMirror.overrideGuard(mirrorName)
      setSummary(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The sync could not be started.')
    }
  }, [])

  const rebase = useCallback(async (mirrorName: string) => {
    setGuard(null)
    try {
      await window.driveMirror.rebase(mirrorName)
      await window.driveMirror.syncNow(mirrorName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The drive could not be re-approved.')
    }
  }, [])

  const saveMirror = useCallback(
    async (config: { name: string; root: string; drivePath: string }) => {
      setError(null)
      const result = editing
        ? await window.driveMirror.updateMirror({ name: editing.name, drivePath: config.drivePath })
        : await window.driveMirror.addMirror(config)
      if (result.ok) await refresh()
      return result
    },
    [editing, refresh],
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
    },
    [refresh],
  )

  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      await window.driveMirror.setMirrorEnabled(name, enabled)
      await refresh()
    },
    [refresh],
  )

  const download = useCallback(
    async (mirror: string, driveFileId: string) => {
      setError(null)
      try {
        const result = await window.driveMirror.downloadRestored(mirror, driveFileId)
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

  const running = state?.running ?? false
  const mirrors = state?.mirrors ?? []

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          {icon && <img className="topbar__icon" src={icon} alt="" />}
          <h1 className="topbar__title">Drive Mirror</h1>
          <span className="topbar__account">
            {state?.needsAuth
              ? 'Not signed in'
              : (state?.accountEmail ?? 'Signed in')}
          </span>
        </div>
        <div className="topbar__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setEditing({ name: '', root: '', drivePath: '' })}
          >
            Add a folder
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={running}
            onClick={() => void sync()}
          >
            {running ? 'Syncing...' : 'Sync now'}
          </button>
        </div>
      </header>

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

      <main className="content">
        <section className="grid">
          {mirrors.map((mirror) => (
            <FolderCard
              key={mirror.name}
              mirror={mirror}
              onSync={(name) => void sync(name)}
              onEdit={(name) => {
                const found = mirrors.find((m) => m.name === name)
                setEditing({
                  name,
                  root: found?.localRoot ?? '',
                  drivePath: (found?.drivePath ?? '').replace(/^My Drive\//, ''),
                })
              }}
              onRemove={(name) => void removeMirror(name)}
              onSetEnabled={(name, enabled) => void setEnabled(name, enabled)}
              onDownload={(mirrorName, fileId) => void download(mirrorName, fileId)}
            />
          ))}
        </section>

        {guard && (
          <GuardBanner
            guard={guard}
            onOverride={(name) => void override(name)}
            onRebase={(name) => void rebase(name)}
            onDismiss={() => setGuard(null)}
          />
        )}

        {progress && (
          <ProgressPanel
            mirror={progress.mirror}
            relPath={progress.relPath}
            phase={progress.phase}
            done={progress.done}
            total={progress.total}
          />
        )}

        <section className="summary-area">
          <SummaryBar summary={summary} expanded={logOpen} onToggle={() => setLogOpen(!logOpen)} />
          {logOpen && <LogView summary={summary} />}
        </section>
      </main>

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

      {wizardOpen && (
        <SetupWizard
          onClose={() => setWizardOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onShowSetup={() => {
            setSettingsOpen(false)
            setWizardOpen(true)
          }}
          onScheduleChange={async (patch) => {
            const next = await window.driveMirror.saveSchedule(patch)
            setSettings((current) =>
              current ? { ...current, schedule: next } : current,
            )
          }}
          onSyncNow={() => void sync()}
          onStartFreshManifest={() => {
            void window.driveMirror.startFreshManifest().then(refresh)
          }}
        />
      )}
    </div>
  )
}
