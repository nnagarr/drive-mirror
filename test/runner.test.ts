import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSyncLock,
  createRunner,
  driveLetterOf,
  releaseSyncLock,
} from '../src/main/runner'
import { createManifestStore } from '../src/core/manifest'
import { FakeDrive } from './helpers/fakeDrive'
import { defaultSettings } from '../src/main/settings'
import type { AppEvent } from '../src/main/ipc'
import type { DriveNode, Manifest } from '../src/core/types'
import type { DriveClient } from '../src/drive/client'
import type { Settings } from '../src/main/settings'

/** A mirror folder on the fake Drive. */
const MIRROR_FOLDER_ID = 'FOLDER_MED'
const MY_DRIVE_ID = 'root'

/** Everything a test needs. */
interface Harness {
  dir: string
  root: string
  client: FakeDrive
  events: AppEvent[]
  logs: string[]
  store: ReturnType<typeof createManifestStore>
  settings: Settings
  manifestFile: string
  /** Where the runner's lock file lives. */
  lockPath: string
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

  const settings: Settings = {
    ...defaultSettings(),
    manifestPath: manifestFile,
    supersededPath: join(dir, 'superseded'),
    // The backup copy stays inside the test's own directory.
    backupPaths: [join(dir, 'backup')],
    // The mirrors are configuration: the settings say what is mirrored.
    mirrors: [{ name: 'Medicine', root, drivePath: 'Medicine', enabled: true }],
  }

  return {
    dir,
    root,
    client,
    events: [],
    logs: [],
    store,
    settings,
    manifestFile,
    lockPath: join(dir, 'sync.lock'),
  }
}

/** The runner under test. */
function runner(
  box: Harness,
  options: {
    client?: DriveClient
    accountEmail?: () => string | null | Promise<string | null>
  } = {},
) {
  return createRunner({
    client: options.client ?? box.client,
    store: box.store,
    settings: async () => box.settings,
    emit: (event) => box.events.push(event),
    log: (message) => box.logs.push(message),
    lockPath: box.lockPath,
    hasCredentials: () => true,
    accountEmail: options.accountEmail ?? (() => 'user@example.com'),
  })
}

/**
 * A Drive whose folder listing fails.
 *
 * It fails once, so a test can see both what a failed run does to the app
 * and what the run after it does.
 */
class BrokenDrive extends FakeDrive {
  /** How many more listings should fail. */
  broken = 1

  override async listChildren(folderId: string): Promise<DriveNode[]> {
    if (this.broken > 0) {
      this.broken -= 1
      throw new Error('boom')
    }
    return super.listChildren(folderId)
  }
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
    box.settings.mirrors[0]!.root = join(box.dir, 'not-there')

    const summary = await runner(box).syncNow()

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

