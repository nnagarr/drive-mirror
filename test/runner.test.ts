import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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
import { defaultAppSettings } from '../src/main/settings'
import { defaultAccountSettings } from '../src/main/accountSettings'
import type { AppEvent } from '../src/main/ipc'
import type { DriveNode, Manifest } from '../src/core/types'
import type { DriveClient } from '../src/drive/client'
import type { AppSettings } from '../src/main/settings'
import type { AccountSettings } from '../src/main/accountSettings'

/** The account the runner runs. */
const ACC = 'acc_test'

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
  /** The account's settings: its mirrors, its schedule. */
  settings: AccountSettings
  /** The app's own settings: the list of accounts, the guard threshold. */
  appSettings: AppSettings
  /** Where copies of the manifest are kept. */
  backupPaths: string[]
  /** The address of the account the app is showing. */
  email: string
  manifestFile: string
  /** Where the runner's lock file lives. */
  lockPath: string
  /**
   * A second account, with a mirror of the same name, its own folder, its
   * own Drive and its own manifest.
   */
  second: {
    id: string
    root: string
    client: FakeDrive
    store: ReturnType<typeof createManifestStore>
    settings: AccountSettings
  }
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

  const settings: AccountSettings = {
    ...defaultAccountSettings(),
    // The mirrors are configuration: the settings say what is mirrored.
    mirrors: [{ name: 'Medicine', root, drivePath: 'Medicine', enabled: true }],
  }

  const secondRoot = join(dir, 'Second')
  await mkdir(secondRoot, { recursive: true })
  const secondClient = new FakeDrive()
  secondClient.folders.set(MIRROR_FOLDER_ID, {
    id: MIRROR_FOLDER_ID,
    name: 'Medicine',
    parentId: MY_DRIVE_ID,
  })
  const secondStore = createManifestStore(join(dir, 'second-state'))
  const secondSettings: AccountSettings = {
    ...defaultAccountSettings(),
    // The same mirror name, in a different folder: two accounts, two
    // mirrors, no shared state.
    mirrors: [{ name: 'Medicine', root: secondRoot, drivePath: 'Medicine', enabled: true }],
  }

  const appSettings: AppSettings = {
    ...defaultAppSettings(),
    accounts: [
      {
        id: 'acc_test',
        email: 'user@example.com',
        addedAt: '2026-10-22T00:00:00.000Z',
        signedIn: true,
        mirrorCount: 1,
        hasNotice: false,
      },
      {
        id: 'acc_second',
        email: 'second@example.com',
        addedAt: '2026-10-22T00:00:00.000Z',
        signedIn: true,
        mirrorCount: 1,
        hasNotice: false,
      },
    ],
    currentAccountId: 'acc_test',
  }

  return {
    dir,
    root,
    client,
    events: [],
    logs: [],
    store,
    settings,
    appSettings,
    backupPaths: [join(dir, 'backup')],
    email: 'user@example.com',
    second: {
      id: 'acc_second',
      root: secondRoot,
      client: secondClient,
      store: secondStore,
      settings: secondSettings,
    },
    manifestFile,
    lockPath: join(dir, 'sync.lock'),
  }
}

