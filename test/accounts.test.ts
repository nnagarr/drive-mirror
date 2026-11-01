import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountsDir, accountDir, accountSettingsPath, accountManifestPath,
  accountJournalPath, accountTokensPath, accountArchiveDir, appBackupDir,
  backupDirFor, legacyDir, sanitiseForPath, newAccountId,
} from '../src/main/accountPaths'
import {
  createAccountSettingsStore, defaultAccountSettings,
} from '../src/main/accountSettings'
import { createAccountTokenStore } from '../src/main/accountTokens'
import { createAccountRegistry, findAccountByEmail } from '../src/main/accounts'
import { stripAccountFromLog } from '../src/main/logFile'
import { createSettingsStore } from '../src/main/settings'
import type { SafeStorageLike } from '../src/main/settings'

const ROOT = join('C:', 'appdata', 'DriveMirror')

/** A set of tokens, for an account that is signed in. */
const TOKENS = {
  access_token: 'a',
  refresh_token: 'r',
  expiry_date: 1,
  scope: 's',
  token_type: 'Bearer',
}

/**
 * A stand-in for Electron's safeStorage.
 *
 * The point of the test is that the sign-in is not in the file in plain
 * text, so the fake has to actually transform it.
 */
function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8').reverse(),
    decryptString: (b: Buffer) =>
      Buffer.from(b).reverse().toString('utf8').replace(/^enc:/, ''),
  }
}

/** A temporary app data root, so the tests write to a temp folder. */
async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dm-accounts-'))
}

/** A copy of an account's manifest in a backup root. */
async function backupIn(root: string, email: string): Promise<void> {
  const dir = backupDirFor(root, email)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), '{}', 'utf8')
}

/** The registry over a temporary app data directory. */
async function registryBox(
  removeDir?: (path: string) => Promise<void>,
) {
  const root = await tempRoot()
  const extraBackup = join(root, 'extra-backup')
  const appSettings = createSettingsStore(join(root, 'settings.json'))
  const accountSettings = createAccountSettingsStore(root)
  const tokens = createAccountTokenStore(root, fakeSafeStorage())
  const registry = createAccountRegistry({
    root,
    appSettings: () => appSettings.read(),
    saveAppSettings: async (patch) => {
      const current = await appSettings.read()
      const next = { ...current, ...patch }
      await appSettings.write(next)
      return next
    },
    accountSettings,
    tokens,
    backupPaths: async () => [appBackupDir(root), extraBackup],
    stripLog: (account) => stripAccountFromLog(join(root, 'logs'), account),
    removeDir,
  })
  return { root, extraBackup, appSettings, accountSettings, tokens, registry }
}

describe('the account layout', () => {
  it('puts every account under the accounts folder', () => {
    expect(accountsDir(ROOT)).toBe(join(ROOT, 'accounts'))
    expect(accountDir(ROOT, 'acc_7f3a2b')).toBe(join(ROOT, 'accounts', 'acc_7f3a2b'))
  })

  it('gives each account its own settings, manifest, journal and tokens', () => {
    const dir = accountDir(ROOT, 'acc_7f3a2b')
    expect(accountSettingsPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'settings.json'))
    expect(accountManifestPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'manifest.json'))
    expect(accountJournalPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'journal.ndjson'))
    expect(accountTokensPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'tokens.json'))
    expect(accountArchiveDir(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'manifest-archive'))
  })

  it('keeps the app backup folder and the legacy folder apart from the accounts', () => {
    expect(appBackupDir(ROOT)).toBe(join(ROOT, 'backups'))
    expect(legacyDir(ROOT)).toBe(join(ROOT, 'legacy'))
  })

  it('names a backup folder after the account that owns it', () => {
    // The argument is a backup root, not the app root: the app's own
    // backup root is `backups`, and a named one is wherever the user
    // pointed it. Both hold one folder per account.
    expect(backupDirFor(appBackupDir(ROOT), 'you@example.com'))
      .toBe(join(ROOT, 'backups', 'you@example.com'))
    expect(backupDirFor(join('E:', 'backup'), 'you@example.com'))
      .toBe(join('E:', 'backup', 'you@example.com'))
  })

  it('makes a name safe to write to disk', () => {
    expect(sanitiseForPath('a@b.com')).toBe('a@b.com')
    expect(sanitiseForPath('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitiseForPath('')).toBe('account')
  })

  it('makes an account id that is not an email', () => {
    const id = newAccountId()
    expect(id).toMatch(/^acc_[0-9a-f]{12}$/)
    expect(id).not.toContain('@')
    expect(newAccountId()).not.toBe(id)
  })
})