    const state = await app.state()
    const card = state.mirrors.find((m) => m.name === 'Medicine')
    expect(card?.fileCount).toBe(2)
    // Nothing was written to Drive.
    expect(box.client.calls.some((c) => c.op === 'createFile')).toBe(false)
  })

  it('writes the backup inside the test directory and nowhere else', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow()

    const written = await readdir(join(box.dir, 'backup'))
    expect(written).toContain('manifest.json')
    expect(box.dir).toContain('dm-runner-')
    // Every copy the runner makes is inside the test's own directory. The
    // backup path used to be a hardcoded `E:\.drive-mirror-backup\`, so
    // every test run overwrote the user's own safety net.
    expect(box.settings.backupPaths.every((p) => p.startsWith(box.dir))).toBe(true)
  })

  it('does not fail the sync when a backup copy cannot be written', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    // A file where the backup folder should be: the copy cannot be made.
    await writeFile(join(box.dir, 'blocker'), 'not a folder')
    box.settings.backupPaths = [join(box.dir, 'blocker', 'backup')]

    const summary = await runner(box).syncNow()

    // The mirror did its work.
    expect(summary.uploaded).toBe(1)
    expect(summary.errors).toBe(0)
    expect(box.events.some((e) => e.type === 'finished')).toBe(true)
    // And the user was told why the safety net was not refreshed.
    expect(box.logs).toHaveLength(1)
    expect(box.logs[0]).toContain(join(box.dir, 'blocker', 'backup'))
  })

  it('does not fail a rebase when a backup copy cannot be written', async () => {
    const box = await harness()
    await writeFile(join(box.dir, 'blocker'), 'not a folder')
    box.settings.backupPaths = [join(box.dir, 'blocker', 'backup')]

    await expect(runner(box).rebase('Medicine')).resolves.toBeUndefined()

    expect(box.logs).toHaveLength(1)
  })

  it('writes a backup copy to every place the user keeps one', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    const second = join(box.dir, 'other-disk')
    box.settings.backupPaths = [join(box.dir, 'backup'), second]

    await runner(box).syncNow()

    expect(await readdir(join(box.dir, 'backup'))).toContain('manifest.json')
    expect(await readdir(second)).toContain('manifest.json')
  })

  it('writes the backup as the same bytes as the manifest file', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow()

    // The backup is a copy of the manifest the app just wrote, byte for
    // byte: a hand-diff of the two shows no differences.
    const manifest = await readFile(box.manifestFile, 'utf8')
    const backup = await readFile(join(box.dir, 'backup', 'manifest.json'), 'utf8')
    expect(backup).toBe(manifest)
  })

  it('runs once when two syncs are asked for at the same time', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    const app = runner(box)
    const [a, b] = await Promise.all([app.syncNow(), app.syncNow()])

    expect(a.uploaded).toBe(1)
    expect(b.uploaded).toBe(1)
    // The file was uploaded once, not twice. Two runs that read the
    // manifest at the same time would both see it as new, and the second
    // one would win the manifest.
    expect(box.client.calls.filter((c) => c.op === 'createFile')).toHaveLength(1)
  })

  it('does not stay stuck on syncing after a failure', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    const app = runner(box, { client: new BrokenDrive() })
    await expect(app.syncNow()).rejects.toThrow('boom')

    const state = await app.state()
    expect(state.running).toBe(false)
    expect(state.phase).toBe('idle')

    // And the next run is not blocked by the failed one.
    const second = await app.syncNow()
    expect(second.uploaded).toBe(1)
  })

  it('syncs a folder that was added while the app was running', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    const photos = join(box.dir, 'Photos')
    await mkdir(photos, { recursive: true })
    await writeFile(join(photos, 'b.psd'), 'local bytes')

    const app = runner(box)
    // The user adds a folder in the interface.
    box.settings.mirrors.push({
      name: 'Photos',
      root: photos,
      drivePath: 'Photos',
      enabled: true,
    })

    const summary = await app.syncNow()

    expect(summary.mirrors.map((m) => m.name)).toEqual(['Medicine', 'Photos'])
    expect(summary.uploaded).toBe(2)
  })

  it('shows a card for a folder that was added while the app was running', async () => {
    const box = await harness()
    const photos = join(box.dir, 'Photos')

    const app = runner(box)
    box.settings.mirrors.push({
      name: 'Photos',
      root: photos,
      drivePath: 'Photos',
      enabled: true,
    })

    const state = await app.state()

    expect(state.mirrors.map((m) => m.name)).toEqual(['Medicine', 'Photos'])
    expect(state.mirrors[1]?.localRoot).toBe(photos)
  })

  it('does not sync a mirror that is paused', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    box.settings.mirrors[0]!.enabled = false

    const summary = await runner(box).syncNow()

    expect(summary.uploaded).toBe(0)
    expect(summary.mirrors).toEqual([])
  })

  it('does not sync a mirror the user removed', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    box.settings.mirrors[0]!.removedAt = new Date().toISOString()

    const summary = await runner(box).syncNow()

    expect(summary.uploaded).toBe(0)
    expect(summary.mirrors).toEqual([])
  })

  it('reports no drive letter for a UNC path instead of guessing one', () => {
    expect(driveLetterOf('\\\\server\\share\\Docs')).toBeNull()
    expect(driveLetterOf('E:\\Docs')).toBe('E:')
    expect(driveLetterOf('c:\\Docs')).toBe('C:')
  })

  it('syncs a folder whose path has no drive letter, and records no volume', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    // The same folder, reached through the extended-length path: it has
    // no drive letter, so there is no volume to check.
    box.settings.mirrors[0]!.root = '\\\\?\\' + box.root

    const summary = await runner(box).syncNow()

    expect(summary.uploaded).toBe(1)
    const after = await box.store.read()
    expect(Object.keys(after.volumes)).toEqual([])
  })

  it('takes the lock once and refuses the second', async () => {
    const box = await harness()

    expect(await acquireSyncLock(box.lockPath, new Date())).toBe(true)
    expect(await acquireSyncLock(box.lockPath, new Date())).toBe(false)

    await releaseSyncLock(box.lockPath)
    expect(await acquireSyncLock(box.lockPath, new Date())).toBe(true)
    await releaseSyncLock(box.lockPath)
  })

  it('takes over a lock that is more than six hours old', async () => {
    const box = await harness()
    await writeFile(box.lockPath, 'held by a run that is long gone')
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
    await utimes(box.lockPath, old, old)

    expect(await acquireSyncLock(box.lockPath, new Date())).toBe(true)
    await releaseSyncLock(box.lockPath)
  })

  it('does not run while another process holds the lock', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    // Another process is syncing right now.
    await writeFile(box.lockPath, 'held')

    const summary = await runner(box).syncNow()

    expect(summary.uploaded).toBe(0)
    expect(box.client.calls.some((c) => c.op === 'createFile')).toBe(false)
    expect(box.logs.join('\n')).toContain('another sync was already running')
  })

  it('takes the lock for the run and gives it back afterwards', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow()

    expect(existsSync(box.lockPath)).toBe(false)
  })

  it('gives the lock back when the run fails', async () => {
    const box = await harness()

    const app = runner(box, { client: new BrokenDrive() })
    await expect(app.syncNow()).rejects.toThrow('boom')

    expect(existsSync(box.lockPath)).toBe(false)
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

describe('the lock between runs', () => {
  it('does not re-approve a drive while another sync holds the lock', async () => {
    const box = await harness()
    const r = runner(box)
    await acquireSyncLock(box.lockPath, new Date())
    await expect(r.rebase('Medicine')).rejects.toThrow(/another sync is running/i)
    const manifest = await box.store.read()
    expect(manifest.mirrors.Medicine).toBeUndefined()
  })

  it('says why a run was skipped when another sync holds the lock', async () => {
    const box = await harness()
    const r = runner(box)
    await acquireSyncLock(box.lockPath, new Date())
    const summary = await r.syncNow()
    expect(summary.reports.length).toBeGreaterThan(0)
    expect(summary.reports[0]!.message).toMatch(/another sync/i)
  })
})

describe('the manifest and the account that owns it', () => {
  it('blocks the run when the signed-in account is not the one that owns the manifest', async () => {
    const box = await harness()
    const manifest = await box.store.read()
    manifest.accountEmail = 'someone-else@example.com'
    await box.store.write(manifest)
    const r = runner(box, { accountEmail: async () => 'me@example.com' })

    const summary = await r.syncNow()

    expect(summary.errors).toBe(1)
    expect(summary.reports[0]?.message).toContain('someone-else@example.com')
    expect(summary.reports[0]?.message).toContain('me@example.com')
    expect(summary.uploaded).toBe(0)
  })

  it('records the account on the first run and does not block it', async () => {
    const box = await harness()
    const r = runner(box, { accountEmail: async () => 'me@example.com' })

    await r.syncNow()

    expect((await box.store.read()).accountEmail).toBe('me@example.com')
  })

  it('treats an account that is not a string as no account', async () => {
    const box = await harness()
    const manifest = await box.store.read()
    ;(manifest as { accountEmail: unknown }).accountEmail = 42
    await box.store.write(manifest)
    const r = runner(box, { accountEmail: async () => 'me@example.com' })

    const summary = await r.syncNow()

    expect(summary.errors).toBe(0)
  })
})
