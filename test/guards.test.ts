import { describe, it, expect } from 'vitest'
import {
  checkCountDrop,
  checkVolumeFingerprint,
  rebaseMirror,
} from '../src/core/guards'
import { emptyMirror } from '../src/core/manifest'
import { retired } from './helpers/fixtures'
import type { MirrorManifest } from '../src/core/types'

describe('checkCountDrop', () => {
  it('does not trip when exactly half the files remain', () => {
    expect(checkCountDrop({ '': 10 }, { '': 5 }, 5)).toEqual([])
  })

  it('trips when more than half the files are gone', () => {
    const hits = checkCountDrop({ '': 10 }, { '': 4 }, 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.dir).toBe('')
    expect(hits[0]?.last).toBe(10)
    expect(hits[0]?.current).toBe(4)
  })

  it('trips on a complete wipe of a small directory', () => {
    expect(checkCountDrop({ renders: 3 }, { renders: 0 }, 5)).toHaveLength(1)
  })

  it('does not trip on a small directory that lost one file', () => {
    expect(checkCountDrop({ renders: 3 }, { renders: 2 }, 5)).toEqual([])
  })

  it('trips on a directory that disappeared entirely', () => {
    // The directory is gone from disk, so it is not in the current counts.
    // It must still be compared, with a current count of zero.
    const hits = checkCountDrop({ renders: 12 }, {}, 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.dir).toBe('renders')
    expect(hits[0]?.current).toBe(0)
  })

  it('does not trip on a new directory with no baseline', () => {
    expect(checkCountDrop({}, { 'brand-new': 7 }, 5)).toEqual([])
  })

  it('reports every tripping directory', () => {
    // The root trips on the ratio, 'renders' on the ratio (6 -> 1 is more
    // than half), and 'renders/sub' on a complete wipe of a small
    // directory.
    const hits = checkCountDrop(
      { '': 10, renders: 6, 'renders/sub': 3 },
      { '': 2, renders: 1 },
      5,
    )
    expect(hits.map((h) => h.dir).sort()).toEqual(['', 'renders', 'renders/sub'])
  })

  it('applies the ratio rule only at or above the threshold', () => {
    // last=4, current=1: more than half is gone, but the directory is below
    // the threshold, so only a complete wipe would trip it.
    expect(checkCountDrop({ small: 4 }, { small: 1 }, 5)).toEqual([])
    // The same drop at the threshold does trip.
    expect(checkCountDrop({ small: 5 }, { small: 2 }, 5)).toHaveLength(1)
  })

  it('honours a different threshold', () => {
    // A drop of one file in a three-file directory is not a ratio drop, so
    // the threshold cannot rescue it either.
    expect(checkCountDrop({ renders: 3 }, { renders: 2 }, 1)).toEqual([])
    // With a threshold of one, the same directory losing two of three does
    // trip.
    expect(checkCountDrop({ renders: 3 }, { renders: 1 }, 1)).toHaveLength(1)
  })
})

describe('checkVolumeFingerprint', () => {
  it('reports no change when the serial matches', () => {
    expect(checkVolumeFingerprint({ dev: 404660920 }, { dev: 404660920 })).toBe(false)
  })

  it('reports a change when the serial differs', () => {
    expect(checkVolumeFingerprint({ dev: 404660920 }, { dev: 999999 })).toBe(true)
  })

  it('reports no change when there is no recorded fingerprint', () => {
    expect(checkVolumeFingerprint(undefined, { dev: 1 })).toBe(false)
  })
})

describe('rebaseMirror', () => {
  function mirrorWith(): MirrorManifest {
    const m = emptyMirror('E:\\Medicine')
    m.files['a.psd'] = {
      displayPath: 'a.psd',
      driveFileId: 'D1',
      driveMd5: 'm1',
      driveModifiedTime: '2026-10-20T18:00:00.000Z',
      driveMimeType: 'application/octet-stream',
      exportMime: null,
      localPath: 'a.psd',
      localMd5: 'm1',
      localSize: 1024,
      localMtimeMs: 1759660800000,
    }
    m.dirs['renders'] = { driveFolderId: 'DIR1' }
    m.lastCounts = { '': 43, renders: 12 }
    m.retired['D7'] = retired('D7', 'old.psd', 'trashed', {
      md5: 'm0',
    })
    return m
  }

  it('converts live entries into rebased retired records', () => {
    const m = rebaseMirror(mirrorWith(), '2026-10-21T00:00:00.000Z')

    expect(Object.keys(m.files)).toEqual([])
    expect(m.retired['D1']?.state).toBe('rebased')
    expect(m.retired['D1']?.path).toBe('a.psd')
    expect(m.retired['D1']?.prevLocalMd5).toBe('m1')
    expect(m.retired['D1']?.id).toBe('D1')
  })

  it('keeps the root and clears counts and dirs', () => {
    const m = rebaseMirror(mirrorWith(), '2026-10-21T00:00:00.000Z')
    expect(m.root).toBe('E:\\Medicine')
    expect(m.lastCounts).toEqual({})
    expect(m.dirs).toEqual({})
  })

  it('preserves existing retired records', () => {
    const m = rebaseMirror(mirrorWith(), '2026-10-21T00:00:00.000Z')
    expect(m.retired['D7']?.state).toBe('trashed')
  })

  it('replaces a stale resynced record rather than keeping it', () => {
    // A resynced record left over from an earlier restore would make the
    // next run skip the path and download a file the user deleted.
    const before = mirrorWith()
    before.retired['D1'] = retired('D1', 'a.psd', 'resynced')
    const m = rebaseMirror(before, '2026-10-21T00:00:00.000Z')
    expect(m.retired['D1']?.state).toBe('rebased')
  })

  it('sets the rebase pending flag with drive-wins', () => {
    const m = rebaseMirror(mirrorWith(), '2026-10-21T00:00:00.000Z')
    expect(m.rebase).toEqual({ pending: true, mergePolicy: 'drive-wins' })
  })

  it('does not modify the mirror it was given', () => {
    const before = mirrorWith()
    rebaseMirror(before, '2026-10-21T00:00:00.000Z')
    expect(Object.keys(before.files)).toEqual(['a.psd'])
    expect(before.lastCounts).toEqual({ '': 43, renders: 12 })
  })
})
