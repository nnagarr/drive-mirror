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

/** What one account knows about itself. */
export interface AccountSettings {
  /** The mirrors this account has configured. */
  mirrors: MirrorConfig[]
  /** How often this account syncs on its own. */
  schedule: ScheduleConfig
  /** A problem from a run the user did not watch, shown once. */
  pendingNotice: { message: string; at: string } | null
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
    return {
      mirrors: mergeValue(defaults.mirrors, file.mirrors),
      schedule: mergeValue(defaults.schedule, file.schedule),
      pendingNotice: mergeValue(defaults.pendingNotice, file.pendingNotice),
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
