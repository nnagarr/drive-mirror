import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunner } from '../src/main/runner'
import { createManifestStore } from '../src/core/manifest'
import { FakeDrive } from './helpers/fakeDrive'
import { defaultSettings } from '../src/main/settings'
import type { AppEvent } from '../src/main/ipc'
import type { Manifest } from '../src/core/types'

/** A mirror folder on the fake Drive. */
const MIRROR_FOLDER_ID = 'FOLDER_MED'
const MY_DRIVE_ID = 'root'

/** Everything a test needs. */
interface Harness {
  dir: string
  root: string
  client: FakeDrive
  events: AppEvent[]
  store: ReturnType<typeof createManifestStore>
  settings: ReturnType<typeof defaultSettings>
  manifestFile: string
}

/** A sandbox with a mirror root and a Drive folder for it. */
async function harness(
  options: { manifest?: Manifest; withFolder?: boolean } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dm-runner-'))
  const root = join(dir, 'Medicine')
  await mkdir(root, { recursive: true })

  const client = new FakeDrive()
  if (options.withFolder !== false) {
    client.folders.set(MIRROR_FOLDER_ID, {
      id: MIRROR_FOLDER_ID,
      name: 'Medicine',
      parentId: MY_DRIVE_ID,
    })
  }

  const manifestFile = join(dir, 'state', 'manifest.json')
  const store = createManifestStore(join(dir, 'state'))
  if (options.manifest) {
    await store.write(options.manifest)
  }

  return {
    dir,
    root,
    client,
    events: [],
    store,
    settings: {
      ...defaultSettings(),
      manifestPath: manifestFile,
      supersededPath: join(dir, 'superseded'),
      // The backup copy stays inside the test's own directory.
      backupPaths: [join(dir, 'backup')],
    },
    manifestFile,
  }
}

/** The runner under test. */
function runner(box: Harness) {
  return createRunner({
    client: box.client,
    store: box.store,
    settings: box.settings,
    emit: (event) => box.events.push(event),
    mirrors: [{ name: 'Medicine', root: box.root }],
    hasCredentials: () => true,
    accountEmail: () => 'user@example.com',
  })
}

