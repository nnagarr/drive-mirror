/**
 * Where an account lives on disk.
 *
 * The app holds several Google accounts, and each one is a separate world:
 * its own mirrors, its own schedule, its own file list, its own sign-in.
 * That world is one folder, and this module is the only thing that knows
 * where the folder is and what is inside it.
 *
 * Every function takes the app data root as its first argument, so nothing
 * here reads a global and the whole layout can be tested without a disk.
 *
 * The layout:
 *
 *   <root>\settings.json            the app's own settings
 *   <root>\credentials.json         the one shared client id and secret
 *   <root>\accounts\<id>\settings.json    an account's mirrors and schedule
 *   <root>\accounts\<id>\manifest.json    an account's file list
 *   <root>\accounts\<id>\journal.ndjson   an account's journal
 *   <root>\accounts\<id>\tokens.json      an account's sign-in
 *   <root>\backups\<email>\manifest.json  a copy of an account's manifest
 *   <root>\legacy\                  the layout before accounts existed
 *
 * The account folder is the unit of storage: everything that account knew
 * lives inside it. Removing the account also takes the copies of its
 * manifest from the backup folders and its lines from the shared log. The
 * folder itself is deleted last, so a failure outside it leaves a complete
 * account behind.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** The folder every account lives in. */
export function accountsDir(root: string): string {
  return join(root, 'accounts')
}

/**
 * The folder one account lives in.
 *
 * An empty id is refused. `path.join` drops an empty segment, so
 * `accounts\` plus an empty id is the accounts folder itself, and
 * deleting that would take every account with it.
 */
export function accountDir(root: string, id: string): string {
  if (id.length === 0) {
    throw new Error('an account needs an id')
  }
  return join(accountsDir(root), id)
}

/** Where an account's own settings are kept. */
export function accountSettingsPath(root: string, id: string): string {
  return join(accountDir(root, id), 'settings.json')
}

/** Where an account's manifest is kept. */
export function accountManifestPath(root: string, id: string): string {
  return join(accountDir(root, id), 'manifest.json')
}

/** Where an account's journal is kept. */
export function accountJournalPath(root: string, id: string): string {
  return join(accountDir(root, id), 'journal.ndjson')
}

/** Where an account's sign-in is kept. The file is absent when signed out. */
export function accountTokensPath(root: string, id: string): string {
  return join(accountDir(root, id), 'tokens.json')
}

/** Where an account's retired manifests are kept. */
export function accountArchiveDir(root: string, id: string): string {
  return join(accountDir(root, id), 'manifest-archive')
}

/** The app's own copy of each account's manifest. */
export function appBackupDir(root: string): string {
  return join(root, 'backups')
}

/**
 * The folder an account's manifest is copied into, inside a backup root.
 *
 * A backup exists to be read by a person, so the folder is named after the
 * account's address rather than its id: the reader can tell at a glance
 * whose manifest they are looking at.
 */
export function backupDirFor(root: string, email: string): string {
  return join(root, sanitiseForPath(email))
}

/** Where the layout from before accounts existed is kept. */
export function legacyDir(root: string): string {
  return join(root, 'legacy')
}

/**
 * Make a name safe to write to disk.
 *
 * The characters Windows forbids in a filename, and the control characters,
 * become underscores. Without this, a colon in a name would be read as an
 * NTFS alternate data stream.
 *
 * A name that is empty once it is made safe becomes `account`, so the
 * result is never a path that points at the backup root itself.
 */
export function sanitiseForPath(name: string): string {
  const safe = name.replace(/[/\\:*?"<>|]/g, '_').replace(/[\x00-\x1f]/g, '_')
  return safe.length > 0 ? safe : 'account'
}

/**
 * A new account id.
 *
 * The id is opaque on purpose: it is the folder name, and a folder named
 * after an address would be both unreadable and a record of who is using
 * the app. The address is stored inside the account instead.
 */
export function newAccountId(): string {
  return `acc_${randomBytes(6).toString('hex')}`
}
