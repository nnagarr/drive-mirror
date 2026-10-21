import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { FolderCard } from './components/FolderCard'
import { GuardBanner } from './components/GuardBanner'
import { LogView } from './components/LogView'
import { ProgressPanel } from './components/ProgressPanel'
import { SettingsDialog } from './components/SettingsDialog'
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
        case 'error':
          setError(event.message)
          break
      }
    })

    void api.getState().then(setState).catch(() => setError('The app state could not be read.'))
    void api.getSettings().then(setSettings).catch(() => undefined)

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

  const running = state?.running ?? false
  const mirrors = state?.mirrors ?? []

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
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

      <main className="content">
        <section className="grid">
          {mirrors.map((mirror) => (
            <FolderCard key={mirror.name} mirror={mirror} onSync={(name) => void sync(name)} />
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

      {settingsOpen && settings && (
        <SettingsDialog settings={settings} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}
