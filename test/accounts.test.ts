import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  accountsDir, accountDir, accountSettingsPath, accountManifestPath,
  accountJournalPath, accountTokensPath, accountArchiveDir, appBackupDir,
  backupDirFor, legacyDir, sanitiseForPath, newAccountId,
} from '../src/main/accountPaths'

const ROOT = join('C:', 'appdata', 'DriveMirror')

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
