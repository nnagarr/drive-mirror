import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore, defaultAppSettings } from '../src/main/settings'
import type { AccountSummary } from '../src/main/settings'

const ACCOUNT: AccountSummary = {
  id: 'acc_7f3a2b',
  email: 'you@example.com',
  addedAt: '2026-10-22T00:00:00.000Z',
  signedIn: true,
  mirrorCount: 4,
  hasNotice: false,
}

describe('the settings store', () => {
  it('returns the defaults when there is no file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const store = createSettingsStore(join(dir, 'settings.json'))
    const s = await store.read()
    expect(s.accounts).toEqual([])
    expect(s.currentAccountId).toBeNull()
    expect(s.clientId).toBe('')
    expect(s.clientSecretSet).toBe(false)
    expect(s.guardThreshold).toBe(5)
    expect(s.startWithWindows).toBe(false)
    expect(s.extraBackupPath).toBeNull()
    expect(s.pendingNotice).toBeNull()
  })

  it('keeps every field through a round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    const s = defaultAppSettings()
    s.accounts = [ACCOUNT]
    s.currentAccountId = ACCOUNT.id
    s.extraBackupPath = 'E:\\.drive-mirror-backup'
    s.guardThreshold = 9
    s.startWithWindows = true
    s.clientSecretSet = true
    await store.write(s)
    const back = await store.read()
    expect(back.accounts).toHaveLength(1)
    expect(back.accounts[0]?.email).toBe('you@example.com')
    expect(back.currentAccountId).toBe(ACCOUNT.id)
    expect(back.extraBackupPath).toBe('E:\\.drive-mirror-backup')
    expect(back.guardThreshold).toBe(9)
    expect(back.startWithWindows).toBe(true)
    expect(back.clientSecretSet).toBe(true)
  })

  it('merges a patch without losing the fields it does not mention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const store = createSettingsStore(join(dir, 'settings.json'))
    const s = defaultAppSettings()
    s.accounts = [ACCOUNT]
    await store.write(s)
    const next = await store.patch({ startWithWindows: true })
    expect(next.startWithWindows).toBe(true)
    expect(next.accounts).toHaveLength(1)
  })

  it('writes atomically, so a half-written file is never left behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    await store.write(defaultAppSettings())
    const text = await readFile(file, 'utf8')
    expect(text.endsWith('\n')).toBe(false)
    expect(JSON.parse(text).guardThreshold).toBe(defaultAppSettings().guardThreshold)
    // The file was renamed into place, so the temporary one is gone.
    await expect(stat(`${file}.tmp`)).rejects.toThrow()
  })

  it('falls back to the defaults when the file is damaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(file, '{ not json', 'utf8')
    const store = createSettingsStore(file)
    const s = await store.read()
    expect(s.guardThreshold).toBe(defaultAppSettings().guardThreshold)
  })

  it('never writes the client id to the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    await store.write({ ...defaultAppSettings(), clientId: 'CID' })
    const onDisk = await readFile(file, 'utf8')
    expect(onDisk).not.toContain('CID')
    expect((await store.read()).clientId).toBe('')
  })

  it('drops the keys it does not know, so an old file loads without complaint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({ mirrors: [{ name: 'Docs' }], schedule: { enabled: true }, backupPaths: ['E:\\x'] }),
      'utf8',
    )
    const s = await createSettingsStore(file).read()
    expect(Object.keys(s)).not.toContain('mirrors')
    expect(Object.keys(s)).not.toContain('schedule')
    expect(Object.keys(s)).not.toContain('backupPaths')
    expect(s.accounts).toEqual([])
  })

  it('writes only the record of an account, never its derived state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    await store.write({ ...defaultAppSettings(), accounts: [ACCOUNT] })
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    expect(Object.keys(onDisk.accounts[0]).sort()).toEqual(['addedAt', 'email', 'id'])
  })

  it('ignores a field of the wrong kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({ accounts: 'not a list', guardThreshold: 'many', currentAccountId: 42 }),
      'utf8',
    )
    const s = await createSettingsStore(file).read()
    expect(s.accounts).toEqual([])
    expect(s.guardThreshold).toBe(defaultAppSettings().guardThreshold)
    expect(s.currentAccountId).toBeNull()
  })
})