/** The runner under test. */
function runner(
  box: Harness,
  options: {
    client?: DriveClient
    /** The address of the account the app is showing. */
    email?: string
    appSettings?: () => Promise<AppSettings>
    settings?: () => Promise<AccountSettings>
    /** How long to keep trying for the lock. */
    lockWait?: { attempts: number; intervalMs: number }
    /** Waiting, in a way the test can stand in for. */
    sleep?: (ms: number) => Promise<void>
  } = {},
) {
  const appSettings = async (): Promise<AppSettings> => {
    const base = options.appSettings ? await options.appSettings() : box.appSettings
    return {
      ...base,
      accounts: base.accounts.map((account) =>
        account.id === box.second.id
          ? account
          : { ...account, email: options.email ?? box.email },
      ),
    }
  }
  return createRunner({
    // The account the run is for, and everything it needs.
    account: async (id) => {
      if (id === box.second.id) {
        return {
          id: box.second.id,
          email: 'second@example.com',
          signedIn: true,
          client: box.second.client,
          store: box.second.store,
          settings: async () => box.second.settings,
        }
      }
      return {
        id,
        email: options.email ?? box.email,
        signedIn: true,
        client: options.client ?? box.client,
        store: box.store,
        settings: options.settings ?? (async () => box.settings),
      }
    },
    appSettings,
    // The backup copy stays inside the test's own directory.
    backupPaths: async () => box.backupPaths,
    saveAccountSettings: async (_id, patch) => {
      Object.assign(box.settings, patch)
      return box.settings
    },
    emit: (event) => box.events.push(event),
    log: (message) => box.logs.push(message),
    lockPath: box.lockPath,
    lockWait: options.lockWait,
    sleep: options.sleep,
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

    const summary = await runner(box).syncNow(ACC)

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

    const summary = await runner(box).syncNow(ACC)

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

    const summary = await runner(box).syncNow(ACC)

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

    const summary = await runner(box).syncNow(ACC)

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

  it('waits for the run in flight before it says the account is idle', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    const r = runner(box)

    const run = r.syncNow(ACC)
    await r.whenIdle(ACC)

    expect((await r.state(ACC)).running).toBe(false)
    await run
  })

  it('emits a finished event with the five counts', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow(ACC)

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
    await runner(box).syncNow(ACC)
    box.events.length = 0

    // Second run: nothing to do.
    const summary = await runner(box).syncNow(ACC)

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

    await runner(box).syncNow(ACC)

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
    const skipped = await runner(box).syncNow(ACC)
    expect(skipped.uploaded).toBe(0)
    const guard = box.events.find((e) => e.type === 'guard')
    expect(guard).toBeDefined()
    if (guard && guard.type === 'guard') {
      expect(guard.reason).toBe('count-drop')
      expect(guard.canOverride).toBe(true)
    }

    // With the override the mirror runs, and the baseline is updated.
    const overridden = await runner(box).syncNow(ACC, 'Medicine', { overrideGuard: true })
    expect(overridden.uploaded).toBe(1)

    const after = await store.read()
    expect(after.mirrors['Medicine']?.lastCounts['']).toBe(1)
  })

  it('writes only inside the resolved mirror folder', async () => {
    const box = await harness()
    await mkdir(join(box.root, 'sub'), { recursive: true })
    await writeFile(join(box.root, 'sub', 'a.psd'), 'local bytes')

    await runner(box).syncNow(ACC)

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

    await runner(box).syncNow(ACC)

    const created = box.client.calls.find((c) => c.op === 'createFolder')
    expect(created?.name).toBe('Medicine')
    expect(created?.parentId).toBe(MY_DRIVE_ID)
  })

  it('fills in the file count without syncing anything', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    await writeFile(join(box.root, 'b.psd'), 'local bytes')

    const app = runner(box)
    await app.prime(ACC)

    const state = await app.state(ACC)
    const card = state.mirrors.find((m) => m.name === 'Medicine')
    expect(card?.fileCount).toBe(2)
    // Nothing was written to Drive.
    expect(box.client.calls.some((c) => c.op === 'createFile')).toBe(false)
  })

  it('writes the backup inside the test directory and nowhere else', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow(ACC)

    // Each account's copy lives in a folder of its own.
    const written = await readdir(join(box.dir, 'backup'))
    expect(written).toContain('user@example.com')
    expect(await readdir(join(box.dir, 'backup', 'user@example.com'))).toContain('manifest.json')
    expect(box.dir).toContain('dm-runner-')
    // Every copy the runner makes is inside the test's own directory. The
    // backup path used to be a hardcoded `E:\.drive-mirror-backup\`, so
    // every test run overwrote the user's own safety net.
    expect(box.backupPaths.every((p) => p.startsWith(box.dir))).toBe(true)
  })

  it('does not fail the sync when a backup copy cannot be written', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    // A file where the backup folder should be: the copy cannot be made.
    await writeFile(join(box.dir, 'blocker'), 'not a folder')
    box.backupPaths = [join(box.dir, 'blocker', 'backup')]

    const summary = await runner(box).syncNow(ACC)

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
    box.backupPaths = [join(box.dir, 'blocker', 'backup')]

    await expect(runner(box).rebase(ACC, 'Medicine')).resolves.toBeUndefined()

    expect(box.logs).toHaveLength(1)
  })

  it('writes a backup copy to every place the user keeps one', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    const second = join(box.dir, 'other-disk')
    box.backupPaths = [join(box.dir, 'backup'), second]

    await runner(box).syncNow(ACC)

    expect(await readdir(join(box.dir, 'backup'))).toContain('user@example.com')
    expect(await readdir(second)).toContain('user@example.com')
  })

  it('writes the backup as the same bytes as the manifest file', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow(ACC)

    // The backup is a copy of the manifest the app just wrote, byte for
    // byte: a hand-diff of the two shows no differences.
    const manifest = await readFile(box.manifestFile, 'utf8')
    const backup = await readFile(
      join(box.dir, 'backup', 'user@example.com', 'manifest.json'),
      'utf8',
    )
    expect(backup).toBe(manifest)
  })

  it('runs once when two syncs are asked for at the same time', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    const app = runner(box)
    const [a, b] = await Promise.all([app.syncNow(ACC), app.syncNow(ACC)])

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
    await expect(app.syncNow(ACC)).rejects.toThrow('boom')

    const state = await app.state(ACC)
    expect(state.running).toBe(false)
    expect(state.phase).toBe('idle')

    // And the next run is not blocked by the failed one.
    const second = await app.syncNow(ACC)
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

    const summary = await app.syncNow(ACC)

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

    const state = await app.state(ACC)

    expect(state.mirrors.map((m) => m.name)).toEqual(['Medicine', 'Photos'])
    expect(state.mirrors[1]?.localRoot).toBe(photos)
  })

  it('does not sync a mirror that is paused', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    box.settings.mirrors[0]!.enabled = false

    const summary = await runner(box).syncNow(ACC)

    expect(summary.uploaded).toBe(0)
    expect(summary.mirrors).toEqual([])
  })

  it('does not sync a mirror the user removed', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    box.settings.mirrors[0]!.removedAt = new Date().toISOString()

    const summary = await runner(box).syncNow(ACC)

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

    const summary = await runner(box).syncNow(ACC)

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

    const summary = await runner(box, { lockWait: { attempts: 2, intervalMs: 1 } }).syncNow(ACC)

    expect(summary.uploaded).toBe(0)
    expect(summary.skipped).toBe(true)
    expect(box.client.calls.some((c) => c.op === 'createFile')).toBe(false)
    expect(box.logs.join('\n')).toContain('another sync was already running')
  })

  it('waits for the lock and runs when it is free', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')
    // Another process is syncing right now.
    await writeFile(box.lockPath, 'held')

    // The other process lets go while this run is waiting for it.
    const r = runner(box, {
      lockWait: { attempts: 5, intervalMs: 1 },
      sleep: async () => {
        await rm(box.lockPath, { force: true })
      },
    })
    const summary = await r.syncNow(ACC)

    expect(summary.skipped).toBeUndefined()
    expect(summary.uploaded).toBe(1)
  })

  it('takes the lock for the run and gives it back afterwards', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'local bytes')

    await runner(box).syncNow(ACC)

    expect(existsSync(box.lockPath)).toBe(false)
  })

  it('gives the lock back when the run fails', async () => {
    const box = await harness()

    const app = runner(box, { client: new BrokenDrive() })
    await expect(app.syncNow(ACC)).rejects.toThrow('boom')

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
    await expect(r.rebase(ACC, 'Medicine')).rejects.toThrow(/another sync is running/i)
    const manifest = await box.store.read()
    expect(manifest.mirrors.Medicine).toBeUndefined()
  })

  it('says why a run was skipped when another sync holds the lock', async () => {
    const box = await harness()
    const r = runner(box, { lockWait: { attempts: 2, intervalMs: 1 } })
    await acquireSyncLock(box.lockPath, new Date())
    const summary = await r.syncNow(ACC)
    expect(summary.reports.length).toBeGreaterThan(0)
    expect(summary.reports[0]!.message).toMatch(/another sync/i)
    // A run that did not happen is not recorded as having happened, so the
    // slot is caught up rather than lost.
    expect(summary.skipped).toBe(true)
  })
})

