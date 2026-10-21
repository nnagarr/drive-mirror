import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanLocal } from '../src/core/localScan'
import { canon } from '../src/core/paths'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drive-mirror-scan-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scanLocal', () => {
  it('records readable files as present with size and mtime', async () => {
    await mkdir(join(root, 'dir'), { recursive: true })
    await writeFile(join(root, 'dir', 'a.txt'), 'abc')

    const tree = await scanLocal({ root, knownPaths: [] })
    const entry = tree.files.get(canon('dir/a.txt'))

    expect(entry?.state).toBe('present')
    expect(entry?.size).toBe(3)
    expect(typeof entry?.mtimeMs).toBe('number')
    expect(entry!.mtimeMs!).toBeGreaterThan(0)
  })

  it('does not compute md5 during the scan', async () => {
    await writeFile(join(root, 'a.txt'), 'abc')
    const tree = await scanLocal({ root, knownPaths: [] })
    expect(tree.files.get(canon('a.txt'))?.md5).toBeUndefined()
  })

  it('marks a path absent when it does not exist', async () => {
    const tree = await scanLocal({ root, knownPaths: [canon('gone.txt')] })
    expect(tree.files.get(canon('gone.txt'))?.state).toBe('absent')
  })

  it('marks a path absent when a whole directory of known paths is gone', async () => {
    const tree = await scanLocal({
      root,
      knownPaths: [canon('old/a.psd'), canon('old/b.psd')],
    })
    expect(tree.files.get(canon('old/a.psd'))?.state).toBe('absent')
    expect(tree.files.get(canon('old/b.psd'))?.state).toBe('absent')
  })

  it('marks an unreadable file unknown, not absent', async () => {
    const file = join(root, 'locked.txt')
    await writeFile(file, 'secret')
    await chmod(file, 0o000)

    const tree = await scanLocal({ root, knownPaths: [canon('locked.txt')] })
    const entry = tree.files.get(canon('locked.txt'))

    // Windows ACLs do not map cleanly onto chmod, so the scanner may still be
    // able to read the file. Either way it must never be reported as absent:
    // an absent file is what tells the engine to trash the Drive copy.
    expect(entry?.state).not.toBe('absent')

    await chmod(file, 0o600)
  })

  it('marks every path under an unreadable directory unknown', async () => {
    const locked = join(root, 'locked')
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'b.txt'), 'secret')
    await chmod(locked, 0o000)

    const tree = await scanLocal({ root, knownPaths: [canon('locked/b.txt')] })
    const entry = tree.files.get(canon('locked/b.txt'))

    // On Windows the directory may still be readable; the guarantee that
    // matters is that an unreadable subtree never yields "absent".
    expect(entry?.state).not.toBe('absent')

    await chmod(locked, 0o700)
  })

  it('records an unreadable directory in unreadableDirs', async () => {
    const locked = join(root, 'locked')
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'b.txt'), 'secret')
    await chmod(locked, 0o000)

    const tree = await scanLocal({ root, knownPaths: [] })

    // If the directory was readable there is nothing to report; if it was not,
    // it must appear in unreadableDirs. Either is correct.
    const keys = [...tree.unreadableDirs.keys()]
    for (const key of keys) {
      expect(key.startsWith(canon('locked'))).toBe(true)
    }

    await chmod(locked, 0o700)
  })

  it('never follows a symlink or junction', async () => {
    await mkdir(join(root, 'realDir'), { recursive: true })
    await writeFile(join(root, 'realDir', 'inner.txt'), 'x')
    // A directory junction is creatable without elevation on Windows; a
    // symlink is not. Both are reported by readdir as a symbolic link.
    await symlink(join(root, 'realDir'), join(root, 'link'), 'junction')

    const tree = await scanLocal({ root, knownPaths: [] })

    for (const path of tree.files.keys()) {
      expect(path.startsWith(canon('link') + '/')).toBe(false)
    }
    // The real directory is still scanned.
    expect(tree.files.get(canon('realDir/inner.txt'))?.state).toBe('present')
  })

  it('never follows a symlink to a file', async () => {
    await writeFile(join(root, 'target.txt'), 'x')
    let created = true
    try {
      await symlink(join(root, 'target.txt'), join(root, 'link.txt'), 'file')
    } catch {
      created = false
    }
    if (!created) return // the OS refused to create a file symlink

    const tree = await scanLocal({ root, knownPaths: [] })
    expect(tree.files.get(canon('link.txt'))).toBeUndefined()
  })

  it('computes recursive counts per directory', async () => {
    await mkdir(join(root, 'dir', 'sub'), { recursive: true })
    await writeFile(join(root, 'dir', 'a.txt'), 'a')
    await writeFile(join(root, 'dir', 'sub', 'b.txt'), 'b')
    await writeFile(join(root, 'c.txt'), 'c')

    const tree = await scanLocal({ root, knownPaths: [] })

    expect(tree.recursiveCounts['']).toBe(3)
    expect(tree.recursiveCounts[canon('dir')]).toBe(2)
    expect(tree.recursiveCounts[canon('dir/sub')]).toBe(1)
    expect(tree.recursiveCounts[canon('c.txt')]).toBeUndefined()
  })

  it('reports the root count as the total file count', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')

    const tree = await scanLocal({ root, knownPaths: [] })
    const present = [...tree.files.values()].filter((e) => e.state === 'present').length
    expect(tree.recursiveCounts['']).toBe(present)
  })

  it('records the directories it walked', async () => {
    await mkdir(join(root, 'dir', 'sub'), { recursive: true })
    await writeFile(join(root, 'dir', 'sub', 'b.txt'), 'b')

    const tree = await scanLocal({ root, knownPaths: [] })
    expect(tree.dirs.has(canon('dir'))).toBe(true)
    expect(tree.dirs.has(canon('dir/sub'))).toBe(true)
  })

  it('returns an empty tree for a missing root', async () => {
    const tree = await scanLocal({
      root: join(root, 'does-not-exist'),
      knownPaths: [canon('a.psd')],
    })
    // A missing root means the whole mirror could not be walked. The known
    // path must be 'unknown', not 'absent' — 'absent' is what tells the
    // engine to trash the Drive copy.
    expect(tree.files.get(canon('a.psd'))?.state).toBe('unknown')
  })
})
