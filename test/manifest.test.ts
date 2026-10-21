import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createManifestStore,
  emptyManifest,
  emptyMirror,
  buildIndexes,
  applyManifestOp,
} from '../src/core/manifest'
import type { Manifest, MirrorManifest, RetiredRecord } from '../src/core/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drive-mirror-manifest-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function liveEntry(path: string): Manifest['mirrors'][string]['files'][string] {
  return {
    displayPath: path,
    driveFileId: '1XyZ',
    driveMd5: 'abc123',
    driveModifiedTime: '2026-10-20T18:00:00.000Z',
    driveMimeType: 'application/octet-stream',
    exportMime: null,
    localPath: path,
    localMd5: 'abc123',
    localSize: 1024,
    localMtimeMs: 1759660800000,
  }
}

function retiredRecord(
  id: string,
  path: string,
  state: RetiredRecord['state'],
  at: string,
): RetiredRecord {
  return {
    id,
    path,
    state,
    at,
    md5: '77aa',
    driveMimeType: 'application/octet-stream',
    localPath: null,
  }
}

const ALL_STATES: RetiredRecord['state'][] = [
  'trashed',
  'trashed-externally',
  'gone',
  'restored',
  'purged',
  'moved',
  'rebased',
  'resynced',
]

describe('emptyManifest', () => {
  it('starts at version 10 with no volumes and no mirrors', () => {
    const m = emptyManifest()
    expect(m.version).toBe(10)
    expect(m.volumes).toEqual({})
    expect(m.mirrors).toEqual({})
    expect(typeof m.updatedAt).toBe('string')
  })
})

describe('emptyMirror', () => {
  it('starts with empty maps and a null rebase', () => {
    const m = emptyMirror('E:\\Medicine')
    expect(m.root).toBe('E:\\Medicine')
    expect(m.files).toEqual({})
    expect(m.retired).toEqual({})
    expect(m.dirs).toEqual({})
    expect(m.lastCounts).toEqual({})
    expect(m.rebase).toBeNull()
  })
})

