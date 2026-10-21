import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_VERSION, createManifestStore, emptyManifest } from '../src/core/manifest'
import { appDataDir, defaultSettings } from '../src/main/settings'
import { writeBackups } from '../src/main/runner'

describe('writing the backup', () => {
  it('writes a copy to every path it is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    const result = await writeBackups([a, b], emptyManifest())
    expect(result.failed).toEqual([])
    expect(result.written).toHaveLength(2)
    expect(JSON.parse(await readFile(join(a, 'manifest.json'), 'utf8')).version).toBe(
      MANIFEST_VERSION,
    )
  })

  it('does not throw when a path cannot be written, and still writes the others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    // A file where a folder should be: nothing can be written under it.
    await writeFile(join(dir, 'blocker'), 'not a folder')
    const bad = join(dir, 'blocker', 'backup')
    const good = join(dir, 'good')
    const result = await writeBackups([bad, good], emptyManifest())
    expect(result.failed).toEqual([bad])
    expect(result.written).toEqual([good])
  })

  it('never writes outside the paths it was given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const result = await writeBackups([join(dir, 'one')], emptyManifest())
    expect(result.written.every((p) => p.startsWith(dir))).toBe(true)
  })

  it('carries the version this build writes, even when the manifest is older', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const older = { ...emptyManifest(), version: 1 }

    await writeBackups([join(dir, 'copy')], older)

    const written = JSON.parse(await readFile(join(dir, 'copy', 'manifest.json'), 'utf8'))
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
    await writeBackups([join(dir, 'backup')], manifest)
    const backup = await readFile(join(dir, 'backup', 'manifest.json'), 'utf8')

    expect(backup).toBe(primary)
    expect(backup.endsWith('\n')).toBe(true)
  })

  it('leaves the old copy alone when the new one cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const copy = join(dir, 'backup')
    await mkdir(copy, { recursive: true })
    // A folder where the copy's file should be: the rename cannot happen.
    await mkdir(join(copy, 'manifest.json'), { recursive: true })

    const result = await writeBackups([copy], emptyManifest())

    expect(result.failed).toEqual([copy])
    // The old thing is still there, and no debris was left behind.
    expect((await stat(join(copy, 'manifest.json'))).isDirectory()).toBe(true)
    expect(await readdir(copy)).toEqual(['manifest.json'])
  })

  it('keeps the previous good copy when a refresh cannot be finished', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    const copy = join(dir, 'backup')
    await writeBackups([copy], emptyManifest())
    const before = await readFile(join(copy, 'manifest.json'), 'utf8')

    // The temporary file the refresh writes through cannot be written, so
    // the refresh cannot be finished.
    await mkdir(join(copy, 'manifest.json.tmp'), { recursive: true })
    const result = await writeBackups([copy], emptyManifest())

    expect(result.failed).toEqual([copy])
    // The good copy is still there, byte for byte: a safety net that is
    // destroyed by the act of refreshing it is no safety net at all.
    expect(await readFile(join(copy, 'manifest.json'), 'utf8')).toBe(before)
  })

  it('says what happened when a copy cannot be written, and does not throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
    await writeFile(join(dir, 'blocker'), 'not a folder')
    const bad = join(dir, 'blocker', 'backup')
    const messages: string[] = []

    const result = await writeBackups([bad], emptyManifest(), (m) => messages.push(m))

    expect(result.failed).toEqual([bad])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(bad)
  })

  it('warns when there is no backup copy to write at all', async () => {
    const messages: string[] = []

    const result = await writeBackups([], emptyManifest(), (m) => messages.push(m))

    expect(result.written).toEqual([])
    expect(result.failed).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('no safety net')
  })

  it('keeps the default copy beside the manifest, not on a drive letter', () => {
    // The default used to be a hardcoded `E:\.drive-mirror-backup\`, which
    // every test run overwrote. A drive letter in the source is a bug
    // waiting to happen: the copy the app keeps must live with the app.
    expect(defaultSettings().backupPaths).toEqual([join(appDataDir(), 'backups')])
  })
})
