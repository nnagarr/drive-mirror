import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_VERSION, emptyManifest } from '../src/core/manifest'
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
    expect(JSON.parse(await readFile(join(a, 'manifest.json'), 'utf8')).version).toBe(11)
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

  it('keeps the default copy beside the manifest, not on a drive letter', () => {
    // The default used to be a hardcoded `E:\.drive-mirror-backup\`, which
    // every test run overwrote. A drive letter in the source is a bug
    // waiting to happen: the copy the app keeps must live with the app.
    expect(defaultSettings().backupPaths).toEqual([join(appDataDir(), 'backups')])
  })
})
