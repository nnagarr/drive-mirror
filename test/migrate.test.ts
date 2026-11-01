import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateToAccounts } from '../src/main/migrate'
import { createSettingsStore, defaultAppSettings } from '../src/main/settings'
import type { AppSettings } from '../src/main/settings'
import { createAccountSettingsStore } from '../src/main/accountSettings'
import {
  accountDir, accountJournalPath, accountManifestPath, accountSettingsPath,
  accountTokensPath, appBackupDir, legacyDir,
} from '../src/main/accountPaths'

let ROOT = ''

/** The manifest the app wrote before accounts existed. */
const LEGACY_MANIFEST = {
  version: 11,
  updatedAt: '2026-10-21T00:00:00.000Z',
  volumes: {},
  mirrors: {
    Medicine: { root: 'E:\\Medicine', drivePath: 'Archive/Medicine', lastCounts: {}, dirs: {}, files: {}, retired: {} },
  },
  accountEmail: 'you@example.com',
}

/** The settings file the app wrote before accounts existed. */
function legacySettings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientSecretSet: true,
    manifestPath: join(ROOT, 'manifest.json'),
    backupPaths: [appBackupDir(ROOT), 'E:\\.drive-mirror-backup'],
    guardThreshold: 7,
    mirrors: [{ name: 'Medicine', root: 'E:\\Medicine', drivePath: 'Archive/Medicine', enabled: true }],
    schedule: {
      enabled: true,
      shape: { kind: 'daily', at: '02:00' },
      mechanism: 'windows-task',
      lastRunAt: '2026-10-21T00:00:00.000Z',
      nextRunAt: '2026-10-22T02:00:00.000Z',
    },
    startWithWindows: true,
    pendingNotice: null,
    ...over,
  }
}

/** Write the layout the app had before accounts existed. */
async function seedLegacy(over: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(ROOT, 'manifest.json'), JSON.stringify(LEGACY_MANIFEST, null, 2), 'utf8')
  await writeFile(join(ROOT, 'journal.ndjson'), '{"op":"change"}\n', 'utf8')
  await writeFile(join(ROOT, 'tokens.json'), JSON.stringify({ payload: 'abc' }), 'utf8')
  await writeFile(join(ROOT, 'settings.json'), JSON.stringify(legacySettings(over), null, 2), 'utf8')
}

/** The account ids in the accounts folder. */
async function listIds(): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  try {
    const entries = await readdir(join(ROOT, 'accounts'))
    return entries.filter((e) => e.startsWith('acc_'))
  } catch {
    return []
  }
}

beforeEach(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'dm-migrate-'))
})

/** Write the new app-wide settings file, the way the app does. */
async function writeApp(settings: AppSettings): Promise<void> {
  await createSettingsStore(join(ROOT, 'settings.json')).write(settings)
}

