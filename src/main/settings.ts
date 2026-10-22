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
 * The settings file is the app's *configuration*: the mirrors, the schedule,
 * the places the manifest is copied to, and the notice for a run the user
 * did not watch. It is written atomically - a half-written file would be
 * read back as a broken one - and it is read back with a merge, so a field
 * the file does not mention keeps its default.
 *
 * The client id is not in this file. It lives in `credentials.json`, and
 * `Settings.clientId` is a read-only projection of it.
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeAtomic } from '../core/atomic'
import type { MirrorConfig } from '../core/mirrorConfig'

// The rules for a mirror live with the rest of the core, so they can be
// tested without Electron. The type is re-exported here, because the
// settings are the app's public view of what it mirrors.
export type { MirrorConfig } from '../core/mirrorConfig'

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

/** What the app is configured with. */
export interface Settings {
  /**
   * The user's OAuth client id.
   *
   * A projection of the credential store, never written to the settings
   * file: the id lives in `credentials.json` and nowhere else.
   */
  clientId: string
  /** Whether a client secret is stored. The secret itself is never here. */
  clientSecretSet: boolean
  /** Where the manifest lives. */
  manifestPath: string
  /** Where copies of the manifest are kept. The first is the local one. */
  backupPaths: string[]
  /** The smallest folder size the count-drop guard applies to. */
  guardThreshold: number
  /** The mirrors the user has configured. */
  mirrors: MirrorConfig[]
  /** How often the app syncs on its own. */
  schedule: ScheduleConfig
  /** Start with Windows. */
  startWithWindows: boolean
  /** A problem from a run the user did not watch, shown once. */
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
export function defaultSettings(): Settings {
  const dir = appDataDir()
  return {
    clientId: '',
    clientSecretSet: false,
    manifestPath: join(dir, 'manifest.json'),
    backupPaths: [join(dir, 'backups')],
    guardThreshold: 5,
    mirrors: [],
    schedule: {
      enabled: false,
      shape: { kind: 'every-hours', everyHours: 6 },
      mechanism: 'in-app',
      lastRunAt: null,
      nextRunAt: null,
    },
    startWithWindows: false,
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
  read(): Promise<Settings>
  write(s: Settings): Promise<void>
  patch(patch: Partial<Settings>): Promise<Settings>
} {
  async function read(): Promise<Settings> {
    const defaults = defaultSettings()
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

  async function write(settings: Settings): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    // The client id lives in the credential store. It is projected into
    // the settings for the interface, and it is never written here.
    const stored: Record<string, unknown> = { ...settings }
    delete stored.clientId
    // The same atomic write the manifest and every backup copy use, so
    // there is one way to write a file that cannot be left half-written.
    await writeAtomic(file, JSON.stringify(stored, null, 2))
  }

  async function patch(changes: Partial<Settings>): Promise<Settings> {
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
 */
function withDefaults(defaults: Settings, parsed: unknown): Settings {
  if (!isPlainObject(parsed)) return defaults

  const settings: Settings = {
    clientId: defaults.clientId,
    clientSecretSet: mergeValue(defaults.clientSecretSet, parsed.clientSecretSet),
    manifestPath: mergeValue(defaults.manifestPath, parsed.manifestPath),
    backupPaths: mergeValue(defaults.backupPaths, parsed.backupPaths),
    guardThreshold: mergeValue(defaults.guardThreshold, parsed.guardThreshold),
    mirrors: mergeValue(defaults.mirrors, parsed.mirrors),
    schedule: mergeValue(defaults.schedule, parsed.schedule),
    startWithWindows: mergeValue(defaults.startWithWindows, parsed.startWithWindows),
    pendingNotice: mergeValue(defaults.pendingNotice, parsed.pendingNotice),
  }

  // The old file had one backup path; the new one has a list. The old path
  // joins the list, so the copy the user keeps on another disk survives
  // the upgrade.
  const legacy = parsed.backupPath
  if (parsed.backupPaths === undefined && typeof legacy === 'string' && legacy.length > 0) {
    const local = defaults.backupPaths[0]
    settings.backupPaths = unique(local ? [local, legacy] : [legacy])
  }

  return settings
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
