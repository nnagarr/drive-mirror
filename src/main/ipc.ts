/**
 * The bridge between the interface and the app.
 *
 * The renderer never touches the disk, the network, or Electron itself. It
 * calls a small, fixed set of channels and listens for events. That is what
 * `contextIsolation` and `sandbox` are for, and this file is where the
 * boundary is drawn.
 */

import { ipcMain, shell } from 'electron'
import type { Report } from '../core/types'
import type { Runner } from './runner'
import type { Settings } from './settings'

/** What the interface shows for one mirror. */
export interface MirrorCard {
  name: string
  localRoot: string
  drivePath: string
  fileCount: number
  lastSyncedAt: string | null
  status: 'idle' | 'syncing' | 'skipped' | 'attention' | 'error'
  counts: { uploaded: number; updated: number; downloaded: number; trashed: number; errors: number }
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
  ipcMain.handle('drive-mirror:get-state', () => deps.runner.state())

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
    void mirrorName
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

  // A link the app opens is opened by the operating system, never inside
  // the app window.
  ipcMain.handle('drive-mirror:open-external', async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
    }
  })
}
