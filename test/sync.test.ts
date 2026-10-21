import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executePlan } from '../src/core/sync'
import { emptyMirror } from '../src/core/manifest'
import { FakeDrive, FakeStore } from './helpers/fakeDrive'
import type { SyncPlan, PlanStep } from '../src/core/diff'
import type { MirrorManifest } from '../src/core/types'

/** The ops the app is allowed to make. There is no delete among them. */
const ALLOWED_OPS = new Set([
  'list',
  'get',
  'createFolder',
  'createFile',
  'updateContent',
  'download',
  'export',
  'trash',
  'untrash',
])

interface Sandbox {
  dir: string
  root: string
  archiveDir: string
  client: FakeDrive
  store: FakeStore
  manifest: MirrorManifest
}

/** A temp directory with a local root and an archive directory. */
async function sandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), 'dm-sync-'))
  const root = join(dir, 'Medicine')
  const archiveDir = join(dir, 'archive')
  await mkdir(root, { recursive: true })
  await mkdir(archiveDir, { recursive: true })

  const manifest = emptyMirror(root)
  manifest.driveFolderId = 'ROOT'

  const client = new FakeDrive()
  const store = new FakeStore(client.trace)

  return { dir, root, archiveDir, client, store, manifest }
}

/** Write a local file inside the mirror root. */
async function localFile(root: string, relPath: string, content = 'local bytes'): Promise<void> {
  const abs = join(root, relPath.replace(/\//g, '\\'))
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content)
}

/** The plan's steps that carry an action. */
function plan(steps: PlanStep[]): SyncPlan {
  return { steps, reports: [] }
}

/** Every archived copy under the archive directory, sidecars excluded. */
async function archivedFiles(archiveDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry)
      const rel = prefix ? `${prefix}/${entry}` : entry
      const items = await readdir(abs).catch(() => null)
      if (items === null) {
        if (!rel.endsWith('.meta.json')) out.push(rel)
      } else {
        await walk(abs, rel)
      }
    }
  }
  await walk(archiveDir, '')
  return out
}

