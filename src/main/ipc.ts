/**
 * The bridge between the interface and the app.
 *
 * The renderer never touches the disk, the network, or Electron itself. It
 * calls a small, fixed set of channels and listens for events. That is what
 * `contextIsolation` and `sandbox` are for, and this file is where the
 * boundary is drawn.
 */

import { ipcMain, shell } from 'electron'
import { validateMirror } from '../core/mirrorConfig'
import { isValidShape } from '../core/schedule'
import type { Report } from '../core/types'
import type { Runner } from './runner'
import type { ScheduleConfig, Settings } from './settings'

/** What the interface shows for one mirror. */
export interface MirrorCard {
  name: string
  localRoot: string
  drivePath: string
  fileCount: number
  lastSyncedAt: string | null
  status: 'idle' | 'syncing' | 'skipped' | 'attention' | 'error'
  /** Whether the mirror takes part in a sync. A paused one is left alone. */
  enabled: boolean
  counts: { uploaded: number; updated: number; downloaded: number; trashed: number; errors: number }
  /** Files the app trashed that the user has since restored on Drive. */
  recovered: RecoveredFile[]
}

/** A file that is waiting to be pulled back down to the disk. */
export interface RecoveredFile {
  /** The Drive file's id. */
  driveFileId: string
  /** The path it had inside the mirror. */
  path: string
  /** When it was restored. */
  at: string
}

/** What a run did. */
export interface RunSummary {
  startedAt: string
  finishedAt: string
  uploaded: number
  updated: number
  downloaded: number
  trashed: number
  errors: number
  mirrors: Array<{ name: string; counts: MirrorCard['counts'] }>
  changed: Array<{ mirror: string; relPath: string; action: string }>
  reports: Report[]
}

/** The whole state of the app. */
export interface AppState {
  mirrors: MirrorCard[]
  running: boolean
  phase: string
  lastRun: RunSummary | null
  accountEmail: string | null
  needsAuth: boolean
}

/** Everything the app tells the interface. */
export type AppEvent =
  | { type: 'state'; state: AppState }
  | { type: 'progress'; mirror: string; relPath: string; phase: string; done: number; total: number }
  | { type: 'finished'; summary: RunSummary }
  | { type: 'guard'; mirror: string; reason: string; message: string; canOverride: boolean }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }

/** What the handlers need from the app. */
export interface IpcDeps {
  runner: Runner
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  setCredentials(clientId: string, clientSecret: string): Promise<{ ok: boolean }>
  authenticate(): Promise<{ ok: boolean; email?: string }>
  signOut(): Promise<void>
  openLogFolder(): Promise<void>
  showManifest(): Promise<void>
  revealSuperseded(): Promise<void>
  pruneSuperseded(): Promise<{ freedBytes: number }>
  /** The app's icon, as a data the interface can show. */
  appIcon(): Promise<string>
  /** Ask the user for a folder to mirror. */
  chooseFolder(): Promise<string | null>
  /** Forget the Google connection: the token, the client id and the secret. */
  resetConnection(): Promise<void>
  /** Archive the manifest and start a new one, for a different account. */
  startFreshManifest(): Promise<void>
  /** Called when the run as a whole fails. */
  onError?: (message: string) => void
}

/**
 * Register every channel.
 *
 * The names are the whole contract with the preload script; the two must
 * agree, and the preload script is the only thing the interface can reach.
 */
