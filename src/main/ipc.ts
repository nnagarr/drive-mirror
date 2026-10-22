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
import { defaultAccountSettings } from './accountSettings'
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
  | { type: 'state'; accountId: string; state: AppState }
  | { type: 'progress'; accountId: string; mirror: string; relPath: string; phase: string; done: number; total: number }
  | { type: 'finished'; accountId: string; summary: RunSummary }
  | { type: 'guard'; accountId: string; mirror: string; reason: string; message: string; canOverride: boolean }
  | { type: 'notice'; accountId: string | null; message: string }
  | { type: 'error'; accountId: string | null; message: string }

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
  /** Show a different account. */
  switchAccount(accountId: string): Promise<void>
  /** Forget an account: its folder, its task, and its place on the list. */
  forgetAccount(accountId: string): Promise<void>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setCredentials(clientId: string, clientSecret: string): Promise<{ ok: boolean }>
  authenticate(): Promise<{ ok: boolean; email?: string; accountId?: string; message?: string }>
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
  startFreshManifest(accountId: string): Promise<void>
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
   * The account a call is for, or null when there is none.
   *
   * Every account-scoped call may name the account, and leaves it out to
   * mean the one on screen.
   *
   * An empty id, or one the app does not know, is refused here, at the
   * boundary. Further in, a path built from an empty id would point at
   * the accounts folder itself, and a call that acted on an account that
   * does not exist would act on nothing at all.
   */
  async function accountOf(named?: string): Promise<string | null> {
    const id = named ?? (await deps.currentAccountId()) ?? ''
    if (id.length === 0) return null
    const app = await deps.getSettings()
    if (!app.accounts.some((account) => account.id === id)) return null
    return id
  }

  /** What a call says when there is no account to act on. */
  const NO_ACCOUNT = { ok: false as const, message: 'no account is selected' }

  /** The summary of a run that could not happen, for the same reason. */
  function noAccountSummary(): RunSummary {
    const now = new Date().toISOString()
    return {
      startedAt: now,
      finishedAt: now,
      uploaded: 0,
      updated: 0,
      downloaded: 0,
      trashed: 0,
      errors: 1,
      mirrors: [],
      changed: [],
      reports: [
        { code: 'anomaly', relPath: '', message: 'no account is selected' },
      ],
    }
  }
  // The state is built from the settings every time it is asked for, so a
  // folder the user has just added is in it at once. The preload already
  // hands the renderer a promise.
  ipcMain.handle('drive-mirror:get-state', async (_event, accountId?: string) => {
    return deps.runner.state((await accountOf(accountId)) ?? '')
  })

  ipcMain.handle(
    'drive-mirror:sync-now',
    async (_event, accountId?: string, mirrorName?: string) => {
      try {
        const id = await accountOf(accountId)
        if (!id) return noAccountSummary()
        return await deps.runner.syncNow(id, mirrorName)
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
    async (_event, accountId: string | undefined, mirrorName: string) => {
      const id = await accountOf(accountId)
      if (!id) return noAccountSummary()
      return deps.runner.syncNow(id, mirrorName, { overrideGuard: true })
    },
  )

  ipcMain.handle('drive-mirror:rebase', async (_event, accountId: string | undefined, mirrorName: string) => {
    const id = await accountOf(accountId)
    if (!id) return
    await deps.runner.rebase(id, mirrorName)
  })

  ipcMain.handle('drive-mirror:get-app-settings', () => deps.getSettings())

  ipcMain.handle('drive-mirror:get-account-settings', async (_event, accountId?: string) => {
    const id = await accountOf(accountId)
    return id ? deps.getAccountSettings(id) : defaultAccountSettings()
  })

  ipcMain.handle(
    'drive-mirror:save-account-settings',
    async (_event, accountId: string | undefined, patch: Partial<AccountSettings>) => {
      const id = await accountOf(accountId)
      if (!id) return NO_ACCOUNT
      const next = await deps.saveAccountSettings(id, patch)
      return next
    },
  )

  ipcMain.handle(
    'drive-mirror:save-app-settings',
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

  ipcMain.handle('drive-mirror:sign-out', async (_event, accountId: string | undefined) => {
    const id = await accountOf(accountId)
    if (!id) return
    await deps.signOut(id)
  })

  ipcMain.handle('drive-mirror:switch-account', async (_event, accountId: string | undefined) => {
    const id = await accountOf(accountId)
    if (!id) return NO_ACCOUNT
    await deps.switchAccount(id)
  })

  ipcMain.handle('drive-mirror:forget-account', async (_event, accountId: string | undefined) => {
    const id = await accountOf(accountId)
    if (!id) return NO_ACCOUNT
    await deps.forgetAccount(id)
    return { ok: true }
  })

  ipcMain.handle('drive-mirror:open-log-folder', () => deps.openLogFolder())

  ipcMain.handle('drive-mirror:show-manifest', async (_event, accountId: string | undefined) => {
    const id = await accountOf(accountId)
    if (!id) return
    await deps.showManifest(id)
  })

  ipcMain.handle('drive-mirror:choose-folder', async () => deps.chooseFolder())

  ipcMain.handle('drive-mirror:app-icon', async () => deps.appIcon())

  ipcMain.handle(
    'drive-mirror:add-mirror',
    async (
      _event,
      accountId: string | undefined,
      config: { name: string; root: string; drivePath: string },
    ) => {
      const id = await accountOf(accountId)
      if (!id) return NO_ACCOUNT
      const settings = await deps.getAccountSettings(id)
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
      await deps.saveAccountSettings(id, {
        mirrors: [...kept, { ...config, enabled: true }],
      })
      return { ok: true }
    },
  )

  ipcMain.handle(
    'drive-mirror:update-mirror',
    async (_event, accountId: string | undefined, config: { name: string; drivePath: string }) => {
      const id = await accountOf(accountId)
      if (!id) return NO_ACCOUNT
      const settings = await deps.getAccountSettings(id)
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
          id,
          existing.name,
          config.drivePath,
        )
        if (!moved.ok) return moved
      }
      await deps.saveAccountSettings(id, {
        mirrors: settings.mirrors.map((m) =>
          m.name === existing.name ? { ...m, drivePath: config.drivePath } : m,
        ),
      })
      return { ok: true }
    },
  )

  ipcMain.handle('drive-mirror:remove-mirror', async (_event, accountId: string | undefined, name: string) => {
    const id = await accountOf(accountId)
    if (!id) return NO_ACCOUNT
    const settings = await deps.getAccountSettings(id)
    await deps.saveAccountSettings(id, {
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
    async (_event, accountId: string | undefined, name: string, enabled: boolean) => {
      const id = await accountOf(accountId)
      if (!id) return NO_ACCOUNT
      const settings = await deps.getAccountSettings(id)
      await deps.saveAccountSettings(id, {
        mirrors: settings.mirrors.map((m) => (m.name === name ? { ...m, enabled } : m)),
      })
      return { ok: true }
    },
  )

  ipcMain.handle('drive-mirror:get-schedule', async (_event, accountId: string | undefined) => {
    const id = await accountOf(accountId)
    if (!id) return defaultAccountSettings().schedule
    const settings = await deps.getAccountSettings(id)
    return settings.schedule
  })

  ipcMain.handle(
    'drive-mirror:save-schedule',
    async (_event, accountId: string | undefined, patch: Partial<ScheduleConfig>) => {
      const id = await accountOf(accountId)
      if (!id) throw new Error('no account is selected')
      const settings = await deps.getAccountSettings(id)
      if (patch.shape && !isValidShape(patch.shape)) {
        throw new Error('that schedule cannot be run')
      }
      // The schedule is merged, not replaced: a change to one part of it
      // must not wipe the rest.
      const next = { ...settings.schedule, ...patch }
      await deps.saveAccountSettings(id, { schedule: next })
      // The app has to act on the change now, not at the next start-up.
      await deps.applySchedule(id)
      return next
    },
  )

  ipcMain.handle('drive-mirror:reset-connection', async () => {
    await deps.resetConnection()
    return { ok: true }
  })

  ipcMain.handle('drive-mirror:reset-account-history', async (_event, accountId: string | undefined) => {
    const id = await accountOf(accountId)
    if (!id) return NO_ACCOUNT
    await deps.startFreshManifest(id)
    return { ok: true }
  })

  ipcMain.handle(
    'drive-mirror:download-restored',
    async (_event, accountId: string | undefined, mirror: string, driveFileId: string) => {
      const id = await accountOf(accountId)
      if (!id) return NO_ACCOUNT
      return deps.runner.downloadRestored(id, mirror, driveFileId)
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