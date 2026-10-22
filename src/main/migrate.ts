/**
 * The one-time move into the account layout.
 *
 * Before accounts existed the app had one Google account, and everything
 * about it sat in one folder: the manifest, the journal, the sign-in, and
 * the settings that named the mirrors and the schedule. The app now holds
 * several accounts, and each one has a folder of its own. This module
 * moves an existing install into that layout, once, and leaves the old
 * files where they can be read.
 *
 * The order of the steps is the whole safety of it.
 *
 * The legacy settings file and the new app-wide settings file share a
 * path. If the new file were written first and the migration then failed,
 * the next start would read the new-shaped file as legacy - and the
 * author's schedule, its mechanism and the extra backup location would be
 * gone, because they exist nowhere else. So the legacy settings file is
 * **copied aside first**, and every later step reads the settings from
 * that copy.
 *
 * The manifest is **copied, not moved**, and the old files are only moved
 * into the legacy folder once the new ones are verified. On any failure
 * the partial account folder is removed, everything else is left exactly
 * where it was, and the migration runs again at the next start.
 */

import { copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../core/atomic'
import {
  accountDir, accountJournalPath, accountManifestPath, accountSettingsPath,
  accountTokensPath, accountsDir, appBackupDir, legacyDir, newAccountId,
} from './accountPaths'
import { defaultAppSettings, withLegacyDefaults } from './settings'
import type { AccountSummary, AppSettings } from './settings'

/** What the migration did, or why it did not run. */
export interface MigrationResult {
  /** Whether the layout was changed. */
  migrated: boolean
  /** The account that was created, when one was. */
  accountId?: string
  /** Why it did not run, when it did not. */
  error?: string
}

/**
 * Move an install into the account layout.
 *
 * It does nothing when there is no legacy manifest, and nothing when it
 * has already run. It never destroys anything: the old files end up in the
 * legacy folder, and the copy of record for the settings is made before
 * anything is overwritten.
 */
export async function migrateToAccounts(deps: {
  /** The app's data directory. */
  root: string
  /** Write the new app-wide settings file. */
  writeAppSettings: (settings: AppSettings) => Promise<void>
  /** Remove the old Windows task, if it is registered. */
  unregisterLegacyTask?: () => Promise<void>
  log?: (message: string) => void
}): Promise<MigrationResult> {
  const root = deps.root
  const marker = join(accountsDir(root), '.migrated')
  const legacyManifest = join(root, 'manifest.json')

  try {
    await readFile(marker, 'utf8')
    // It has already run.
    return { migrated: false }
  } catch {
    // Not there yet, which is what we want.
  }

  try {
    await readFile(legacyManifest, 'utf8')
  } catch {
    // There is nothing to move.
    return { migrated: false }
  }

  const id = newAccountId()
  const dir = accountDir(root, id)

  try {
    // 1. Read the legacy settings, before anything is written. The copy
    //    in the legacy folder wins, because that is what an earlier
    //    attempt left behind.
    const legacy = withLegacyDefaults(
      await readJson(join(legacyDir(root), 'settings.json')) ??
        await readJson(join(root, 'settings.json')),
    )

    // 2. The copy of record. From here on, every step reads the settings
    //    from here, never from the app's own settings file, which is about
    //    to be overwritten.
    await mkdir(legacyDir(root), { recursive: true })
    const legacyCopy = join(legacyDir(root), 'settings.json')
    try {
      await readFile(legacyCopy, 'utf8')
    } catch {
      await copyFile(join(root, 'settings.json'), legacyCopy)
    }

    // 3. Remove any partial account folder an earlier attempt left.
    await removePartialAccounts(root)

    // 4. The account's folder.
    await mkdir(dir, { recursive: true })

    // 5. Copy, do not move, the manifest, the journal and the sign-in.
    //    The originals are the copy of record until the new ones are
    //    verified.
    await copyFile(legacyManifest, accountManifestPath(root, id))
    await copyIfPresent(join(root, 'journal.ndjson'), accountJournalPath(root, id))
    await copyIfPresent(join(root, 'tokens.json'), accountTokensPath(root, id))

    // 6. The account's own settings: its mirrors, its schedule and its
    //    notice, all of which used to live in the app's settings file.
    const accountSettings = {
      mirrors: legacy.mirrors,
      schedule: legacy.schedule,
      pendingNotice: legacy.pendingNotice,
    }
    await writeAtomic(
      accountSettingsPath(root, id),
      `${JSON.stringify(accountSettings, null, 2)}\n`,
    )

    // 7. Verify before anything is deleted.
    const copied = await readJson(accountManifestPath(root, id))
    if (!copied || typeof (copied as { version?: unknown }).version !== 'number') {
      throw new Error('the manifest that was copied could not be read back')
    }
    await readJson(accountSettingsPath(root, id))
    await readJson(legacyCopy)

    // 8. The new app-wide settings. The account list, which account is on
    //    screen, and the app's own preferences.
    const manifest = copied as { accountEmail?: unknown }
    const email = typeof manifest.accountEmail === 'string' ? manifest.accountEmail : ''
    const account: AccountSummary = {
      id,
      email,
      addedAt: new Date().toISOString(),
      signedIn: await exists(join(root, 'tokens.json')),
      mirrorCount: legacy.mirrors.length,
      hasNotice: legacy.pendingNotice !== null,
    }
    const app: AppSettings = {
      ...defaultAppSettings(),
      accounts: [account],
      currentAccountId: id,
      clientSecretSet: legacy.clientSecretSet,
      guardThreshold: legacy.guardThreshold,
      startWithWindows: legacy.startWithWindows,
      extraBackupPath: extraBackupFrom(legacy.backupPaths, root),
    }
    await deps.writeAppSettings(app)

    // 9. Only now are the old files moved aside. The legacy settings file
    //    is already in the legacy folder.
    await moveIfPresent(legacyManifest, join(legacyDir(root), 'manifest.json'))
    await moveIfPresent(join(root, 'journal.ndjson'), join(legacyDir(root), 'journal.ndjson'))
    await moveIfPresent(join(root, 'tokens.json'), join(legacyDir(root), 'tokens.json'))

    // 10. The old Windows task fired a run with no account in it, which
    //     would now run every account at once. It goes.
    if (deps.unregisterLegacyTask) await deps.unregisterLegacyTask()

    // 11. The marker, last of all.
    await writeAtomic(marker, `${new Date().toISOString()}\n`)

    deps.log?.(
      `the install was moved into the account layout: ${dir} holds the account, ` +
        `and the old files are in ${legacyDir(root)}`,
    )
    return { migrated: true, accountId: id }
  } catch (err) {
    // Nothing is destroyed and nothing is half-moved. The partial account
    // folder goes, everything else stays where it was, and the migration
    // runs again at the next start.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    const error = err instanceof Error ? err.message : String(err)
    deps.log?.(`the install could not be moved into the account layout: ${error}`)
    return { migrated: false, error }
  }
}

/**
 * The extra place a copy of the manifest is kept.
 *
 * The app's own backup folder is not an extra place, so it is not one. The
 * first path that is something else is the one the user named.
 */
function extraBackupFrom(paths: string[], root: string): string | null {
  const own = appBackupDir(root)
  for (const path of paths) {
    if (path && path !== own) return path
  }
  return null
}

/** Remove the account folders an earlier attempt may have left. */
async function removePartialAccounts(root: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(accountsDir(root))
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith('acc_')) continue
    await rm(join(accountsDir(root), entry), { recursive: true, force: true })
  }
}

/** Read a JSON file, or null when it is not there or not readable. */
async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Whether a path is there. */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** Copy a file, if it is there. */
async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to)
  } catch {
    // It was not there. Nothing to copy.
  }
}

/** Move a file, if it is there. */
async function moveIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    // It was not there, or the move failed. The old file stays where it
    // is, which is safe: the migration has already copied what it needs.
  }
}
