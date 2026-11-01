import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_VERSION, createManifestStore, emptyManifest } from '../src/core/manifest'
import { appDataDir, defaultAppSettings } from '../src/main/settings'
import { appBackupDir } from '../src/main/accountPaths'
import { writeBackups } from '../src/main/runner'

/** The account the backups belong to. */
const EMAIL = 'you@example.com'

describe('writing the backup', () => {
  it('writes a copy to every path it is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    const result = await writeBackups([a, b], emptyManifest(), EMAIL)
    expect(result.failed).toEqual([])
    expect(result.written).toHaveLength(2)
    expect(JSON.parse(await readFile(join(a, EMAIL, 'manifest.json'), 'utf8')).version).toBe(
      MANIFEST_VERSION,
    )
  })

  it('gives each account a folder of its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    await writeBackups([join(dir, 'one')], emptyManifest(), 'a@example.com')
    await writeBackups([join(dir, 'one')], emptyManifest(), 'b@example.com')
    // Two accounts never write over one another.
    expect(await readdir(join(dir, 'one'))).toEqual(['a@example.com', 'b@example.com'])
  })

  it('does not throw when a path cannot be written, and still writes the others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    // A file where a folder should be: nothing can be written under it.
    await writeFile(join(dir, 'blocker'), 'not a folder')
    const bad = join(dir, 'blocker', 'backup')
    const good = join(dir, 'good')
    const result = await writeBackups([bad, good], emptyManifest(), EMAIL)
    expect(result.failed).toEqual([join(bad, EMAIL)])
    expect(result.written).toEqual([join(good, EMAIL)])
  })

  it('never writes outside the paths it was given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const result = await writeBackups([join(dir, 'one')], emptyManifest(), EMAIL)
    expect(result.written.every((p) => p.startsWith(dir))).toBe(true)
  })

  it('carries the version this build writes, even when the manifest is older', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const older = { ...emptyManifest(), version: 1 }

    await writeBackups([join(dir, 'copy')], older, EMAIL)

    const written = JSON.parse(
      await readFile(join(dir, 'copy', EMAIL, 'manifest.json'), 'utf8'),
    )
    expect(written.version).toBe(MANIFEST_VERSION)
  })

  it('writes the same bytes the manifest store writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const manifest = emptyManifest()

    // The store writes the manifest the app reads...
    const store = createManifestStore(join(dir, 'state'))
    await store.checkpoint(manifest)
    const primary = await readFile(join(dir, 'state', 'manifest.json'), 'utf8')

    // ...and the backup is the same bytes, so the two cannot drift apart.
    await writeBackups([join(dir, 'backup')], manifest, EMAIL)
    const backup = await readFile(join(dir, 'backup', EMAIL, 'manifest.json'), 'utf8')

    expect(backup).toBe(primary)
    expect(backup.endsWith('\n')).toBe(true)
  })

  it('leaves the old copy alone when the new one cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const copy = join(dir, 'backup', EMAIL)
    await mkdir(copy, { recursive: true })
    // A folder where the copy's file should be: the rename cannot happen.
    await mkdir(join(copy, 'manifest.json'), { recursive: true })

    const result = await writeBackups([join(dir, 'backup')], emptyManifest(), EMAIL)

    expect(result.failed).toEqual([copy])
    // The old thing is still there, and no debris was left behind.
    expect((await stat(join(copy, 'manifest.json'))).isDirectory()).toBe(true)
    expect(await readdir(copy)).toEqual(['manifest.json'])
  })

  it('keeps the previous good copy when a refresh cannot be finished', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const copy = join(dir, 'backup')
    await writeBackups([copy], emptyManifest(), EMAIL)
    const before = await readFile(join(copy, EMAIL, 'manifest.json'), 'utf8')

    // The temporary file the refresh writes through cannot be written, so
    // the refresh cannot be finished.
    await mkdir(join(copy, EMAIL, 'manifest.json.tmp'), { recursive: true })
    const result = await writeBackups([copy], emptyManifest(), EMAIL)

    expect(result.failed).toEqual([join(copy, EMAIL)])
    // The good copy is still there, byte for byte: a safety net that is
    // destroyed by the act of refreshing it is no safety net at all.
    expect(await readFile(join(copy, EMAIL, 'manifest.json'), 'utf8')).toBe(before)
  })

  it('says what happened when a copy cannot be written, and does not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    await writeFile(join(dir, 'blocker'), 'not a folder')
    const bad = join(dir, 'blocker', 'backup')
    const messages: string[] = []

    const result = await writeBackups([bad], emptyManifest(), EMAIL, (m) => messages.push(m))

    expect(result.failed).toEqual([join(bad, EMAIL)])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(bad)
  })

  it('warns when there is no backup copy to write at all', async () => {
    const messages: string[] = []

    const result = await writeBackups([], emptyManifest(), EMAIL, (m) => messages.push(m))

    expect(result.written).toEqual([])
    expect(result.failed).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('no safety net')
  })

  it('keeps the default copy beside the manifest, not on a drive letter', () => {
    // The default used to be a hardcoded `E:\.drive-mirror-backup\`, which
    // every test run overwrote. A drive letter in the source is a bug
    // waiting to happen: the copy the app keeps must live with the app.
    expect(appBackupDir(appDataDir())).toBe(join(appDataDir(), 'backups'))
    expect(defaultAppSettings().extraBackupPath).toBeNull()
  })
})
