import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore, defaultSettings } from '../src/main/settings'

describe('the settings store', () => {
  it('returns the defaults when there is no file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const store = createSettingsStore(join(dir, 'settings.json'))
    const s = await store.read()
    expect(s.mirrors).toEqual([])
    expect(s.schedule.enabled).toBe(false)
    expect(s.schedule.mechanism).toBe('in-app')
    expect(s.backupPaths.length).toBeGreaterThan(0)
    expect(s.startWithWindows).toBe(false)
    expect(s.pendingNotice).toBeNull()
  })

  it('keeps every field through a round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    const s = defaultSettings()
    s.mirrors = [{ name: 'Docs', root: 'D:\\Docs', drivePath: 'Docs', enabled: true }]
    s.schedule = {
      enabled: true,
      shape: { kind: 'daily', at: '02:00' },
      mechanism: 'in-app',
      lastRunAt: null,
      nextRunAt: null,
    }
    await store.write(s)
    const back = await store.read()
    expect(back.mirrors).toEqual(s.mirrors)
    expect(back.schedule).toEqual(s.schedule)
  })

  it('merges a patch without losing the fields it does not mention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const store = createSettingsStore(join(dir, 'settings.json'))
    const s = defaultSettings()
    s.mirrors = [{ name: 'Docs', root: 'D:\\Docs', drivePath: 'Docs', enabled: true }]
    await store.write(s)
    const next = await store.patch({ startWithWindows: true })
    expect(next.startWithWindows).toBe(true)
    expect(next.mirrors).toHaveLength(1)
  })

  it('writes atomically, so a half-written file is never left behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    await store.write(defaultSettings())
    const text = await readFile(file, 'utf8')
    expect(text.endsWith('\n')).toBe(false)
    expect(JSON.parse(text).guardThreshold).toBe(defaultSettings().guardThreshold)
    // The file was renamed into place, so the temporary one is gone.
    await expect(stat(`${file}.tmp`)).rejects.toThrow()
  })

  it('falls back to the defaults when the file is damaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(file, '{ not json', 'utf8')
    const store = createSettingsStore(file)
    const s = await store.read()
    expect(s.guardThreshold).toBe(defaultSettings().guardThreshold)
  })

  it('keeps the old backup path when the settings file is upgraded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ backupPath: 'E:\\.drive-mirror-backup\\' }), 'utf8')
    const s = await createSettingsStore(file).read()
    expect(s.backupPaths).toContain('E:\\.drive-mirror-backup\\')
    expect(s.backupPaths[0]).toContain('backups')
  })

  it('never writes the client id to the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)
    await store.write({ ...defaultSettings(), clientId: 'CID' })
    const onDisk = await readFile(file, 'utf8')
    expect(onDisk).not.toContain('CID')
    expect((await store.read()).clientId).toBe('')
  })

  it('keeps a half-written schedule whole', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({ schedule: { enabled: true, shape: { kind: 'daily', at: '02:00' } } }),
      'utf8',
    )
    const s = await createSettingsStore(file).read()
    expect(s.schedule.enabled).toBe(true)
    expect(s.schedule.shape).toEqual({ kind: 'daily', at: '02:00' })
    // The fields the file did not mention keep their defaults.
    expect(s.schedule.mechanism).toBe('in-app')
  })

  it('ignores a field of the wrong kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({ mirrors: 'not a list', guardThreshold: 'many' }),
      'utf8',
    )
    const s = await createSettingsStore(file).read()
    expect(s.mirrors).toEqual([])
    expect(s.guardThreshold).toBe(defaultSettings().guardThreshold)
  })
})