describe('the account settings store', () => {
  it('starts with no mirrors, no schedule and no notice', () => {
    const s = defaultAccountSettings()
    expect(s.mirrors).toEqual([])
    expect(s.schedule.enabled).toBe(false)
    expect(s.schedule.mechanism).toBe('in-app')
    expect(s.schedule.lastRunAt).toBeNull()
    expect(s.schedule.nextRunAt).toBeNull()
    expect(s.pendingNotice).toBeNull()
  })

  it('reads and writes one account without touching another', async () => {
    const root = await tempRoot()
    const store = createAccountSettingsStore(root)
    await store.write('acc_7f3a2b', {
      ...defaultAccountSettings(),
      mirrors: [{ name: 'Medicine', root: 'E:\\Medicine', drivePath: 'Archive/Medicine', enabled: true }],
    })
    const a = await store.read('acc_7f3a2b')
    expect(a.mirrors).toHaveLength(1)
    expect(a.mirrors[0]?.name).toBe('Medicine')
    const b = await store.read('acc_91c4de')
    expect(b.mirrors).toEqual([])
  })

  it('writes the account settings where the layout says', async () => {
    const root = await tempRoot()
    const store = createAccountSettingsStore(root)
    await store.write('acc_7f3a2b', defaultAccountSettings())
    const raw = JSON.parse(await readFile(accountSettingsPath(root, 'acc_7f3a2b'), 'utf8'))
    expect(raw.mirrors).toEqual([])
  })

  it('reads a partial file over the defaults', async () => {
    const root = await tempRoot()
    await mkdir(accountDir(root, 'acc_7f3a2b'), { recursive: true })
    await writeFile(
      accountSettingsPath(root, 'acc_7f3a2b'),
      JSON.stringify({ mirrors: [{ name: 'A', root: 'E:\\A', drivePath: 'A', enabled: true }] }),
      'utf8',
    )
    const s = await createAccountSettingsStore(root).read('acc_7f3a2b')
    expect(s.mirrors).toHaveLength(1)
    expect(s.schedule.enabled).toBe(false)
    expect(s.pendingNotice).toBeNull()
  })
})

describe('the account token store', () => {
  it('has no tokens for an account that has never signed in', async () => {
    const root = await tempRoot()
    const tokens = createAccountTokenStore(root, fakeSafeStorage())
    expect(await tokens.read('acc_7f3a2b')).toBeNull()
    expect(await tokens.has('acc_7f3a2b')).toBe(false)
  })

  it("keeps one account's tokens out of another account's file", async () => {
    const root = await tempRoot()
    const tokens = createAccountTokenStore(root, fakeSafeStorage())
    await tokens.write('acc_7f3a2b', { access_token: 'a', refresh_token: 'r', expiry_date: 1, scope: 's', token_type: 'Bearer' })
    expect((await tokens.read('acc_7f3a2b'))?.access_token).toBe('a')
    expect(await tokens.read('acc_91c4de')).toBeNull()
    await tokens.clear('acc_7f3a2b')
    expect(await tokens.has('acc_7f3a2b')).toBe(false)
  })

  it('does not keep the sign-in in plain text', async () => {
    const root = await tempRoot()
    const tokens = createAccountTokenStore(root, fakeSafeStorage())
    await tokens.write('acc_7f3a2b', { access_token: 'secret-token', refresh_token: 'r', expiry_date: 1, scope: 's', token_type: 'Bearer' })
    const raw = await readFile(accountTokensPath(root, 'acc_7f3a2b'), 'utf8')
    expect(raw).not.toContain('secret-token')
  })
})

