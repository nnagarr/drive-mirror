/**
 * The accounts this install knows about.
 *
 * An account is one Google account, and it is a whole world of its own:
 * its mirrors, its schedule, its file list, its sign-in. The registry is
 * the app's knowledge of those worlds - which ones exist, which one is on
 * screen, and which of them are signed in.
 *
 * The list itself lives in the app's settings file, because it belongs to
 * the machine rather than to any one account. Each account's own state
 * lives in its folder, and the registry is what reads across the two.
 */

import { readFile, readdir, rm, rmdir } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import {
  accountDir, appBackupDir, backupDirFor, legacyDir, newAccountId,
} from './accountPaths'
import { defaultAccountSettings } from './accountSettings'
import type { AccountSettingsStore } from './accountSettings'
import type { AccountTokenStore } from './accountTokens'
import type { AccountRecord, AccountSummary, AppSettings } from './settings'
import type { OAuthTokens } from '../drive/oauth'

/** What the app can do with the accounts it knows about. */
export interface AccountRegistry {
  /** Every account, with the state the switcher draws. */
  list(): Promise<AccountSummary[]>
  /** The account with this address, or null. The comparison ignores case. */
  findByEmail(email: string): Promise<AccountRecord | null>
  /**
   * The account to sign in to.
   *
   * An account with the same address is signed back in, so everything it
   * knew comes back with it. An address the app has never seen makes a
   * new account.
   */
  signIn(email: string, tokens: OAuthTokens): Promise<AccountRecord>
  /** A new account with an empty world. */
  create(email: string): Promise<AccountRecord>
  /** Remove the account and everything the app kept for it. */
  remove(id: string): Promise<void>
  /** Which account the app is showing. */
  setCurrent(id: string | null): Promise<void>
  /** Which account the app is showing, and the address it is signed in as. */
  current(): Promise<AccountSummary | null>
}

/**
 * The accounts on this machine.
 *
 * The list lives in the app's settings; each account's own state lives in
 * its folder, and the two are read together here.
 */