describe('manifest store', () => {
  it('reads an empty manifest when no file exists', async () => {
    const store = createManifestStore(dir)
    const m = await store.read()
    expect(m.version).toBe(10)
    expect(m.mirrors).toEqual({})
  })

  it('writes the manifest atomically', async () => {
    const store = createManifestStore(dir)
    const m = emptyManifest()
    m.mirrors['Medicine'] = emptyMirror('E:\\Medicine')
    await store.write(m)

    const read = await store.read()
    expect(read.mirrors['Medicine']?.root).toBe('E:\\Medicine')
    expect(existsSync(join(dir, 'manifest.json.tmp'))).toBe(false)
  })

  it('round-trips every manifest field through JSON', async () => {
    const store = createManifestStore(dir)
    const m = emptyManifest()
    m.volumes['E:'] = { dev: 404660920, label: 'Local Disk', checkedAt: '2026-10-21T09:59:00.000Z' }
    const mirror = emptyMirror('E:\\Medicine')
    mirror.driveFolderId = '1AbCdEf'
    mirror.driveFolderName = 'Medicine'
    mirror.lastSyncAt = '2026-10-21T09:59:00.000Z'
    mirror.lastCounts = { '': 43, incision: 29 }
    mirror.dirs = { incision: { driveFolderId: '1GhIjK' } }
    mirror.files['renders/scene.psd'] = liveEntry('renders/scene.psd')
    ALL_STATES.forEach((state, i) => {
      mirror.retired[`id${i}`] = retiredRecord(`id${i}`, `path${i}.psd`, state, `2026-10-20T0${i}:00:00.000Z`)
    })
    mirror.rebase = { pending: true, mergePolicy: 'drive-wins' }
    m.mirrors['Medicine'] = mirror

    await store.write(m)
    const read = await store.read()

    expect(read.volumes['E:']?.dev).toBe(404660920)
    const rm2 = read.mirrors['Medicine']!
    expect(rm2.driveFolderId).toBe('1AbCdEf')
    expect(rm2.lastCounts).toEqual({ '': 43, incision: 29 })
    expect(rm2.dirs).toEqual({ incision: { driveFolderId: '1GhIjK' } })
    expect(rm2.files['renders/scene.psd']?.driveFileId).toBe('1XyZ')
    expect(Object.keys(rm2.retired)).toHaveLength(8)
    expect(rm2.rebase).toEqual({ pending: true, mergePolicy: 'drive-wins' })
  })

  it('appends journal lines and replays them onto a checkpoint', async () => {
    const store = createManifestStore(dir)
    const base = emptyManifest()
    base.mirrors['Medicine'] = emptyMirror('E:\\Medicine')
    base.mirrors['whoami'] = emptyMirror('E:\\whoami')
    await store.checkpoint(base)

    await store.appendJournal({
      op: 'change',
      mirror: 'Medicine',
      change: { op: 'set-file', path: 'a.psd', entry: liveEntry('a.psd') },
    })
    await store.appendJournal({
      op: 'change',
      mirror: 'Medicine',
      change: {
        op: 'set-retired',
        id: 'D1',
        record: retiredRecord('D1', 'a.psd', 'trashed', '2026-10-20T00:00:00.000Z'),
      },
    })

    const journal = await store.readJournal()
    expect(journal).toHaveLength(2)

    const replayed = await store.replayJournal(base)
    expect(replayed.mirrors['Medicine']?.files['a.psd']?.driveFileId).toBe('1XyZ')
    expect(replayed.mirrors['Medicine']?.retired['D1']?.state).toBe('trashed')
  })

  it('replays a journalled change only into the mirror it names', async () => {
    const store = createManifestStore(dir)
    const base = emptyManifest()
    base.mirrors['Medicine'] = emptyMirror('E:\\Medicine')
    base.mirrors['whoami'] = emptyMirror('E:\\whoami')
    await store.checkpoint(base)

    await store.appendJournal({
      op: 'change',
      mirror: 'Medicine',
      change: { op: 'set-file', path: 'a.psd', entry: liveEntry('a.psd') },
    })

    const replayed = await store.replayJournal(base)
    expect(replayed.mirrors['Medicine']?.files['a.psd']).toBeDefined()
    expect(replayed.mirrors['whoami']?.files['a.psd']).toBeUndefined()
  })

  it('skips intent ops when replaying', async () => {
    const store = createManifestStore(dir)
    const base = emptyManifest()
    base.mirrors['Medicine'] = emptyMirror('E:\\Medicine')
    await store.checkpoint(base)

    await store.appendJournal({
      op: 'intent',
      kind: 'create-upload',
      mirror: 'Medicine',
      path: 'a.psd',
      localMd5: 'abc',
      size: 10,
    })

    const replayed = await store.replayJournal(base)
    expect(replayed.mirrors['Medicine']?.files['a.psd']).toBeUndefined()
  })

  it('skips journal lines that fail to parse', async () => {
    const store = createManifestStore(dir)
    await writeFile(
      join(dir, 'journal.ndjson'),
      'not json\n{"op":"change","mirror":"Medicine","change":{"op":"del-file","path":"x.psd"}}\n',
      'utf8',
    )
    const journal = await store.readJournal()
    expect(journal).toHaveLength(1)
    expect(journal[0]?.op).toBe('change')
  })

  it('never prunes retired records', async () => {
    const store = createManifestStore(dir)
    const m = emptyManifest()
    const mirror = emptyMirror('E:\\Medicine')
    mirror.files['a.psd'] = liveEntry('a.psd')
    m.mirrors['Medicine'] = mirror

    await store.write(m)

    const after = await store.read()
    const mirrorAfter = after.mirrors['Medicine']!
    applyManifestOp(mirrorAfter, {
      op: 'set-retired',
      id: 'D1',
      record: retiredRecord('D1', 'a.psd', 'trashed', '2026-10-20T00:00:00.000Z'),
    })
    applyManifestOp(mirrorAfter, { op: 'del-file', path: 'a.psd' })
    await store.write(after)

    const final = await store.read()
    expect(final.mirrors['Medicine']?.retired['D1']?.state).toBe('trashed')
    expect(final.mirrors['Medicine']?.files['a.psd']).toBeUndefined()
  })

  it('refreshes at on every state transition', async () => {
    const m = emptyManifest()
    const mirror = emptyMirror('E:\\Medicine')
    m.mirrors['Medicine'] = mirror

    const first: RetiredRecord = retiredRecord('D1', 'a.psd', 'trashed', '2026-10-20T00:00:00.000Z')
    applyManifestOp(mirror, { op: 'set-retired', id: 'D1', record: first })
    expect(mirror.retired['D1']?.at).toBe('2026-10-20T00:00:00.000Z')

    const second: RetiredRecord = { ...first, state: 'restored' }
    applyManifestOp(mirror, { op: 'set-retired', id: 'D1', record: second })
    expect(mirror.retired['D1']?.state).toBe('restored')
    expect(mirror.retired['D1']!.at >= first.at).toBe(true)
    expect(mirror.retired['D1']!.at).not.toBe('2026-10-20T00:00:00.000Z')
  })

  it('preserves at when the state is unchanged', async () => {
    const m = emptyManifest()
    const mirror = emptyMirror('E:\\Medicine')
    m.mirrors['Medicine'] = mirror

    const rec: RetiredRecord = retiredRecord('D1', 'a.psd', 'trashed', '2026-10-20T00:00:00.000Z')
    applyManifestOp(mirror, { op: 'set-retired', id: 'D1', record: rec })
    applyManifestOp(mirror, { op: 'set-retired', id: 'D1', record: { ...rec } })
    expect(mirror.retired['D1']?.at).toBe('2026-10-20T00:00:00.000Z')
  })
})

