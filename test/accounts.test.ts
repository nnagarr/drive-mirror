import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
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
import type { SafeStorageLike } from '../src/main/settings'

const ROOT = join('C:', 'appdata', 'DriveMirror')

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
