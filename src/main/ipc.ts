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
import type { AppSettings, ScheduleConfig } from './settings'
import type { AccountSettings } from './accountSettings'

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
  /** Why it cannot be brought back yet, when there is a reason. */
  blocked?: string
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
  /**
   * Set when the run did not happen because another one was going.
   *
   * A summary that says nothing reads as "everything is up to date", which
   * is the opposite of the truth, so a skipped run says so - and the
   * schedule's clock is not moved, so the slot is caught up.
   */
  skipped?: true
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
  getSettings(): Promise<AppSettings>
  /** An account's settings: its mirrors, its schedule, its notice. */
  getAccountSettings(accountId: string): Promise<AccountSettings>
  /** Save part of an account's settings. */
  saveAccountSettings(
    accountId: string,
    patch: Partial<AccountSettings>,
  ): Promise<AccountSettings>
  /** Which account the app is showing. */
  currentAccountId(): Promise<string | null>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setCredentials(clientId: string, clientSecret: string): Promise<{ ok: boolean }>
  authenticate(): Promise<{ ok: boolean; email?: string }>
  signOut(accountId: string): Promise<void>
  openLogFolder(): Promise<void>
  showManifest(accountId: string): Promise<void>
  /** The app's icon, as a data the interface can show. */
  appIcon(): Promise<string>
  /** Ask the user for a folder to mirror. */
  chooseFolder(): Promise<string | null>
  /** Forget the Google connection: the token, the client id and the secret. */
  resetConnection(): Promise<void>
  /** Archive the manifest and start a new one, for a different account. */
  startFreshManifest(): Promise<void>
  /** Take a new schedule into account, without waiting for a restart. */
  applySchedule(accountId: string): Promise<void>
  /** Start the app with Windows, or stop doing so. */
  applyAutoLaunch(enabled: boolean): void
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
  /**
   * The account a call is for.
   *
   * Every account-scoped call may name the account, and leaves it out to
   * mean the one on screen. An empty id means there is no account, and
   * the call says so rather than acting on the wrong one.
   */
  async function accountOf(named?: string): Promise<string> {
    if (named !== undefined) return named
    return (await deps.currentAccountId()) ?? ''
  }
  // The state is built from the settings every time it is asked for, so a
  // folder the user has just added is in it at once. The preload already
  // hands the renderer a promise.
  ipcMain.handle('drive-mirror:get-state', async (_event, accountId?: string) => {
    return deps.runner.state(await accountOf(accountId))
  })

  ipcMain.handle(
    'drive-mirror:sync-now',
    async (_event, accountId?: string, mirrorName?: string) => {
      try {
        return await deps.runner.syncNow(await accountOf(accountId), mirrorName)
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
    },
  )

  ipcMain.handle(
    'drive-mirror:override-guard',
    async (_event, accountId: string, mirrorName: string) => {
      return deps.runner.syncNow(accountId, mirrorName, { overrideGuard: true })
    },
  )

  ipcMain.handle('drive-mirror:rebase', async (_event, accountId: string, mirrorName: string) => {
    await deps.runner.rebase(accountId, mirrorName)
  })

  ipcMain.handle('drive-mirror:get-settings', () => deps.getSettings())

  ipcMain.handle('drive-mirror:get-account-settings', async (_event, accountId?: string) =>
    deps.getAccountSettings(await accountOf(accountId)),
  )

  ipcMain.handle(
    'drive-mirror:save-account-settings',
    async (_event, accountId: string, patch: Partial<AccountSettings>) => {
      const next = await deps.saveAccountSettings(accountId, patch)
      return next
    },
  )

  ipcMain.handle(
    'drive-mirror:save-settings',
    async (_event, patch: Partial<AppSettings>) => {
      const next = await deps.saveSettings(patch)
      if (patch.startWithWindows !== undefined) {
        deps.applyAutoLaunch(patch.startWithWindows)
      }
      return next
    },
  )

  ipcMain.handle(
    'drive-mirror:set-credentials',
    (_event, clientId: string, clientSecret: string) =>
      deps.setCredentials(clientId, clientSecret),
  )

  ipcMain.handle('drive-mirror:authenticate', () => deps.authenticate())

  ipcMain.handle('drive-mirror:sign-out', async (_event, accountId: string) =>
    await deps.signOut(accountId),
  )

  ipcMain.handle('drive-mirror:open-log-folder', () => deps.openLogFolder())

  ipcMain.handle('drive-mirror:show-manifest', async (_event, accountId: string) => {
    await deps.showManifest(accountId)
  })

  ipcMain.handle('drive-mirror:choose-folder', async () => deps.chooseFolder())

  ipcMain.handle('drive-mirror:app-icon', async () => deps.appIcon())

  ipcMain.handle(
    'drive-mirror:add-mirror',
    async (
      _event,
      accountId: string,
      config: { name: string; root: string; drivePath: string },
    ) => {
      const settings = await deps.getAccountSettings(accountId)
      const problems = validateMirror(config, settings.mirrors)
      if (problems.length > 0) {
        return { ok: false, message: problems.map((p) => p.message).join(' ') }
      }
      // A mirror the user removed and is putting back replaces the old
      // entry. Two entries with the same name would make the app forget
      // the wrong one.
      const kept = settings.mirrors.filter(
        (m) =>
          !(m.removedAt && m.name.toLowerCase() === config.name.toLowerCase()),
      )
      await deps.saveAccountSettings(accountId, {
        mirrors: [...kept, { ...config, enabled: true }],
      })
      return { ok: true }
    },
  )

  ipcMain.handle(
    'drive-mirror:update-mirror',
    async (_event, accountId: string, config: { name: string; drivePath: string }) => {
      const settings = await deps.getAccountSettings(accountId)
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
        const moved = await deps.runner.moveMirrorDestination(
          accountId,
          existing.name,
          config.drivePath,
        )
        if (!moved.ok) return moved
      }
      await deps.saveAccountSettings(accountId, {
        mirrors: settings.mirrors.map((m) =>
          m.name === existing.name ? { ...m, drivePath: config.drivePath } : m,
        ),
      })
      return { ok: true }
    },
  )

  ipcMain.handle('drive-mirror:remove-mirror', async (_event, accountId: string, name: string) => {
    const settings = await deps.getAccountSettings(accountId)
    await deps.saveAccountSettings(accountId, {
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
    async (_event, accountId: string, name: string, enabled: boolean) => {
      const settings = await deps.getAccountSettings(accountId)
      await deps.saveAccountSettings(accountId, {
        mirrors: settings.mirrors.map((m) => (m.name === name ? { ...m, enabled } : m)),
      })
      return { ok: true }
    },
  )

  ipcMain.handle('drive-mirror:get-schedule', async (_event, accountId: string) => {
    const settings = await deps.getAccountSettings(accountId)
    return settings.schedule
  })

  ipcMain.handle(
    'drive-mirror:save-schedule',
    async (_event, accountId: string, patch: Partial<ScheduleConfig>) => {
      const settings = await deps.getAccountSettings(accountId)
      if (patch.shape && !isValidShape(patch.shape)) {
        throw new Error('that schedule cannot be run')
      }
      // The schedule is merged, not replaced: a change to one part of it
      // must not wipe the rest.
      const next = { ...settings.schedule, ...patch }
      await deps.saveAccountSettings(accountId, { schedule: next })
      // The app has to act on the change now, not at the next start-up.
      await deps.applySchedule(accountId)
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
    async (_event, accountId: string, mirror: string, driveFileId: string) => {
      return deps.runner.downloadRestored(accountId, mirror, driveFileId)
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