describe('the manifest and the account that owns it', () => {
  it('blocks the run when the signed-in account is not the one that owns the manifest', async () => {
    const box = await harness()
    const manifest = await box.store.read()
    manifest.accountEmail = 'someone-else@example.com'
    await box.store.write(manifest)
    const r = runner(box, { email: 'me@example.com' })

    const summary = await r.syncNow(ACC)

    expect(summary.errors).toBe(1)
    expect(summary.reports[0]?.message).toContain('someone-else@example.com')
    expect(summary.reports[0]?.message).toContain('me@example.com')
    expect(summary.uploaded).toBe(0)
  })

  it('records the account on the first run and does not block it', async () => {
    const box = await harness()
    const r = runner(box, { email: 'me@example.com' })

    await r.syncNow(ACC)

    expect((await box.store.read()).accountEmail).toBe('me@example.com')
  })

  it('keeps two accounts apart when they hold a mirror with the same name', async () => {
    const box = await harness()
    // Two files in the first account's folder, one in the second's.
    await writeFile(join(box.root, 'a.psd'), 'one')
    await writeFile(join(box.root, 'b.psd'), 'two')
    await writeFile(join(box.second.root, 'a.psd'), 'one')

    const r = runner(box)
    await r.syncNow(ACC)
    await r.syncNow(box.second.id)

    const a = await r.state(ACC)
    const b = await r.state(box.second.id)
    expect(a.mirrors[0]?.name).toBe('Medicine')
    expect(b.mirrors[0]?.name).toBe('Medicine')
    // Each card counts its own account's files.
    expect(a.mirrors[0]?.fileCount).toBe(2)
    expect(b.mirrors[0]?.fileCount).toBe(1)
    // Each manifest belongs to the account it was made for, not to the
    // account that happened to be on screen.
    expect((await box.store.read()).accountEmail).toBe('user@example.com')
    expect((await box.second.store.read()).accountEmail).toBe('second@example.com')
    // And each manifest's backup copy lands in its own folder.
    expect(existsSync(join(box.dir, 'backup', 'user@example.com', 'manifest.json'))).toBe(true)
    expect(existsSync(join(box.dir, 'backup', 'second@example.com', 'manifest.json'))).toBe(true)
  })

  it('gives the running account its own manifest, whatever is on screen', async () => {
    const box = await harness()
    await writeFile(join(box.second.root, 'a.psd'), 'one')

    const r = runner(box)
    // The first account is on screen, and the second one is the one that
    // runs.
    await r.syncNow(box.second.id)

    expect((await box.second.store.read()).accountEmail).toBe('second@example.com')
    // The account on screen is untouched by the other account's run.
    expect((await box.store.read()).accountEmail).toBeNull()
  })

  it('trashes a deleted local file in both Drives, and keeps the manifests apart', async () => {
    const box = await harness()
    // Enough files that deleting one is not a mass deletion, so the
    // count-drop guard does not step in.
    for (const name of ['a.psd', 'b.psd', 'c.psd']) {
      await writeFile(join(box.root, name), 'one')
      await writeFile(join(box.second.root, name), 'one')
    }

    const r = runner(box)
    await r.syncNow(ACC)
    await r.syncNow(box.second.id)
    // The file is gone from both accounts' folders.
    await rm(join(box.root, 'a.psd'))
    await rm(join(box.second.root, 'a.psd'))

    await r.syncNow(ACC)
    await r.syncNow(box.second.id)

    // The file goes to the Drive trash of each account, and each account's
    // manifest forgets its own copy and nobody else's.
    expect(box.client.calls.some((c) => c.op === 'trash')).toBe(true)
    expect(box.second.client.calls.some((c) => c.op === 'trash')).toBe(true)
    expect((await box.store.read()).mirrors.Medicine?.files['a.psd']).toBeUndefined()
    expect((await box.second.store.read()).mirrors.Medicine?.files['a.psd']).toBeUndefined()
    // The files that are still there are still in both manifests.
    expect((await box.store.read()).mirrors.Medicine?.files['b.psd']).toBeDefined()
    expect((await box.second.store.read()).mirrors.Medicine?.files['b.psd']).toBeDefined()
  })

  it('gives the caller its own summary when another account is running', async () => {
    const box = await harness()
    await writeFile(join(box.root, 'a.psd'), 'one')

    // The second account's run waits for the lock the first one holds,
    // and then runs for itself.
    const r = runner(box, { lockWait: { attempts: 200, intervalMs: 5 } })
    const first = r.syncNow(ACC)
    const second = await r.syncNow(box.second.id)
    const firstSummary = await first

    // The two accounts are different worlds, and one account's run never
    // hands back the other's results.
    expect(second).not.toBe(firstSummary)
    expect(second.mirrors.map((m) => m.name)).toEqual(['Medicine'])
  })

  it('treats an account that is not a string as no account', async () => {
    const box = await harness()
    const manifest = await box.store.read()
    ;(manifest as { accountEmail: unknown }).accountEmail = 42
    await box.store.write(manifest)
    const r = runner(box, { email: 'me@example.com' })

    const summary = await r.syncNow(ACC)

    expect(summary.errors).toBe(0)
  })
})