describe('buildIndexes', () => {
  it('builds retiredByPath newest-first', () => {
    const m = emptyManifest()
    const mirror = emptyMirror('E:\\Medicine')
    mirror.retired['old'] = retiredRecord('old', 'a.psd', 'trashed', '2026-10-01T00:00:00.000Z')
    mirror.retired['mid'] = retiredRecord('mid', 'a.psd', 'trashed', '2026-10-02T00:00:00.000Z')
    mirror.retired['new'] = retiredRecord('new', 'a.psd', 'trashed', '2026-10-03T00:00:00.000Z')
    m.mirrors['Medicine'] = mirror

    const { retiredByPath } = buildIndexes(mirror)
    const at = retiredByPath.get('a.psd')!
    expect(at.map((r) => r.path)).toEqual(['a.psd', 'a.psd', 'a.psd'])
    expect(at[0]!.at >= at[1]!.at).toBe(true)
    expect(at[2]!.at <= at[1]!.at).toBe(true)
  })

  it('builds retiredById keyed by drive file id', () => {
    const m = emptyManifest()
    const mirror = emptyMirror('E:\\Medicine')
    mirror.retired['1XyZ'] = retiredRecord('1XyZ', 'a.psd', 'trashed', '2026-10-03T00:00:00.000Z')
    m.mirrors['Medicine'] = mirror

    const { retiredById } = buildIndexes(mirror)
    expect(retiredById.get('1XyZ')?.path).toBe('a.psd')
  })

  it('keys retiredByPath by the canonical path', () => {
    const m = emptyManifest()
    const mirror = emptyMirror('E:\\Medicine')
    mirror.retired['1XyZ'] = retiredRecord('1XyZ', 'Renders/Final/Scene.PSD', 'trashed', '2026-10-03T00:00:00.000Z')
    m.mirrors['Medicine'] = mirror

    const { retiredByPath } = buildIndexes(mirror)
    expect(retiredByPath.get('renders/final/scene.psd')).toHaveLength(1)
  })
})
