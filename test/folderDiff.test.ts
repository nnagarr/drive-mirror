import { describe, it, expect } from 'vitest'
import { planDeletedFolders } from '../src/core/folderDiff'
import type { LocalEntry, LocalTree } from '../src/core/types'

const PRESENT: LocalEntry = { state: 'present' }

function localTree(overrides: Partial<LocalTree> = {}): LocalTree {
  return {
    files: new Map(),
    dirs: new Set(),
    unreadableDirs: new Map(),
    recursiveCounts: {},
    ...overrides,
  }
}

describe('planDeletedFolders', () => {
  it('plans a Drive folder whose local directory is gone', () => {
    const driveDirs = new Map([['how do I write', 'DIR1']])
    const local = localTree()

    expect(planDeletedFolders(driveDirs, local)).toEqual([
      { relPath: 'how do I write', driveFolderId: 'DIR1' },
    ])
  })

  it('leaves a folder that still exists locally', () => {
    const driveDirs = new Map([['photos', 'DIR1']])
    const local = localTree({ dirs: new Set(['photos']) })

    expect(planDeletedFolders(driveDirs, local)).toEqual([])
  })

  it('names children before their parents', () => {
    const driveDirs = new Map([
      ['a', 'DIR_A'],
      ['a/b', 'DIR_B'],
    ])
    const local = localTree()

    const plan = planDeletedFolders(driveDirs, local)
    expect(plan.map((t) => t.relPath)).toEqual(['a/b', 'a'])
  })

  it('leaves a folder when a directory in its subtree could not be read', () => {
    const driveDirs = new Map([
      ['a', 'DIR_A'],
      ['a/b', 'DIR_B'],
    ])
    const local = localTree({
      dirs: new Set(['a/b']),
      unreadableDirs: new Map([['a/b', 'access denied']]),
    })

    // 'a' is gone locally, but its subtree could not be read, so the
    // absence of 'a' is not trustworthy.
    expect(planDeletedFolders(driveDirs, local)).toEqual([])
  })

  it('leaves a folder when a file under it is still present', () => {
    const driveDirs = new Map([['photos', 'DIR1']])
    const local = localTree({
      files: new Map([['photos/keep.txt', PRESENT]]),
    })

    expect(planDeletedFolders(driveDirs, local)).toEqual([])
  })

  it('does not let an absent or unknown file block the trash', () => {
    const driveDirs = new Map([['photos', 'DIR1']])
    const local = localTree({
      files: new Map([
        ['photos/old.txt', { state: 'absent' }],
        ['photos/maybe.txt', { state: 'unknown' }],
      ]),
    })

    expect(planDeletedFolders(driveDirs, local)).toEqual([
      { relPath: 'photos', driveFolderId: 'DIR1' },
    ])
  })
})