export function createAccountRegistry(deps: {
  /** The app's data directory. */
  root: string
  appSettings: () => Promise<AppSettings>
  saveAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  accountSettings: AccountSettingsStore
  tokens: AccountTokenStore
  /**
   * Where copies of every account's manifest are kept: the app's own
   * folder and any extra place the user named.
   */
  backupPaths?: () => Promise<string[]>
  /**
   * Delete a directory. Injected so a test can make one deletion fail,
   * which is the only way to prove that a failed backup stops the removal
   * before the account folder is touched.
   */
  removeDir?: (path: string) => Promise<void>
  /** Remove one account's lines from the app-wide log. */
  stripLog?: (account: { id: string; email: string }) => Promise<void>
}): AccountRegistry {
  /** The state of one account, worked out from the account's own files. */
  async function summarise(record: AccountRecord): Promise<AccountSummary> {
    const settings = await deps.accountSettings.read(record.id)
    return {
      ...record,
      signedIn: await deps.tokens.has(record.id),
      mirrorCount: settings.mirrors.length,
      hasNotice: settings.pendingNotice !== null,
    }
  }

  async function list(): Promise<AccountSummary[]> {
    const app = await deps.appSettings()
    const summaries: AccountSummary[] = []
    for (const record of app.accounts) {
      summaries.push(await summarise(record))
    }
    return summaries
  }

  async function create(email: string): Promise<AccountRecord> {
    const record: AccountRecord = {
      id: newAccountId(),
      email,
      addedAt: new Date().toISOString(),
    }
    const app = await deps.appSettings()
    await deps.saveAppSettings({
      accounts: [...app.accounts, { ...record, signedIn: false, mirrorCount: 0, hasNotice: false }],
    })
    // The account's folder is made now, not when it first syncs, so the
    // account is a world from the moment it exists.
    await deps.accountSettings.write(record.id, defaultAccountSettings())
    return record
  }

  return {
    list,

    async findByEmail(email: string): Promise<AccountRecord | null> {
      const found = findAccountByEmail(await list(), email)
      return found ? { id: found.id, email: found.email, addedAt: found.addedAt } : null
    },

    async signIn(email: string, tokens: OAuthTokens): Promise<AccountRecord> {
      const app = await deps.appSettings()
      const known = findAccountByEmail(app.accounts, email)
      const record = known ?? (await create(email))
      await deps.tokens.write(record.id, tokens)
      return { id: record.id, email: record.email, addedAt: record.addedAt }
    },

    create,

    async remove(id: string): Promise<void> {
      const app = await deps.appSettings()
      const record = app.accounts.find((account) => account.id === id)
      if (!record) return

      // The copies of the manifest go first. If one of them cannot be
      // deleted, nothing else is touched and the account stays on the
      // list, so the removal can be tried again.
      const backupRoots = new Set(await deps.backupPaths?.() ?? [])
      backupRoots.add(appBackupDir(deps.root))
      const removeDir =
        deps.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }))
      for (const backupRoot of backupRoots) {
        await removeDir(backupDirFor(backupRoot, record.email))
      }

      // The pre-accounts copy belongs to the one account it was migrated
      // into. Removing any other account must not take it.
      if (await legacyIsFor(deps.root, record.email)) {
        await removeDir(legacyDir(deps.root))
      }

      // The log is shared, so only this account's lines come out.
      await deps.stripLog?.({ id, email: record.email })

      // The account's own folder goes last among the files, so a failure
      // above leaves a complete account behind.
      await removeDir(accountDir(deps.root, id))

      const accounts = app.accounts.filter((account) => account.id !== id)
      const patch: Partial<AppSettings> = { accounts }
      if (app.currentAccountId === id) {
        patch.currentAccountId = accounts.length > 0 ? accounts[0]!.id : null
      }
      await deps.saveAppSettings(patch)

      // Tidy away a backup root that this removal emptied. The extra
      // place is a folder the user chose, so it is removed only when it
      // is empty, and a drive root is never attempted: Windows cannot
      // remove one, and a user could have pointed the copy at a volume.
      for (const backupRoot of backupRoots) {
        if (isDriveRoot(backupRoot)) continue
        try {
          if ((await readdir(backupRoot)).length === 0) await rmdir(backupRoot)
        } catch {
          // The folder was already gone, or could not be read. Either
          // way there is nothing to tidy.
        }
      }
    },

    async setCurrent(id: string | null): Promise<void> {
      await deps.saveAppSettings({ currentAccountId: id })
    },

    async current(): Promise<AccountSummary | null> {
      const app = await deps.appSettings()
      if (!app.currentAccountId) return null
      const found = app.accounts.find((account) => account.id === app.currentAccountId)
      return found ? summarise(found) : null
    },
  }
}

/**
 * Whether a path is the top of a volume.
 *
 * A drive's root and the single slash at the top of a filesystem are the
 * two shapes. Nothing in the app is allowed to try to remove one, whatever
 * the user pointed the extra backup copy at.
 */
function isDriveRoot(path: string): boolean {
  const full = resolve(path)
  return parse(full).root === full
}

/**
 * Whether the pre-accounts copy was migrated into this account.
 *
 * The copy records the address it came from. If the file is missing or
 * cannot be read, the answer is no: an account that cannot be proved to
 * own the copy does not get to delete it.
 */
async function legacyIsFor(root: string, email: string): Promise<boolean> {
  try {
    const raw = await readFile(join(legacyDir(root), 'manifest.json'), 'utf8')
    const manifest = JSON.parse(raw) as { accountEmail?: unknown }
    return (
      typeof manifest.accountEmail === 'string' &&
      manifest.accountEmail.trim().toLowerCase() === email.trim().toLowerCase()
    )
  } catch {
    return false
  }
}

/**
 * The account with this address.
 *
 * A Google address is not case-sensitive, so the comparison ignores case.
 * A case-sensitive one would make a second account for the same person,
 * and that account would mirror the same folder into the same Drive.
 */
export function findAccountByEmail(
  accounts: AccountSummary[],
  email: string,
): AccountSummary | null {
  const wanted = email.trim().toLowerCase()
  for (const account of accounts) {
    if (account.email.trim().toLowerCase() === wanted) return account
  }
  return null
}