describe('forgetting a mirror the user removed', () => {
  const day = 24 * 60 * 60 * 1000

  it('forgets one removed thirty-one days ago, and not one removed yesterday', async () => {
    const box = await harness()
    const manifest = await box.store.read()
    manifest.mirrors.Old = {
      root: 'E:\\Old',
      lastCounts: {},
      rebase: null,
      dirs: {},
      files: {},
      retired: {},
    }
    manifest.mirrors.Young = {
      root: 'E:\\Young',
      lastCounts: {},
      rebase: null,
      dirs: {},
      files: {},
      retired: {},
    }
    await box.store.write(manifest)
    const settings: AccountSettings = {
      ...box.settings,
      mirrors: [
        {
          name: 'Old',
          root: 'E:\\Old',
          drivePath: 'Old',
          enabled: false,
          removedAt: new Date(Date.now() - 31 * day).toISOString(),
        },
        {
          name: 'Young',
          root: 'E:\\Young',
          drivePath: 'Young',
          enabled: false,
          removedAt: new Date(Date.now() - 1 * day).toISOString(),
        },
      ],
    }
    const r = runner(box, { settings: async () => settings })

    expect(await r.pruneRemovedMirrors(ACC)).toBe(1)

    const after = await box.store.read()
    expect(after.mirrors.Old).toBeUndefined()
    expect(after.mirrors.Young).toBeDefined()
  })

  it('never forgets a mirror that is still configured', async () => {
    const box = await harness()
    const manifest = await box.store.read()
    manifest.mirrors.Kept = {
      root: 'E:\\Kept',
      lastCounts: {},
      rebase: null,
      dirs: {},
      files: {},
      retired: {},
    }
    await box.store.write(manifest)
    const r = runner(box)

    expect(await r.pruneRemovedMirrors(ACC)).toBe(0)
    expect((await box.store.read()).mirrors.Kept).toBeDefined()
  })
})

