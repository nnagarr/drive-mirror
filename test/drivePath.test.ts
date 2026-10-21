import { describe, expect, it } from 'vitest'
import { FakeDrive } from './helpers/fakeDrive'
import { driveFolderNameOf, resolveMirrorPath, splitDrivePath } from '../src/core/drivePath'

describe('resolving a Drive destination', () => {
  it('splits a path into its segments', () => {
    expect(splitDrivePath('Archive/2026/Photos')).toEqual(['Archive', '2026', 'Photos'])
    expect(driveFolderNameOf('Archive/2026/Photos')).toBe('Photos')
  })

  it('creates the folders that do not exist, parents first', async () => {
    const drive = new FakeDrive()
    const result = await resolveMirrorPath(drive, 'Archive/2026/Photos', 'root')
    expect(result).not.toHaveProperty('ambiguous')
    const created = (result as { created: string[] }).created
    expect(created).toEqual(['Archive', '2026', 'Photos'])
    const tree = await drive.listChildren('root')
    expect(tree.map((n) => n.entry.name)).toEqual(['Archive'])
  })

  it('finds a destination that already exists instead of creating a second one', async () => {
    const drive = new FakeDrive()
    await drive.createFolder('Photos', 'root')
    const first = await resolveMirrorPath(drive, 'Photos', 'root')
    const second = await resolveMirrorPath(drive, 'Photos', 'root')
    expect((first as { id: string }).id).toBe((second as { id: string }).id)
    expect((second as { created: string[] }).created).toEqual([])
  })

  it('reports an ambiguous destination rather than guessing', async () => {
    const drive = new FakeDrive()
    await drive.createFolder('Photos', 'root')
    await drive.createFolder('Photos', 'root')
    const result = await resolveMirrorPath(drive, 'Photos', 'root')
    expect(result).toHaveProperty('ambiguous', true)
  })

  it('does not clobber a file that already sits where a folder should go', async () => {
    const drive = new FakeDrive()
    drive.add('F9', 'Photos', { parents: ['root'] })
    const result = await resolveMirrorPath(drive, 'Photos', 'root')
    expect(result).toHaveProperty('ambiguous', true)
  })

  it('uses the stored folder id even when the folder was renamed on Drive', async () => {
    const drive = new FakeDrive()
    const created = await drive.createFolder('Photos', 'root')
    const renamed = await drive.createFolder('Pictures', 'root')
    await drive.moveFolder(renamed.id, 'root', 'Holidays')
    const result = await resolveMirrorPath(drive, 'Photos', 'root', created.id)
    expect((result as { id: string }).id).toBe(created.id)
  })

  it('falls back to the path when the stored id is gone', async () => {
    const drive = new FakeDrive()
    await drive.createFolder('Photos', 'root')
    const result = await resolveMirrorPath(drive, 'Photos', 'root', 'F-missing')
    expect(result).not.toHaveProperty('ambiguous')
    expect((result as { created: string[] }).created).toEqual([])
  })

  it('walks into a folder that already exists', async () => {
    const drive = new FakeDrive()
    await drive.createFolder('Archive', 'root')
    const result = await resolveMirrorPath(drive, 'Archive/Photos', 'root')
    expect((result as { created: string[] }).created).toEqual(['Photos'])
  })
})
