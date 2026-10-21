import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createManifestStore,
  emptyManifest,
  emptyMirror,
  buildIndexes,
  applyManifestOp,
  serialiseManifest,
} from '../src/core/manifest'
import type { Manifest, RetiredRecord } from '../src/core/types'

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

/** The four trees the app was built for, with the file counts it shipped with. */
const SHIPPED_MIRRORS = [
  { name: 'Medicine', files: 43 },
  { name: 'graphicDesign', files: 43 },
  { name: 'videoEditing', files: 113 },
  { name: 'whoami', files: 55 },
]

/**
 * A version 10 manifest, as the app wrote it before it knew about an
 * account or a Drive destination.
 */
function version10Manifest(): Record<string, unknown> {
  const mirrors: Record<string, unknown> = {}
  for (const mirror of SHIPPED_MIRRORS) {
    const files: Record<string, unknown> = {}
    for (let i = 0; i < mirror.files; i += 1) {
      const path = `renders/scene-${i}.psd`
      files[path] = liveEntry(path)
    }
    mirrors[mirror.name] = {
      root: `E:\\${mirror.name}`,
      driveFolderName: mirror.name,
      lastCounts: { '': mirror.files },
      rebase: null,
      dirs: {},
      files,
      retired: {},
    }
  }
  return {
    version: 10,
    updatedAt: '2026-10-20T18:00:00.000Z',
    volumes: {
      'E:': { dev: 404660920, label: 'Local Disk', checkedAt: '2026-10-20T18:00:00.000Z' },
    },
    mirrors,
  }
}

describe('emptyManifest', () => {
  it('starts at version 11 with no volumes, no mirrors and no account', () => {
    const m = emptyManifest()
    expect(m.version).toBe(11)
    expect(m.volumes).toEqual({})
    expect(m.mirrors).toEqual({})
    expect(m.accountEmail).toBeNull()
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
    expect(m.version).toBe(11)
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

  it('writes the manifest as serialiseManifest writes it', async () => {
    const store = createManifestStore(dir)
    const m = emptyManifest()

    await store.checkpoint(m)

    // The file and the serialiser are the same bytes, so a copy of the
    // manifest written elsewhere cannot drift away from it.
    const written = await readFile(join(dir, 'manifest.json'), 'utf8')
    expect(written).toBe(serialiseManifest(m))
    expect(written.endsWith('\n')).toBe(true)
  })

  it('round-trips every manifest field through JSON', async () => {
    const store = createManifestStore(dir)
    const m = emptyManifest()
    m.volumes['E:'] = { dev: 404660920, label: 'Local Disk', checkedAt: '2026-10-21T09:59:00.000Z' }
    const mirror = emptyMirror('E:\\Medicine')
    mirror.drivePath = 'Archive/Medicine'
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
    expect(rm2.drivePath).toBe('Archive/Medicine')
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

  it('reads a version 10 manifest and keeps every mirror in it', async () => {
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: 10,
        updatedAt: '2026-01-01T00:00:00.000Z',
        volumes: {},
        mirrors: {
          Medicine: {
            root: 'E:\\Medicine',
            lastCounts: { '': 43 },
            rebase: null,
            dirs: {},
            files: {},
            retired: {},
          },
        },
      }),
      'utf8',
    )
    const store = createManifestStore(dir)
    const m = await store.read()
    expect(m.mirrors.Medicine?.root).toBe('E:\\Medicine')
    expect(m.accountEmail).toBeNull()
  })

  it('reads a version 10 manifest with the four trees the app was built for', async () => {
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(version10Manifest()), 'utf8')
    const store = createManifestStore(dir)
    const m = await store.read()

    expect(Object.keys(m.mirrors).sort()).toEqual([
      'Medicine',
      'graphicDesign',
      'videoEditing',
      'whoami',
    ])
    for (const mirror of SHIPPED_MIRRORS) {
      const read = m.mirrors[mirror.name]
      expect(read?.root).toBe(`E:\\${mirror.name}`)
      expect(Object.keys(read?.files ?? {})).toHaveLength(mirror.files)
      expect(Object.keys(read?.retired ?? {})).toHaveLength(0)
    }
    const files = Object.values(m.mirrors).reduce(
      (total, mirror) => total + Object.keys(mirror.files).length,
      0,
    )
    expect(files).toBe(254)
    expect(m.volumes['E:']?.dev).toBe(404660920)
    expect(m.accountEmail).toBeNull()
    // The file is read as it is: no rejection, no conversion, no data moved.
    expect(m.version).toBe(10)

    // Writing it back keeps every mirror and gains the field the file did
    // not have. Nothing is moved, nothing is dropped.
    await store.write(m)
    const written = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(Object.keys(written.mirrors).sort()).toEqual([
      'Medicine',
      'graphicDesign',
      'videoEditing',
      'whoami',
    ])
    expect(written.accountEmail).toBeNull()
    expect(written.version).toBe(11)
  })

  it('writes a version 10 manifest back as version 11 and keeps every record in it', async () => {
    const v10 = {
      version: 10,
      updatedAt: '2026-10-20T18:00:00.000Z',
      volumes: {},
      mirrors: {
        Medicine: {
          root: 'E:\\Medicine',
          driveFolderName: 'Medicine',
          lastCounts: { '': 43, incision: 29 },
          rebase: null,
          dirs: { incision: { driveFolderId: '1GhIjK' } },
          files: { 'renders/scene.psd': liveEntry('renders/scene.psd') },
          retired: {
            D1: retiredRecord('D1', 'old.psd', 'trashed', '2026-10-19T00:00:00.000Z'),
          },
        },
      },
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(v10), 'utf8')

    const store = createManifestStore(dir)
    const first = await store.read()
    await store.write(first)

    const written = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(written.version).toBe(11)
    expect(written.accountEmail).toBeNull()

    const again = await store.read()
    expect(again.version).toBe(11)
    expect(again.accountEmail).toBeNull()

    // The history is not moved. The file entry, the retired record, the
    // counts and the folder ids are the same as they were, byte for byte.
    const mirror = again.mirrors.Medicine!
    expect(mirror.root).toBe('E:\\Medicine')
    expect(JSON.stringify(mirror.files)).toBe(JSON.stringify(v10.mirrors.Medicine.files))
    expect(JSON.stringify(mirror.retired)).toBe(JSON.stringify(v10.mirrors.Medicine.retired))
    expect(JSON.stringify(mirror.lastCounts)).toBe(JSON.stringify(v10.mirrors.Medicine.lastCounts))
    expect(JSON.stringify(mirror.dirs)).toBe(JSON.stringify(v10.mirrors.Medicine.dirs))
  })

  it('checkpoints a version 10 manifest as version 11', async () => {
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: 10,
        updatedAt: '2026-10-20T18:00:00.000Z',
        volumes: {},
        mirrors: {},
      }),
      'utf8',
    )
    const store = createManifestStore(dir)
    const m = await store.read()
    await store.checkpoint(m)

    const written = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(written.version).toBe(11)
    expect(written.accountEmail).toBeNull()
  })

  it('writes version 11', async () => {
    const store = createManifestStore(dir)
    const m = await store.read()
    expect(m.version).toBe(11)
    expect(m.accountEmail).toBeNull()

    await store.write(m)
    const written = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(written.version).toBe(11)
    expect(written.accountEmail).toBeNull()
  })

  it('keeps the account through a round trip', async () => {
    const store = createManifestStore(dir)
    const m = await store.read()
    m.accountEmail = 'someone@example.com'
    await store.write(m)
    expect((await store.read()).accountEmail).toBe('someone@example.com')
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