describe('changing where a mirror lives on Drive', () => {
  it('moves the folder rather than copying it', async () => {
    const box = await harness()
    const manifest = await box.store.read()
    manifest.mirrors.Medicine = {
      root: box.root,
      driveFolderId: MIRROR_FOLDER_ID,
      lastCounts: {},
      rebase: null,
      dirs: {},
      files: {},
      retired: {},
    }
    await box.store.write(manifest)
    const r = runner(box)

    const result = await r.moveMirrorDestination(ACC, 'Medicine', 'Archive/Photos')

    expect(result.ok).toBe(true)
    const moved = box.client.calls.find((c) => c.op === 'moveFolder')
    expect(moved).toBeDefined()
    expect(moved!.id).toBe(MIRROR_FOLDER_ID)
  })

  it('says so when there is no such mirror', async () => {
    const box = await harness()
    const r = runner(box)
    const result = await r.moveMirrorDestination(ACC, 'Nope', 'Photos')
    expect(result.ok).toBe(false)
  })
})

describe('bringing a restored file back', () => {
  async function withRestored(box: Harness): Promise<void> {
    const manifest = await box.store.read()
    manifest.mirrors.Medicine = {
      root: box.root,
      lastCounts: {},
      rebase: null,
      dirs: {},
      files: {},
      retired: {
        D1: {
          id: 'D1',
          path: 'a.txt',
          state: 'restored',
          at: '2026-10-21T00:00:00.000Z',
          md5: 'x',
          driveMimeType: 'text/plain',
          localPath: null,
        },
      },
    }
    await box.store.write(manifest)
    box.client.add('D1', 'a.txt', { content: Buffer.from('hello') })
  }

  it('puts the file back on the disk', async () => {
    const box = await harness()
    await withRestored(box)
    const r = runner(box)

    const result = await r.downloadRestored(ACC, 'Medicine', 'D1')

    expect(result.ok).toBe(true)
    expect(await readFile(join(box.root, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('waits for the download before it hashes and copies the file', async () => {
    const box = await harness()
    await withRestored(box)
    // A slow download is every download: the bytes arrive after the call
    // returns. The copy must wait for them.
    const client = box.client
    const original = client.downloadTo.bind(client)
    client.downloadTo = async (fileId: string, destPath: string): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await original(fileId, destPath)
    }

    const result = await runner(box, { client }).downloadRestored(ACC, 'Medicine', 'D1')

    expect(result.ok).toBe(true)
    expect(await readFile(join(box.root, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('refuses to replace a different file that is already there', async () => {
    const box = await harness()
    await withRestored(box)
    await writeFile(join(box.root, 'a.txt'), 'something else', 'utf8')
    const r = runner(box)

    const result = await r.downloadRestored(ACC, 'Medicine', 'D1')

    expect(result.ok).toBe(false)
    expect(await readFile(join(box.root, 'a.txt'), 'utf8')).toBe('something else')
  })

  it('says so when the file is not waiting to be recovered', async () => {
    const box = await harness()
    await withRestored(box)
    const manifest = await box.store.read()
    const record = manifest.mirrors.Medicine!.retired.D1!
    record.state = 'trashed'
    await box.store.write(manifest)
    const r = runner(box)

    const result = await r.downloadRestored(ACC, 'Medicine', 'D1')

    expect(result.ok).toBe(false)
  })
})
