/**
 * Settings and the credential store.
 *
 * The app's OAuth client id and client secret are the user's own. They are
 * entered in Settings and stored encrypted with Electron's `safeStorage`,
 * which ties them to the Windows account. The file on disk holds base64 of
 * ciphertext; there is no code path that writes the secret in plain text.
 *
 * `safeStorage` only exists inside Electron, so it is injected. That is not
 * only for testing: it keeps this module free of an Electron import, so it
 * can be loaded from a test runner and from the main process alike.
 *
 * The settings file is the app's *own* configuration: the list of accounts,
 * which one is on screen, the guard threshold, whether the app starts with
 * Windows, and where an extra copy of a manifest is kept. It is written
 * atomically - a half-written file would be read back as a broken one - and
 * it is read back with a merge, so a field the file does not mention keeps
 * its default.
 *
 * What belongs to a *Google account* - its mirrors, its schedule, its
 * notice - does not live here. It lives in the account's own folder, so
 * that the folder can be handed over, copied or deleted on its own. See
 * `accountSettings.ts`.
 *
 * The client id is not in this file. It lives in `credentials.json`, and
 * `AppSettings.clientId` is a read-only projection of it.
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeAtomic } from '../core/atomic'

// The rules for a mirror live with the rest of the core, so they can be
// tested without Electron. The type is re-exported here, because the
// settings are the app's public view of what it mirrors.
export type { MirrorConfig } from '../core/mirrorConfig'
import type { MirrorConfig } from '../core/mirrorConfig'

// The shape of a schedule is arithmetic on the clock, so it lives with the
// rest of the core too.
import type { ScheduleShape } from '../core/schedule'
export type { ScheduleShape } from '../core/schedule'

export interface ScheduleConfig {
  /** Whether the app syncs on its own at all. */
  enabled: boolean
  /** How often. */
  shape: ScheduleShape
  /** 'in-app' or 'windows-task'. Never both. */
  mechanism: 'in-app' | 'windows-task'
  /** When the last run finished, for missed-run detection. */
  lastRunAt: string | null
  /** When the next run is due. */
  nextRunAt: string | null
}

/** One account the app knows about. */
export interface AccountRecord {
  /** The opaque id. The folder name and the key everywhere. */
  id: string
  /** The Google address this account is signed in as. */
  email: string
  /** ISO timestamp. */
  addedAt: string
}

/**
 * One account, with the state the switcher draws.
 *
 * The extra three fields are derived, never stored: an account is signed in
 * exactly when its token file is there, and its mirror count and its notice
 * come from its own settings file.
 */
export interface AccountSummary extends AccountRecord {
  /** Whether the account has a sign-in. */
  signedIn: boolean
  /** How many mirrors it has configured. */
  mirrorCount: number
  /** Whether it has a notice that has not been shown. */
  hasNotice: boolean
}

/** What the app is configured with. */
export interface AppSettings {
  /**
   * The user's OAuth client id.
   *
   * A projection of the credential store, never written to the settings
   * file: the id lives in `credentials.json` and nowhere else.
   */
  clientId: string
  /** Every account this install knows about, signed in or not. */
  accounts: AccountSummary[]
  /** Which account the app is showing. Null when there are none. */
  currentAccountId: string | null
  /** Whether a client secret is stored. The secret itself is never here. */
  clientSecretSet: boolean
  /** The smallest folder size the count-drop guard applies to. */
  guardThreshold: number
  /** Start with Windows. */
  startWithWindows: boolean
  /** One extra place to keep a copy of each manifest. Null for none. */
  extraBackupPath: string | null
  /** A problem with the app itself, shown once. */
  pendingNotice: { message: string; at: string } | null
}

/** The encrypted credential file. */
export interface CredentialStore {
  getClientId(): string | null
  getClientSecret(): string | null
  setCredentials(clientId: string, clientSecret: string): Promise<void>
  clear(): Promise<void>
}

/** The part of Electron's `safeStorage` this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(buffer: Buffer): string
}

/** The directory the app keeps its own files in. */
export function appDataDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(base, 'DriveMirror')
}

/** The settings as they are when the user has changed nothing. */
export function defaultAppSettings(): AppSettings {
  return {
    clientId: '',
    accounts: [],
    currentAccountId: null,
    clientSecretSet: false,
    guardThreshold: 5,
    startWithWindows: false,
    extraBackupPath: null,
    pendingNotice: null,
  }
}

