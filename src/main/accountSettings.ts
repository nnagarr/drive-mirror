/**
 * An account's own settings.
 *
 * Every account is a separate world: its own mirrors, its own schedule, its
 * own notice. Those three things live in the account's folder, so the
 * folder can be handed over, copied or deleted on its own, and so an
 * account's own state can be removed as one folder.
 *
 * The app's own settings — the list of accounts, the shared client id, the
 * guard threshold — live in the app-wide settings file instead. The line
 * is simple: what belongs to a Google account lives with the account, and
 * what belongs to the machine lives with the machine.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { writeAtomic } from '../core/atomic'
import { accountDir, accountSettingsPath } from './accountPaths'
import { mergeValue } from './settings'
import type { MirrorConfig } from '../core/mirrorConfig'
import type { ScheduleConfig } from './settings'
import type { RunSummary } from './ipc'

/** What one account knows about itself. */
export interface AccountSettings {
  /** The mirrors this account has configured. */
  mirrors: MirrorConfig[]
  /** How often this account syncs on its own. */
  schedule: ScheduleConfig
  /** A problem from a run the user did not watch, shown once. */
  pendingNotice: { message: string; at: string } | null
  /**
   * The most recent run that actually happened, kept across restarts.
   *
   * A skipped attempt is never written here, so the user does not lose the
   * details of the last real run when a scheduled slot was skipped.
   */
  lastRun: RunSummary | null
  /**
   * Recent sync history (up to 10 runs, newest first), kept across restarts.
   */
  runHistory?: RunSummary[]
  /**
   * Per-mirror UI state kept across restarts: status and counts. Never
   * `syncing`, `running` or `phase`; a restart means no run is in flight.
   */
  mirrorState: Record<string, { status: 'idle' | 'skipped' | 'attention' | 'error'; counts: { uploaded: number; updated: number; downloaded: number; trashed: number; errors: number } }>
}

/** A new account, with nothing in it. */
export function defaultAccountSettings(): AccountSettings {
  return {
    mirrors: [],
    schedule: {
      enabled: false,
      shape: { kind: 'every-hours', everyHours: 6 },
      mechanism: 'in-app',
      lastRunAt: null,
      nextRunAt: null,
    },
    pendingNotice: null,
    lastRun: null,
    runHistory: [],
    mirrorState: {},
  }
}

/** Reading and writing the settings of the accounts on this machine. */
export interface AccountSettingsStore {
  /** An account's settings, or the defaults when it has none yet. */
  read(id: string): Promise<AccountSettings>
  /** Write an account's settings, and hand back what was written. */
  write(id: string, settings: AccountSettings): Promise<AccountSettings>
  /** Whether the account has a settings file of its own. */
  exists(id: string): Promise<boolean>
}

/**
 * The account settings on disk.
 *
 * The root is the app's data directory. Each account's settings live in
 * its own folder, and one account's file is never another's.
 */
export function createAccountSettingsStore(root: string): AccountSettingsStore {
  async function read(id: string): Promise<AccountSettings> {
    const defaults = defaultAccountSettings()
    let raw: string
    try {
      raw = await readFile(accountSettingsPath(root, id), 'utf8')
    } catch {
      return defaults
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return defaults
    }
    if (typeof parsed !== 'object' || parsed === null) return defaults
    const file = parsed as Record<string, unknown>
    // Validate the persisted last run: it must look like a RunSummary. An
    // old or hand-edited file with a broken value is dropped, not trusted.
    const rawLastRun = file.lastRun
    const lastRun = isRunSummary(rawLastRun) ? (rawLastRun as RunSummary) : null
    // Validate the persisted mirror state: keep only entries whose status is
    // one of the stored statuses and whose counts look right.
    const rawRunHistory = file.runHistory
    const runHistory: RunSummary[] = Array.isArray(rawRunHistory)
      ? (rawRunHistory.filter(isRunSummary) as RunSummary[]).slice(0, 10)
      : []
    if (runHistory.length === 0 && lastRun) {
      runHistory.push(lastRun)
    }
    const rawMirrorState = file.mirrorState
    const mirrorState: AccountSettings['mirrorState'] = {}
    if (isPlainObject(rawMirrorState)) {
      for (const [name, entry] of Object.entries(rawMirrorState)) {
        if (!isPlainObject(entry)) continue
        const status = (entry as Record<string, unknown>).status
        if (status !== 'idle' && status !== 'skipped' && status !== 'attention' && status !== 'error') continue
        const counts = (entry as Record<string, unknown>).counts
        if (!isMirrorCounts(counts)) continue
        mirrorState[name] = { status: status as 'idle' | 'skipped' | 'attention' | 'error', counts }
      }
    }
    return {
      mirrors: mergeValue(defaults.mirrors, file.mirrors),
      schedule: mergeValue(defaults.schedule, file.schedule),
      pendingNotice: mergeValue(defaults.pendingNotice, file.pendingNotice),
      lastRun,
      runHistory,
      mirrorState,
    }
  }

  return {
    read,
    async write(id: string, settings: AccountSettings): Promise<AccountSettings> {
      await mkdir(accountDir(root, id), { recursive: true })
      await writeAtomic(
        accountSettingsPath(root, id),
        `${JSON.stringify(settings, null, 2)}\n`,
      )
      return settings
    },
    async exists(id: string): Promise<boolean> {
      try {
        await readFile(accountSettingsPath(root, id), 'utf8')
        return true
      } catch {
        return false
      }
    },
  }
}

/** True for a plain object that is neither null nor an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when the value looks like a RunSummary. */
function isRunSummary(value: unknown): value is RunSummary {
  if (!isPlainObject(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.startedAt !== 'string') return false
  if (typeof v.finishedAt !== 'string') return false
  if (typeof v.uploaded !== 'number') return false
  if (typeof v.updated !== 'number') return false
  if (typeof v.downloaded !== 'number') return false
  if (typeof v.trashed !== 'number') return false
  if (typeof v.errors !== 'number') return false
  if (!Array.isArray(v.mirrors)) return false
  if (!Array.isArray(v.changed)) return false
  if (!Array.isArray(v.reports)) return false
  return true
}

/** True when the value looks like a MirrorCard counts object. */
function isMirrorCounts(value: unknown): value is { uploaded: number; updated: number; downloaded: number; trashed: number; errors: number } {
  if (!isPlainObject(value)) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.uploaded === 'number' &&
    typeof v.updated === 'number' &&
    typeof v.downloaded === 'number' &&
    typeof v.trashed === 'number' &&
    typeof v.errors === 'number'
  )
}