describe('executePlan', () => {
  it('runs folders before uploads, uploads before downloads, downloads before trashes', async () => {
    const box = await sandbox()
    await localFile(box.root, 'renders/c.psd')
    box.client.add('D1', 'a.psd')
    box.client.add('D2', 'b.psd', { content: Buffer.from('drive bytes') })

    const p = plan([
      {
        action: { kind: 'trash', relPath: 'a.psd', driveFileId: 'D1' },
        ops: [{ op: 'del-file', path: 'a.psd' }],
      },
      {
        action: {
          kind: 'download',
          relPath: 'b.psd',
          localPath: 'b.psd',
          driveFileId: 'D2',
          size: 11,
        },
        ops: [],
      },
      {
        action: {
          kind: 'upload',
          relPath: 'renders/c.psd',
          localPath: 'renders/c.psd',
          md5: 'm3',
          size: 11,
        },
        ops: [],
      },
      { action: { kind: 'create-folder', relPath: 'renders' }, ops: [] },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    // The reads and the archive of the trashed file are not actions of the
    // plan; only the mutations are.
    const mutating = new Set([
      'createFolder',
      'createFile',
      'updateContent',
      'download',
      'export',
      'trash',
      'untrash',
    ])
    const actions = box.client.calls.filter(
      (c) =>
        mutating.has(c.op) &&
        !(c.op === 'download' && (c.dest ?? '').startsWith(box.archiveDir)),
    )
    expect(actions.map((c) => c.op)).toEqual([
      'createFolder',
      'createFile',
      'download',
      'trash',
    ])
  })

  it('archives the Drive bytes before trashing', async () => {
    const box = await sandbox()
    box.client.add('D1', 'a.psd', { content: Buffer.from('the drive copy') })

    let archivedWhenTrashed: string[] = []
    box.client.onCall = (call) => {
      if (call.op === 'trash') {
        archivedWhenTrashed = ['pending']
      }
    }

    const p = plan([
      {
        action: { kind: 'trash', relPath: 'a.psd', driveFileId: 'D1' },
        ops: [{ op: 'del-file', path: 'a.psd' }],
      },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    // The archive call must come before the trash call.
    const ops = box.client.calls.map((c) => c.op)
    expect(ops.indexOf('download')).toBeLessThan(ops.indexOf('trash'))

    const files = await archivedFiles(box.archiveDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('Medicine/a.psd/')

    const abs = join(box.archiveDir, files[0]!.replace(/\//g, '\\'))
    const content = await readFile(abs, 'utf8')
    expect(content).toBe('the drive copy')
  })

  it('skips the trash when the archive write fails', async () => {
    const box = await sandbox()
    // A regular file where the archive directory should be: every write
    // under it fails.
    const blocked = join(box.dir, 'blocked')
    await writeFile(blocked, 'not a directory')
    box.client.add('D1', 'a.psd')

    const p = plan([
      {
        action: { kind: 'trash', relPath: 'a.psd', driveFileId: 'D1' },
        ops: [{ op: 'del-file', path: 'a.psd' }],
      },
    ])

    const result = await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: blocked,
    })

    expect(box.client.calls.some((c) => c.op === 'trash')).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.relPath).toBe('a.psd')
    // The manifest write did not happen either.
    expect(box.manifest.files['a.psd']).toBeUndefined()
  })

  it('skips the content replacement when the archive write fails', async () => {
    const box = await sandbox()
    const blocked = join(box.dir, 'blocked')
    await writeFile(blocked, 'not a directory')
    await localFile(box.root, 'a.psd')
    box.client.add('D1', 'a.psd')

    const p = plan([
      {
        action: {
          kind: 'replace-content',
          relPath: 'a.psd',
          localPath: 'a.psd',
          driveFileId: 'D1',
          md5: 'm2',
          size: 11,
        },
        ops: [],
      },
    ])

    const result = await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: blocked,
    })

    expect(box.client.calls.some((c) => c.op === 'updateContent')).toBe(false)
    expect(result.errors).toHaveLength(1)
  })

  it('continues after a per-file failure', async () => {
    const box = await sandbox()
    await localFile(box.root, 'good.psd')
    await localFile(box.root, 'bad.psd')
    box.client.failOn('createFile', 'the upload failed', 'bad.psd')

    const p = plan([
      {
        action: {
          kind: 'upload',
          relPath: 'good.psd',
          localPath: 'good.psd',
          md5: 'm1',
          size: 11,
        },
        ops: [],
      },
      {
        action: {
          kind: 'upload',
          relPath: 'bad.psd',
          localPath: 'bad.psd',
          md5: 'm2',
          size: 11,
        },
        ops: [],
      },
    ])

    const result = await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    // The other file still synced.
    expect(result.uploaded).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.relPath).toBe('bad.psd')
  })

  it('writes the intent before a create-upload', async () => {
    const box = await sandbox()
    await localFile(box.root, 'c.psd')

    const p = plan([
      {
        action: {
          kind: 'upload',
          relPath: 'c.psd',
          localPath: 'c.psd',
          md5: 'm3',
          size: 11,
        },
        ops: [],
      },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    const intentAt = box.client.trace.indexOf('journal:intent:create-upload')
    const createAt = box.client.trace.indexOf('drive:createFile')
    expect(intentAt).toBeGreaterThanOrEqual(0)
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(intentAt).toBeLessThan(createAt)

    const journal = await box.store.readJournal()
    const intent = journal.find((op) => op.op === 'intent')
    expect(intent).toBeDefined()
    if (intent && intent.op === 'intent') {
      expect(intent.kind).toBe('create-upload')
      expect(intent.path).toBe('c.psd')
    }
  })

  it('writes the intent before an un-trash', async () => {
    const box = await sandbox()
    box.client.add('D1', 'a.psd', { trashed: true })

    const p = plan([
      {
        action: { kind: 'untrash', relPath: 'a.psd', driveFileId: 'D1' },
        ops: [],
      },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    const intentAt = box.client.trace.indexOf('journal:intent:untrash')
    const untrashAt = box.client.trace.indexOf('drive:untrash')
    expect(intentAt).toBeGreaterThanOrEqual(0)
    expect(untrashAt).toBeGreaterThanOrEqual(0)
    expect(intentAt).toBeLessThan(untrashAt)

    const journal = await box.store.readJournal()
    const intent = journal.find((op) => op.op === 'intent')
    if (intent && intent.op === 'intent') {
      expect(intent.kind).toBe('untrash')
      expect(intent.driveFileId).toBe('D1')
    }
  })

  it('applies manifest ops only after the step succeeds', async () => {
    const box = await sandbox()
    await localFile(box.root, 'a.psd')
    box.client.add('D1', 'a.psd')
    box.client.failOn('updateContent', 'the replacement failed')

    const p = plan([
      {
        action: {
          kind: 'replace-content',
          relPath: 'a.psd',
          localPath: 'a.psd',
          driveFileId: 'D1',
          md5: 'm2',
          size: 11,
        },
        ops: [
          {
            op: 'set-file',
            path: 'a.psd',
            entry: {
              displayPath: 'a.psd',
              driveFileId: 'D1',
              driveMd5: 'm2',
              driveModifiedTime: '2026-10-21T00:00:00.000Z',
              driveMimeType: 'application/octet-stream',
              exportMime: null,
              localPath: 'a.psd',
              localMd5: 'm2',
              localSize: 11,
              localMtimeMs: 0,
            },
          },
        ],
      },
    ])

    const result = await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    expect(result.errors).toHaveLength(1)
    expect(box.manifest.files['a.psd']).toBeUndefined()

    const journal = await box.store.readJournal()
    expect(journal.some((op) => op.op === 'change')).toBe(false)
  })

  it('never issues a delete call', async () => {
    const box = await sandbox()
    await localFile(box.root, 'a.psd')
    box.client.add('D1', 'a.psd')

    const p = plan([
      { action: { kind: 'create-folder', relPath: 'sub' }, ops: [] },
      {
        action: {
          kind: 'upload',
          relPath: 'a.psd',
          localPath: 'a.psd',
          md5: 'm1',
          size: 11,
        },
        ops: [],
      },
      {
        action: {
          kind: 'download',
          relPath: 'b.psd',
          localPath: 'b.psd',
          driveFileId: 'D1',
          size: 11,
        },
        ops: [],
      },
      {
        action: { kind: 'trash', relPath: 'a.psd', driveFileId: 'D1' },
        ops: [],
      },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    for (const call of box.client.calls) {
      expect(ALLOWED_OPS.has(call.op), `unexpected call ${call.op}`).toBe(true)
    }
  })

  it('counts uploads, downloads, trashes and errors separately', async () => {
    const box = await sandbox()
    await localFile(box.root, 'up.psd')
    box.client.add('D1', 'down.psd')
    box.client.add('D2', 'gone.psd')
    box.client.add('D3', 'export.doc')

    const p = plan([
      {
        action: {
          kind: 'upload',
          relPath: 'up.psd',
          localPath: 'up.psd',
          md5: 'm1',
          size: 11,
        },
        ops: [],
      },
      {
        action: {
          kind: 'download',
          relPath: 'down.psd',
          localPath: 'down.psd',
          driveFileId: 'D1',
          size: 11,
        },
        ops: [],
      },
      {
        action: {
          kind: 'export-native',
          relPath: 'export.doc',
          localPath: 'export.pdf',
          driveFileId: 'D3',
          exportMime: 'application/pdf',
          size: 0,
        },
        ops: [],
      },
      {
        action: { kind: 'trash', relPath: 'gone.psd', driveFileId: 'D2' },
        ops: [],
      },
    ])

    const result = await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    expect(result.uploaded).toBe(1)
    expect(result.downloaded).toBe(1)
    expect(result.exported).toBe(1)
    expect(result.trashed).toBe(1)
    expect(result.replaced).toBe(0)
    expect(result.untrashed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('archives the local bytes before a download that would overwrite them', async () => {
    const box = await sandbox()
    await localFile(box.root, 'a.psd', 'the local work')
    box.client.add('D1', 'a.psd', { content: Buffer.from('the drive version') })

    const p = plan([
      {
        action: {
          kind: 'download',
          relPath: 'a.psd',
          localPath: 'a.psd',
          driveFileId: 'D1',
          size: 16,
          archiveLocalFirst: true,
        },
        ops: [],
      },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    const files = await archivedFiles(box.archiveDir)
    expect(files).toHaveLength(1)
    const abs = join(box.archiveDir, files[0]!.replace(/\//g, '\\'))
    expect(await readFile(abs, 'utf8')).toBe('the local work')

    // The local file now holds the Drive version.
    expect(await readFile(join(box.root, 'a.psd'), 'utf8')).toBe('the drive version')
  })

  it('records the new folder id in the manifest', async () => {
    const box = await sandbox()

    const p = plan([
      { action: { kind: 'create-folder', relPath: 'renders' }, ops: [] },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    expect(box.manifest.dirs['renders']).toBeDefined()
    expect(box.manifest.dirs['renders']?.driveFolderId).toBeTruthy()
  })

  it('uploads under the name the file has on disk', async () => {
    const box = await sandbox()
    await localFile(box.root, 'Renders/Scene.PSD')
    box.manifest.dirs['renders'] = { driveFolderId: 'DIR1' }

    const p = plan([
      {
        action: {
          kind: 'upload',
          relPath: 'renders/scene.psd',
          localPath: 'renders/scene.psd',
          md5: 'm1',
          size: 11,
        },
        ops: [],
      },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    const created = box.client.calls.find((c) => c.op === 'createFile')
    expect(created?.name).toBe('Scene.PSD')
  })

  it('downloads under the name the Drive file has', async () => {
    const box = await sandbox()
    box.client.add('D1', 'Scene.PSD', { content: Buffer.from('drive bytes') })

    const p = plan([
      {
        action: {
          kind: 'download',
          relPath: 'scene.psd',
          localPath: 'scene.psd',
          driveFileId: 'D1',
          size: 11,
        },
        ops: [],
      },
    ])

    await executePlan(p, {
      client: box.client,
      store: box.store,
      manifest: box.manifest,
      root: box.root,
      archiveDir: box.archiveDir,
    })

    const downloaded = box.client.calls.find((c) => c.op === 'download')
    expect(downloaded?.dest).toContain('Scene.PSD')
  })
})