describe('the account registry', () => {
  it('finds an account by its address, whatever the case', async () => {
    const box = await registryBox()
    const made = await box.registry.create('You@Example.com')
    expect(await findAccountByEmail(await box.registry.list(), 'you@example.com')).not.toBeNull()
    expect(await findAccountByEmail(await box.registry.list(), 'YOU@EXAMPLE.COM')).not.toBeNull()
    expect(await findAccountByEmail(await box.registry.list(), 'other@example.com')).toBeNull()
    expect(made.email).toBe('You@Example.com')
  })

  it('says whether an account is signed in and how many mirrors it has', async () => {
    const box = await registryBox()
    const made = await box.registry.create('you@example.com')
    await box.accountSettings.write(made.id, {
      ...defaultAccountSettings(),
      mirrors: [{ name: 'A', root: 'E:\\A', drivePath: 'A', enabled: true }],
    })
    await box.tokens.write(made.id, TOKENS)
    const summaries = await box.registry.list()
    expect(summaries[0]).toMatchObject({
      id: made.id, email: 'you@example.com', signedIn: true, mirrorCount: 1, hasNotice: false,
    })
  })

  it('makes a new account with an empty world', async () => {
    const box = await registryBox()
    const made = await box.registry.create('you@example.com')
    expect(await box.accountSettings.read(made.id)).toEqual(defaultAccountSettings())
    expect(await box.tokens.has(made.id)).toBe(false)
    expect(existsSync(accountDir(box.root, made.id))).toBe(true)
  })

  it('removes an account and leaves the others alone', async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    const b = await box.registry.create('b@example.com')
    await box.tokens.write(b.id, TOKENS)
    await box.registry.remove(a.id)
    expect(existsSync(accountDir(box.root, a.id))).toBe(false)
    expect(existsSync(accountDir(box.root, b.id))).toBe(true)
    expect(await box.tokens.has(b.id)).toBe(true)
    expect((await box.registry.list()).map((x) => x.email)).toEqual(['b@example.com'])
  })

  it('removes the manifest copies from every backup folder it wrote to', async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    const b = await box.registry.create('b@example.com')
    await backupIn(appBackupDir(box.root), a.email)
    await backupIn(box.extraBackup, a.email)
    await backupIn(appBackupDir(box.root), b.email)

    await box.registry.remove(a.id)

    expect(existsSync(backupDirFor(appBackupDir(box.root), a.email))).toBe(false)
    expect(existsSync(backupDirFor(box.extraBackup, a.email))).toBe(false)
    expect(existsSync(backupDirFor(appBackupDir(box.root), b.email))).toBe(true)
  })

  it("removes the legacy copy when it is the account's own", async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    await mkdir(legacyDir(box.root), { recursive: true })
    await writeFile(
      join(legacyDir(box.root), 'manifest.json'),
      JSON.stringify({ accountEmail: 'A@Example.com' }),
      'utf8',
    )

    await box.registry.remove(a.id)

    expect(existsSync(legacyDir(box.root))).toBe(false)
  })

  it('keeps the legacy copy when it belongs to another account', async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    await box.registry.create('b@example.com')
    await mkdir(legacyDir(box.root), { recursive: true })
    const manifest = JSON.stringify({ accountEmail: 'b@example.com' })
    await writeFile(join(legacyDir(box.root), 'manifest.json'), manifest, 'utf8')

    await box.registry.remove(a.id)

    expect(existsSync(join(legacyDir(box.root), 'manifest.json'))).toBe(true)
  })

  it('removes every backup root that is left empty', async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    await backupIn(appBackupDir(box.root), a.email)
    await backupIn(box.extraBackup, a.email)

    await box.registry.remove(a.id)

    expect(existsSync(appBackupDir(box.root))).toBe(false)
    expect(existsSync(box.extraBackup)).toBe(false)
  })

  it("keeps the app's backup folder while another account still has a copy", async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    const b = await box.registry.create('b@example.com')
    await backupIn(appBackupDir(box.root), a.email)
    await backupIn(appBackupDir(box.root), b.email)

    await box.registry.remove(a.id)

    expect(existsSync(appBackupDir(box.root))).toBe(true)
  })

  it('leaves the account whole when a backup copy cannot be deleted', async () => {
    const box = await registryBox(async (path) => {
      if (path.includes('extra-backup')) throw new Error('the drive is not connected')
      await rm(path, { recursive: true, force: true })
    })
    const a = await box.registry.create('a@example.com')
    await backupIn(box.extraBackup, a.email)

    await expect(box.registry.remove(a.id)).rejects.toThrow('the drive is not connected')

    expect(existsSync(accountDir(box.root, a.id))).toBe(true)
    expect((await box.registry.list()).map((x) => x.email)).toEqual(['a@example.com'])
  })

  it("removes the account's lines from the shared log", async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    const b = await box.registry.create('b@example.com')
    await mkdir(join(box.root, 'logs'), { recursive: true })
    await writeFile(
      join(box.root, 'logs', 'app.log'),
      [
        JSON.stringify({ at: '2026-10-22T00:00:00.000Z', level: 'info', message: 'state', account: a.email }),
        JSON.stringify({ at: '2026-10-22T00:00:00.000Z', level: 'info', message: 'state', account: b.email }),
        JSON.stringify({ at: '2026-10-22T00:00:00.000Z', level: 'info', message: `removed ${a.email}` }),
      ].join('\n') + '\n',
      'utf8',
    )

    await box.registry.remove(a.id)

    const text = await readFile(join(box.root, 'logs', 'app.log'), 'utf8')
    expect(text).not.toContain('a@example.com')
    expect(text).toContain('b@example.com')
  })

  it('moves the current account and can clear it', async () => {
    const box = await registryBox()
    const a = await box.registry.create('a@example.com')
    const b = await box.registry.create('b@example.com')
    await box.registry.setCurrent(a.id)
    expect((await box.appSettings.read()).currentAccountId).toBe(a.id)
    await box.registry.setCurrent(b.id)
    expect((await box.appSettings.read()).currentAccountId).toBe(b.id)
    await box.registry.setCurrent(null)
    expect((await box.appSettings.read()).currentAccountId).toBeNull()
  })

  it('signs an account back in, and everything it knew comes back with it', async () => {
    const box = await registryBox()
    const first = await box.registry.signIn('you@example.com', TOKENS)
    await box.accountSettings.write(first.id, {
      ...defaultAccountSettings(),
      mirrors: [{ name: 'Medicine', root: 'E:\\Medicine', drivePath: 'Archive/Medicine', enabled: true }],
    })
    // The sign-in goes, and comes back with the same address.
    await box.tokens.clear(first.id)
    const again = await box.registry.signIn('YOU@example.com', TOKENS)
    expect(again.id).toBe(first.id)
    const settings = await box.accountSettings.read(again.id)
    expect(settings.mirrors).toHaveLength(1)
    expect(settings.mirrors[0]?.name).toBe('Medicine')
    expect((await box.registry.list())).toHaveLength(1)
  })

  it('makes a new account for an address it has never seen', async () => {
    const box = await registryBox()
    await box.registry.signIn('you@example.com', TOKENS)
    const other = await box.registry.signIn('other@example.com', TOKENS)
    expect((await box.registry.list()).map((x) => x.email)).toEqual([
      'you@example.com',
      'other@example.com',
    ])
    expect(other.id).not.toBe('')
  })
})