/**
 * The credential store.
 *
 * The file holds the client id and the client secret, each encrypted and
 * then base64-encoded, so the file is text and the secret is not readable
 * in it.
 */
export function createCredentialStore(
  file: string,
  safeStorage: SafeStorageLike,
): CredentialStore {
  interface Stored {
    clientId?: string
    clientSecret?: string
  }

  function decrypt(encoded: string | undefined): string | null {
    if (!encoded) return null
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      return null
    }
  }

  return {
    getClientId(): string | null {
      // The read is synchronous by contract, so the file is read with the
      // synchronous API. The store is only used from the main process.
      return decrypt(readSync(file)?.clientId)
    },

    getClientSecret(): string | null {
      return decrypt(readSync(file)?.clientSecret)
    },

    async setCredentials(clientId: string, clientSecret: string): Promise<void> {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'the operating system cannot encrypt the credentials, so they are not stored',
        )
      }
      const stored: Stored = {
        clientId: safeStorage.encryptString(clientId).toString('base64'),
        clientSecret: safeStorage.encryptString(clientSecret).toString('base64'),
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(stored), 'utf8')
    },

    async clear(): Promise<void> {
      await rm(file, { force: true })
    },
  }
}

/** Read the credential file synchronously. */
function readSync(file: string): { clientId?: string; clientSecret?: string } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as {
      clientId?: string
      clientSecret?: string
    }
  } catch {
    return null
  }
}

/**
 * The settings store.
 *
 * The file holds the settings the user can change. A file that is missing
 * or unreadable yields the defaults rather than an error: the app must
 * start even when its settings file has been damaged.
 *
 * The write is atomic: the settings go to a temporary file next to the
 * real one and are renamed over it, so a crash halfway through leaves the
 * old file, not half of a new one.
 */
export function createSettingsStore(file: string): {
  read(): Promise<AppSettings>
  write(s: AppSettings): Promise<void>
  patch(patch: Partial<AppSettings>): Promise<AppSettings>
} {
  async function read(): Promise<AppSettings> {
    const defaults = defaultAppSettings()
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return defaults
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return defaults
    }
    return withDefaults(defaults, parsed)
  }

  async function write(settings: AppSettings): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    // The client id lives in the credential store. It is projected into
    // the settings for the interface, and it is never written here.
    //
    // An account's derived state - whether it is signed in, how many
    // mirrors it has, whether it has a notice - is worked out from the
    // account's own files every time it is asked for, so it is not stored
    // either. Only the record is.
    const stored: Record<string, unknown> = {
      ...settings,
      accounts: settings.accounts.map((account) => ({
        id: account.id,
        email: account.email,
        addedAt: account.addedAt,
      })),
    }
    delete stored.clientId
    // The same atomic write the manifest and every backup copy use, so
    // there is one way to write a file that cannot be left half-written.
    await writeAtomic(file, JSON.stringify(stored, null, 2))
  }

  async function patch(changes: Partial<AppSettings>): Promise<AppSettings> {
    const current = await read()
    const next = { ...current, ...changes }
    await write(next)
    return next
  }

  return { read, write, patch }
}

/**
 * The settings as the file describes them, with the defaults underneath.
 *
 * A field the file does not mention keeps its default, and a nested object
 * is merged one level deep, so a file that knows only that the schedule is
 * enabled still has a schedule with a shape.
 *
 * A key the file has that this build does not know is ignored. The app
 * used to keep its mirrors and its schedule in this file; they live with
 * their account now, and an old file must load without complaint.
 */
function withDefaults(defaults: AppSettings, parsed: unknown): AppSettings {
  if (!isPlainObject(parsed)) return defaults

  return {
    clientId: defaults.clientId,
    accounts: readAccounts(parsed.accounts),
    currentAccountId:
      typeof parsed.currentAccountId === 'string' ? parsed.currentAccountId : null,
    clientSecretSet: mergeValue(defaults.clientSecretSet, parsed.clientSecretSet),
    guardThreshold: mergeValue(defaults.guardThreshold, parsed.guardThreshold),
    startWithWindows: mergeValue(defaults.startWithWindows, parsed.startWithWindows),
    extraBackupPath: mergeValue(defaults.extraBackupPath, parsed.extraBackupPath),
    pendingNotice: mergeValue(defaults.pendingNotice, parsed.pendingNotice),
  }
}

/**
 * The accounts the file names.
 *
 * An entry that is not an account is skipped rather than carried: a
 * hand-edited file must not hand the app an account it cannot use. The
 * derived fields are filled with their defaults; the registry works them
 * out from the account's own files.
 */