describe('the migration to accounts', () => {
  it('does nothing when there is no legacy manifest', async () => {
    const result = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    expect(result.migrated).toBe(false)
  })

  it('moves the manifest, the journal, the tokens and the mirrors', async () => {
    await seedLegacy()
    const messages: string[] = []
    const result = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp, log: (m) => messages.push(m) })
    expect(messages.join('\n')).toContain('account layout')
    expect(result.migrated).toBe(true)
    const id = result.accountId!
    const manifest = JSON.parse(await readFile(accountManifestPath(ROOT, id), 'utf8'))
    expect(manifest.version).toBe(11)
    expect(manifest.accountEmail).toBe('you@example.com')
    expect(manifest.mirrors.Medicine.root).toBe('E:\\Medicine')
    expect(existsSync(accountJournalPath(ROOT, id))).toBe(true)
    const tokens = JSON.parse(await readFile(accountTokensPath(ROOT, id), 'utf8'))
    expect(typeof tokens.payload).toBe('string')
  })

  it('keeps the schedule, the mechanism and the extra backup location', async () => {
    await seedLegacy()
    await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    const id = (await listIds())[0]!
    const s = await createAccountSettingsStore(ROOT).read(id)
    expect(s.mirrors).toHaveLength(1)
    expect(s.mirrors[0]?.name).toBe('Medicine')
    expect(s.schedule.enabled).toBe(true)
    expect(s.schedule.shape).toEqual({ kind: 'daily', at: '02:00' })
    expect(s.schedule.mechanism).toBe('windows-task')
    expect(s.schedule.lastRunAt).toBe('2026-10-21T00:00:00.000Z')
    const app = await createSettingsStore(join(ROOT, 'settings.json')).read()
    expect(app.extraBackupPath).toBe('E:\\.drive-mirror-backup')
    expect(app.currentAccountId).toBe(id)
    expect(app.accounts).toHaveLength(1)
    expect(app.accounts[0]?.email).toBe('you@example.com')
    expect(app.guardThreshold).toBe(7)
    expect(app.startWithWindows).toBe(true)
    expect(app.clientSecretSet).toBe(true)
  })

  it('reads an old file with the singular backupPath', async () => {
    await writeFile(join(ROOT, 'manifest.json'), JSON.stringify(LEGACY_MANIFEST), 'utf8')
    await writeFile(
      join(ROOT, 'settings.json'),
      JSON.stringify(legacySettings({ backupPaths: undefined, backupPath: 'E:\\.drive-mirror-backup' })),
      'utf8',
    )
    await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    const app = await createSettingsStore(join(ROOT, 'settings.json')).read()
    expect(app.extraBackupPath).toBe('E:\\.drive-mirror-backup')
  })

  it('keeps the old files in the legacy folder', async () => {
    await seedLegacy()
    await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    expect(existsSync(join(legacyDir(ROOT), 'manifest.json'))).toBe(true)
    expect(existsSync(join(legacyDir(ROOT), 'settings.json'))).toBe(true)
    expect(existsSync(join(legacyDir(ROOT), 'journal.ndjson'))).toBe(true)
    expect(existsSync(join(legacyDir(ROOT), 'tokens.json'))).toBe(true)
  })

  it('leaves the old files alone when the copy fails, and starts with no accounts', async () => {
    await seedLegacy()
    // A directory where the copy of the settings file must be: copying
    // it cannot work.
    await mkdir(legacyDir(ROOT), { recursive: true })
    await mkdir(join(legacyDir(ROOT), 'settings.json'))
    const before = await readFile(join(ROOT, 'settings.json'), 'utf8')

    const result = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    expect(result.migrated).toBe(false)
    expect(result.error).toBeTruthy()
    expect(await readFile(join(ROOT, 'settings.json'), 'utf8')).toBe(before)
    expect(existsSync(join(ROOT, 'journal.ndjson'))).toBe(true)
    // The half-built account folder is gone, so the next start starts again.
    expect(await listIds()).toEqual([])
    const app = await createSettingsStore(join(ROOT, 'settings.json')).read()
    expect(app.accounts).toEqual([])
  })

  it('recovers when it failed after the new settings file was written', async () => {
    await seedLegacy()
    // The first attempt copied the settings aside, wrote the new file and
    // then failed. The copy is the copy of record, so the schedule and the
    // mirrors must come back.
    await mkdir(legacyDir(ROOT), { recursive: true })
    await writeFile(
      join(legacyDir(ROOT), 'settings.json'),
      await readFile(join(ROOT, 'settings.json'), 'utf8'),
      'utf8',
    )
    await writeFile(join(ROOT, 'settings.json'), JSON.stringify(defaultAppSettings(), null, 2), 'utf8')

    const result = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    expect(result.migrated).toBe(true)
    const id = (await listIds())[0]!
    const s = await createAccountSettingsStore(ROOT).read(id)
    expect(s.mirrors[0]?.name).toBe('Medicine')
    expect(s.schedule.enabled).toBe(true)
  })

  it('does not run twice', async () => {
    await seedLegacy()
    const first = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    const second = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    expect(first.migrated).toBe(true)
    expect(second.migrated).toBe(false)
  })

  it('keeps the account when the old task cannot be removed', async () => {
    await seedLegacy()
    const result = await migrateToAccounts({
      root: ROOT,
      writeAppSettings: writeApp,
      unregisterLegacyTask: async () => {
        throw new Error('Access is denied')
      },
    })
    // The migration has succeeded: the new layout is complete and
    // verified, and a tidying-up failure must not undo it.
    expect(result.migrated).toBe(true)
    const id = (await listIds())[0]!
    const manifest = JSON.parse(await readFile(accountManifestPath(ROOT, id), 'utf8'))
    expect(manifest.accountEmail).toBe('you@example.com')
    // And it does not run again, so the account is never taken away.
    const second = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    expect(second.migrated).toBe(false)
    expect(existsSync(accountManifestPath(ROOT, id))).toBe(true)
  })

  it('removes the legacy Windows task', async () => {
    await seedLegacy()
    let removed = false
    await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp, unregisterLegacyTask: async () => { removed = true } })
    expect(removed).toBe(true)
  })

  it('writes the account settings where the layout says', async () => {
    await seedLegacy()
    const result = await migrateToAccounts({ root: ROOT, writeAppSettings: writeApp })
    expect(existsSync(accountSettingsPath(ROOT, result.accountId!))).toBe(true)
    expect(existsSync(accountDir(ROOT, result.accountId!))).toBe(true)
  })
})