describe('the sync runner', () => {
  it('uploads a new local file', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    const summary = await runner(box).syncNow()

    expect(summary.uploaded).toBe(1)
    expect(summary.errors).toBe(0)
    const created = box.client.calls.find((c) => c.op === 'createFile')
    expect(created?.name).toBe('a.psd')
    expect(created?.parentId).toBe(MIRROR_FOLDER_ID)
  })

  it('trashes a Drive file when the local file was deleted', async () => {
    const box = await harness()
    box.client.add('D1', 'gone.psd', { parents: [MIRROR_FOLDER_ID] })

    // The manifest knows about the file, and the file is not on disk.
    const store = box.store
    const manifest = await store.read()
    manifest.mirrors['Medicine'] = {
      root: box.root,
      lastCounts: {},
      rebase: null,
      dirs: {},
      files: {
        'gone.psd': {
          displayPath: 'gone.psd',
          driveFileId: 'D1',
          driveMd5: 'md5-D1',
          driveModifiedTime: '2026-10-20T18:00:00.000Z',
          driveMimeType: 'application/octet-stream',
          exportMime: null,
          localPath: 'gone.psd',
          localMd5: 'md5-D1',
          localSize: 10,
          localMtimeMs: 1,
        },
      },
      retired: {},
    }
    await store.write(manifest)

    const summary = await runner(box).syncNow()

    expect(summary.trashed).toBe(1)
    const trashed = box.client.calls.find((c) => c.op === 'trash')
    expect(trashed?.id).toBe('D1')
    // The fake has no delete operation at all, so a permanent delete is
    // not something the app could do even by accident.
    expect(box.client.calls.map((c) => c.op)).not.toContain('delete')
  })

  it('skips a mirror whose root is missing and reports it', async () => {
    const box = await harness()
    const missing = join(box.dir, 'not-there')

    const summary = await createRunner({
      client: box.client,
      store: box.store,
      settings: box.settings,
      emit: (event) => box.events.push(event),
      mirrors: [{ name: 'Medicine', root: missing }],
      hasCredentials: () => true,
    }).syncNow()

    expect(summary.errors).toBe(0)
    const guard = box.events.find((e) => e.type === 'guard')
    expect(guard).toBeDefined()
    if (guard && guard.type === 'guard') {
      expect(guard.reason).toBe('missing-root')
      expect(guard.mirror).toBe('Medicine')
    }
  })

  it('blocks a mirror whose volume serial changed and reports a rebase', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    // Record a volume serial that is not this machine's.
    const store = box.store
    const manifest = await store.read()
    manifest.volumes[volumeLetter(box.root)] = {
      dev: 999999999,
      checkedAt: '2026-10-20T00:00:00.000Z',
    }
    await store.write(manifest)

    const summary = await runner(box).syncNow()

    expect(summary.uploaded).toBe(0)
    const guard = box.events.find((e) => e.type === 'guard')
    expect(guard).toBeDefined()
    if (guard && guard.type === 'guard') {
      expect(guard.reason).toBe('volume-changed')
      expect(guard.canOverride).toBe(true)
    }
    // Nothing was written.
    expect(box.client.calls.some((c) => c.op === 'createFile')).toBe(false)
  })

  it('emits a finished event with the five counts', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow()

    const finished = box.events.find((e) => e.type === 'finished')
    expect(finished).toBeDefined()
    if (finished && finished.type === 'finished') {
      expect(finished.summary.uploaded).toBe(1)
      expect(finished.summary.updated).toBe(0)
      expect(finished.summary.downloaded).toBe(0)
      expect(finished.summary.trashed).toBe(0)
      expect(finished.summary.errors).toBe(0)
    }
  })

  it('emits nothing but a quiet summary when nothing changed', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    // First run: the file is uploaded.
    await runner(box).syncNow()
    box.events.length = 0

    // Second run: nothing to do.
    const summary = await runner(box).syncNow()

    expect(summary.uploaded).toBe(0)
    expect(summary.downloaded).toBe(0)
    expect(summary.trashed).toBe(0)
    expect(summary.errors).toBe(0)
    const progress = box.events.filter((e) => e.type === 'progress')
    expect(progress).toEqual([])
  })

  it('does not update the count baseline when a guard skips the mirror', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    const store = box.store
    const manifest = await store.read()
    manifest.volumes[volumeLetter(box.root)] = {
      dev: 999999999,
      checkedAt: '2026-10-20T00:00:00.000Z',
    }
    manifest.mirrors['Medicine'] = {
      root: box.root,
      lastCounts: { '': 43, renders: 12 },
      rebase: null,
      dirs: {},
      files: {},
      retired: {},
    }
    await store.write(manifest)

    await runner(box).syncNow()

    const after = await store.read()
    expect(after.mirrors['Medicine']?.lastCounts).toEqual({ '': 43, renders: 12 })
  })

  it('updates the count baseline after a Sync anyway override', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    const store = box.store
    const manifest = await store.read()
    manifest.mirrors['Medicine'] = {
      root: box.root,
      // A baseline that says there used to be many more files.
      lastCounts: { '': 100 },
      rebase: null,
      dirs: {},
      files: {},
      retired: {},
    }
    await store.write(manifest)

    // Without the override the guard trips.
    const skipped = await runner(box).syncNow()
    expect(skipped.uploaded).toBe(0)
    const guard = box.events.find((e) => e.type === 'guard')
    expect(guard).toBeDefined()
    if (guard && guard.type === 'guard') {
      expect(guard.reason).toBe('count-drop')
      expect(guard.canOverride).toBe(true)
    }

    // With the override the mirror runs, and the baseline is updated.
    const overridden = await runner(box).syncNow('Medicine', { overrideGuard: true })
    expect(overridden.uploaded).toBe(1)

    const after = await store.read()
    expect(after.mirrors['Medicine']?.lastCounts['']).toBe(1)
  })

  it('writes only inside the resolved mirror folder', async () => {
    const box = await harness()
    await mkdir(join(box.root, 'sub'), { recursive: true })
    await writeFile(join(box.root, 'sub', 'a.psd'), 'local bytes')

    await runner(box).syncNow()

    const writes = box.client.calls.filter(
      (c) => c.op === 'createFile' || c.op === 'createFolder',
    )
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      // Every folder the run created must be inside the resolved mirror
      // folder, and every file must be inside a folder the run created or
      // found there.
      expect(
        isInside(box.client, write.parentId, MIRROR_FOLDER_ID),
        `${write.op} wrote under ${write.parentId}`,
      ).toBe(true)
    }
  })

  it('creates the Drive folder when it is missing', async () => {
    const box = await harness({ withFolder: false })
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow()

    const created = box.client.calls.find((c) => c.op === 'createFolder')
    expect(created?.name).toBe('Medicine')
    expect(created?.parentId).toBe(MY_DRIVE_ID)
  })

  it('fills in the file count without syncing anything', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    await writeFile(join(box.root, 'b.psd'), 'local bytes')

    const app = runner(box)
    await app.prime()

    const state = app.state()
    const card = state.mirrors.find((m) => m.name === 'Medicine')
    expect(card?.fileCount).toBe(2)
    // Nothing was written to Drive.
    expect(box.client.calls.some((c) => c.op === 'createFile')).toBe(false)
  })

  it('writes the backup copy inside the test directory', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow()

    const written = await readdir(join(box.dir, 'backup'))
    expect(written).toContain('manifest.json')
  })
})

/** The drive letter of a path, e.g. `C:`. */
function volumeLetter(root: string): string {
  const match = /^([a-zA-Z]):/.exec(root)
  return match ? `${match[1]!.toUpperCase()}:` : 'C:'
}

/**
 * True when a folder is the given folder, or lives inside it.
 *
 * My Drive itself is the one place outside the mirror: the mirror folder
 * is created there, and nothing else.
 */
function isInside(
  client: FakeDrive,
  folderId: string | undefined,
  ancestorId: string,
): boolean {
  if (!folderId) return false
  if (folderId === ancestorId) return true
  if (folderId === MY_DRIVE_ID) return false
  const folder = client.folders.get(folderId)
  if (!folder) return false
  return isInside(client, folder.parentId, ancestorId)
}
