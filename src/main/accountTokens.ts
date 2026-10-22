/**
 * An account's sign-in.
 *
 * The tokens for one Google account live in that account's own folder, and
 * nowhere else. That is what makes the account folder the unit of storage:
 * an account's sign-in cannot be read by another account's run, and
 * removing an account takes its sign-in with it.
 *
 * The file keeps the shape it has always had — a single base64 payload,
 * encrypted with the operating system's own key — so an account's sign-in
 * is stored exactly as it was before accounts existed.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { accountDir, accountTokensPath } from './accountPaths'
import type { SafeStorageLike } from './settings'
import type { OAuthTokens } from '../drive/oauth'

/** Reading and writing the sign-ins of the accounts on this machine. */
export interface AccountTokenStore {
  /** An account's tokens, or null when it is not signed in. */
  read(id: string): Promise<OAuthTokens | null>
  /** Store an account's tokens, encrypted. */
  write(id: string, tokens: OAuthTokens): Promise<void>
  /** Drop an account's sign-in, keeping everything else. */
  clear(id: string): Promise<void>
  /** Whether the account is signed in. */
  has(id: string): Promise<boolean>
}

/**
 * The sign-ins on disk.
 *
 * The root is the app's data directory. Each account's tokens live in its
 * own folder, encrypted with the operating system's key.
 */
export function createAccountTokenStore(
  root: string,
  safeStorage: SafeStorageLike,
): AccountTokenStore {
  return {
    async read(id: string): Promise<OAuthTokens | null> {
      try {
        const raw = await readFile(accountTokensPath(root, id), 'utf8')
        const stored = JSON.parse(raw) as { payload?: string }
        if (!stored.payload) return null
        const plain = safeStorage.decryptString(Buffer.from(stored.payload, 'base64'))
        return JSON.parse(plain) as OAuthTokens
      } catch {
        return null
      }
    },

    async write(id: string, tokens: OAuthTokens): Promise<void> {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('the operating system cannot encrypt the sign-in token')
      }
      await mkdir(accountDir(root, id), { recursive: true })
      const payload = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
      await writeFile(accountTokensPath(root, id), JSON.stringify({ payload }), 'utf8')
    },

    async clear(id: string): Promise<void> {
      await rm(accountTokensPath(root, id), { force: true })
    },

    async has(id: string): Promise<boolean> {
      try {
        const raw = await readFile(accountTokensPath(root, id), 'utf8')
        return JSON.parse(raw).payload !== undefined
      } catch {
        return false
      }
    },
  }
}