function readAccounts(value: unknown): AccountSummary[] {
  if (!Array.isArray(value)) return []
  const accounts: AccountSummary[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue
    if (typeof entry.email !== 'string' || entry.email.length === 0) continue
    accounts.push({
      id: entry.id,
      email: entry.email,
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
      signedIn: false,
      mirrorCount: 0,
      hasNotice: false,
    })
  }
  return accounts
}

/**
 * The settings as they were before accounts existed.
 *
 * The migration needs them: the mirrors, the schedule and the notice move
 * into the account's own folder, and the extra backup path becomes an
 * app-wide setting. The singular `backupPath` of the oldest file is
 * upgraded here, so the copy the user keeps on another disk survives.
 */
export interface LegacySettings {
  /** The mirrors the user had configured. */
  mirrors: MirrorConfig[]
  /** How often the app synced on its own. */
  schedule: ScheduleConfig
  /** A problem from a run the user did not watch, shown once. */
  pendingNotice: { message: string; at: string } | null
  /** Where copies of the manifest were kept. */
  backupPaths: string[]
  /** Whether a client secret was stored. */
  clientSecretSet: boolean
  /** The smallest folder size the count-drop guard applied to. */
  guardThreshold: number
  /** Whether the app started with Windows. */
  startWithWindows: boolean
}

export function withLegacyDefaults(parsed: unknown): LegacySettings {
  const defaults: LegacySettings = {
    mirrors: [],
    schedule: {
      enabled: false,
      shape: { kind: 'every-hours', everyHours: 6 },
      mechanism: 'in-app',
      lastRunAt: null,
      nextRunAt: null,
    },
    pendingNotice: null,
    backupPaths: [],
    clientSecretSet: false,
    guardThreshold: 5,
    startWithWindows: false,
  }
  if (!isPlainObject(parsed)) return defaults

  const legacy: LegacySettings = {
    mirrors: readMirrors(parsed.mirrors),
    schedule: mergeValue(defaults.schedule, parsed.schedule),
    pendingNotice: mergeValue(defaults.pendingNotice, parsed.pendingNotice),
    backupPaths: mergeValue(defaults.backupPaths, parsed.backupPaths),
    clientSecretSet: mergeValue(defaults.clientSecretSet, parsed.clientSecretSet),
    guardThreshold: mergeValue(defaults.guardThreshold, parsed.guardThreshold),
    startWithWindows: mergeValue(defaults.startWithWindows, parsed.startWithWindows),
  }

  // The oldest file had one backup path; the next one had a list. The old
  // path joins the list, so the copy the user keeps on another disk
  // survives the upgrade.
  const singular = parsed.backupPath
  if (parsed.backupPaths === undefined && typeof singular === 'string' && singular.length > 0) {
    legacy.backupPaths = unique([...legacy.backupPaths, singular])
  }

  return legacy
}

/** The mirrors the file names, skipping any that cannot be used. */
function readMirrors(value: unknown): MirrorConfig[] {
  if (!Array.isArray(value)) return []
  const mirrors: MirrorConfig[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue
    if (typeof entry.root !== 'string' || entry.root.length === 0) continue
    mirrors.push({
      name: entry.name,
      root: entry.root,
      drivePath: typeof entry.drivePath === 'string' ? entry.drivePath : entry.name,
      enabled: entry.enabled === true,
      ...(typeof entry.removedAt === 'string' ? { removedAt: entry.removedAt } : {}),
    })
  }
  return mirrors
}

/**
 * The value from the file, or the default when the file has none.
 *
 * A nested object is merged one level deep, so a file that knows only
 * that the schedule is enabled still has a schedule with a shape. A value
 * of the wrong kind is ignored: a hand-edited file must not hand the app
 * settings it cannot use.
 */
export function mergeValue<T>(fallback: T, value: unknown): T {
  if (value === undefined) return fallback
  // A nullable field takes what the file says, including null.
  if (fallback === null) return value as T
  if (Array.isArray(fallback)) {
    return (Array.isArray(value) ? value : fallback) as T
  }
  if (isPlainObject(fallback)) {
    if (!isPlainObject(value)) return fallback
    return { ...fallback, ...value } as unknown as T
  }
  return (typeof value === typeof fallback ? value : fallback) as T
}

/** True for an object that is neither null nor an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The list without repeats, keeping the order. */
function unique(values: string[]): string[] {
  return [...new Set(values)]
}
