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
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** What the app is configured with. */
export interface Settings {
  /** The user's OAuth client id. */
  clientId: string
  /** Whether a client secret is stored. The secret itself is never here. */
  clientSecretSet: boolean
  /** Where the manifest lives. */
  manifestPath: string
  /** Where the backup of the manifest is kept. */
  backupPath: string
  /** Where superseded copies are kept. */
  supersededPath: string
  /** The smallest folder size the count-drop guard applies to. */
  guardThreshold: number
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
    backupPath: 'E:\\.drive-mirror-backup\\',
    supersededPath: join(dir, 'superseded'),
    guardThreshold: 5,
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
 */
export function createSettingsStore(file: string): {
  read(): Promise<Settings>
  write(s: Settings): Promise<void>
} {
  return {
    async read(): Promise<Settings> {
      const defaults = defaultSettings()
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return defaults
      }
      try {
        const parsed = JSON.parse(text) as Partial<Settings>
        return { ...defaults, ...parsed }
      } catch {
        return defaults
      }
    },

    async write(settings: Settings): Promise<void> {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(settings, null, 2), 'utf8')
    },
  }
}