export function registerIpc(deps: IpcDeps): void {
  // The state is built from the settings every time it is asked for, so a
  // folder the user has just added is in it at once. The preload already
  // hands the renderer a promise.
  ipcMain.handle('drive-mirror:get-state', async () => await deps.runner.state())

  ipcMain.handle('drive-mirror:sync-now', async (_event, mirrorName?: string) => {
    try {
      return await deps.runner.syncNow(mirrorName)
    } catch (err) {
      // A failure of the run as a whole - not of one file - is reported
      // like any other problem, so the user is told what went wrong
      // instead of seeing a bare error count.
      const message = err instanceof Error ? err.message : String(err)
      deps.onError?.(message)
      return {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        uploaded: 0,
        updated: 0,
        downloaded: 0,
        trashed: 0,
        errors: 1,
        mirrors: [],
        changed: [],
        reports: [{ code: 'anomaly', relPath: '', message }],
      } as RunSummary
    }
  })

  ipcMain.handle('drive-mirror:override-guard', async (_event, mirrorName: string) => {
    return deps.runner.syncNow(mirrorName, { overrideGuard: true })
  })

  ipcMain.handle('drive-mirror:rebase', async (_event, mirrorName: string) => {
    await deps.runner.rebase(mirrorName)
  })

  ipcMain.handle('drive-mirror:get-settings', () => deps.getSettings())

  ipcMain.handle('drive-mirror:save-settings', (_event, patch: Partial<Settings>) =>
    deps.saveSettings(patch),
  )

  ipcMain.handle(
    'drive-mirror:set-credentials',
    (_event, clientId: string, clientSecret: string) =>
      deps.setCredentials(clientId, clientSecret),
  )

  ipcMain.handle('drive-mirror:authenticate', () => deps.authenticate())

  ipcMain.handle('drive-mirror:sign-out', () => deps.signOut())

  ipcMain.handle('drive-mirror:open-log-folder', () => deps.openLogFolder())

  ipcMain.handle('drive-mirror:show-manifest', () => deps.showManifest())

  ipcMain.handle('drive-mirror:reveal-superseded', () => deps.revealSuperseded())

  ipcMain.handle('drive-mirror:prune-superseded', () => deps.pruneSuperseded())

  ipcMain.handle('drive-mirror:choose-folder', async () => deps.chooseFolder())

  ipcMain.handle('drive-mirror:app-icon', async () => deps.appIcon())

  ipcMain.handle(
    'drive-mirror:add-mirror',
    async (_event, config: { name: string; root: string; drivePath: string }) => {
      const settings = await deps.getSettings()
      const problems = validateMirror(config, settings.mirrors)
      if (problems.length > 0) {
        return { ok: false, message: problems.map((p) => p.message).join(' ') }
      }
      await deps.saveSettings({
        mirrors: [...settings.mirrors, { ...config, enabled: true }],
      })
      return { ok: true }
    },
  )

  ipcMain.handle(
    'drive-mirror:update-mirror',
    async (_event, config: { name: string; drivePath: string }) => {
      const settings = await deps.getSettings()
      const existing = settings.mirrors.find((m) => m.name === config.name)
      if (!existing) {
        return { ok: false, message: `There is no mirror called ${config.name}.` }
      }
      // The mirror itself is not a clash with itself.
      const problems = validateMirror(
        { name: existing.name, root: existing.root, drivePath: config.drivePath },
        settings.mirrors.filter((m) => m.name !== existing.name),
      )
      if (problems.length > 0) {
        return { ok: false, message: problems.map((p) => p.message).join(' ') }
      }
      if (existing.drivePath !== config.drivePath) {
        const moved = await deps.runner.moveMirrorDestination(existing.name, config.drivePath)
        if (!moved.ok) return moved
      }
      await deps.saveSettings({
        mirrors: settings.mirrors.map((m) =>
          m.name === existing.name ? { ...m, drivePath: config.drivePath } : m,
        ),
      })
      return { ok: true }
    },
  )

  ipcMain.handle('drive-mirror:remove-mirror', async (_event, name: string) => {
    const settings = await deps.getSettings()
    await deps.saveSettings({
      mirrors: settings.mirrors.map((m) =>
        m.name === name
          ? { ...m, removedAt: new Date().toISOString(), enabled: false }
          : m,
      ),
    })
    return { ok: true }
  })

  ipcMain.handle(
    'drive-mirror:set-mirror-enabled',
    async (_event, name: string, enabled: boolean) => {
      const settings = await deps.getSettings()
      await deps.saveSettings({
        mirrors: settings.mirrors.map((m) => (m.name === name ? { ...m, enabled } : m)),
      })
      return { ok: true }
    },
  )

  ipcMain.handle('drive-mirror:get-schedule', async () => {
    const settings = await deps.getSettings()
    return settings.schedule
  })

  ipcMain.handle(
    'drive-mirror:save-schedule',
    async (_event, patch: Partial<ScheduleConfig>) => {
      const settings = await deps.getSettings()
      if (patch.shape && !isValidShape(patch.shape)) {
        throw new Error('that schedule cannot be run')
      }
      // The schedule is merged, not replaced: a change to one part of it
      // must not wipe the rest.
      const next = { ...settings.schedule, ...patch }
      await deps.saveSettings({ schedule: next })
      return next
    },
  )

  ipcMain.handle('drive-mirror:reset-connection', async () => {
    await deps.resetConnection()
    return { ok: true }
  })

  ipcMain.handle('drive-mirror:start-fresh-manifest', async () => {
    await deps.startFreshManifest()
    return { ok: true }
  })

  ipcMain.handle(
    'drive-mirror:download-restored',
    async (_event, mirror: string, driveFileId: string) => {
      return deps.runner.downloadRestored(mirror, driveFileId)
    },
  )

  // A link the app opens is opened by the operating system, never inside
  // the app window.
  ipcMain.handle('drive-mirror:open-external', async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
    }
  })
}
