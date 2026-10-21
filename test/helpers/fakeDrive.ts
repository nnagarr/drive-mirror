/**
 * An in-memory Drive, and an in-memory manifest store.
 *
 * The fake records every call it receives, in order, so a test can assert
 * what the executor did and in what order. It never performs a network
 * call, and it has no delete operation at all: the app's promise that it
 * only ever trashes is checked by the fact that there is nothing to call.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import type { DriveClient } from '../../src/drive/client'
import type {
  DriveNode,
  JournalOp,
  Manifest,
  ManifestOp,
} from '../../src/core/types'
import { emptyManifest } from '../../src/core/manifest'

/** One call the fake received. */
export interface DriveCall {
  op:
    | 'list'
    | 'get'
    | 'createFolder'
    | 'createFile'
    | 'updateContent'
    | 'download'
    | 'export'
    | 'trash'
    | 'untrash'
    | 'moveFolder'
    | 'accountEmail'
  id?: string
  name?: string
  /** Where a download or export wrote to. */
  dest?: string
  /** The parent a folder or file was created in. */
  parentId?: string
}

/** A file in the fake Drive. */
export interface FakeFile {
  id: string
  name: string
  mimeType: string
  size: number
  md5: string
  modifiedTime: string
  trashed: boolean
  parents: string[]
  content: Buffer
}

/** Read a whole stream into a buffer. */
async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export class FakeDrive implements DriveClient {
  calls: DriveCall[] = []
  files = new Map<string, FakeFile>()
  folders = new Map<string, { id: string; name: string; parentId: string }>()

  /** Shared ordering trace, so a test can see interleaving with the journal. */
  trace: string[] = []

  /** Called for every call, before it is recorded. */
  onCall?: (call: DriveCall) => void

  private nextId = 1
  private failures = new Map<string, { message: string; name?: string }>()

  /** Make every call of this kind reject. */
  failOn(op: DriveCall['op'], message = `fake drive failure: ${op}`, name?: string): void {
    this.failures.set(op, { message, name })
  }

  /** Add a file to the fake Drive. */
  add(
    id: string,
    name: string,
    options: {
      mimeType?: string
      md5?: string
      content?: Buffer
      trashed?: boolean
      parents?: string[]
    } = {},
  ): FakeFile {
    const content = options.content ?? Buffer.from(`content of ${name}`)
    const file: FakeFile = {
      id,
      name,
      mimeType: options.mimeType ?? 'application/octet-stream',
      size: content.length,
      md5: options.md5 ?? `md5-${id}`,
      modifiedTime: '2026-10-20T18:00:00.000Z',
      trashed: options.trashed ?? false,
      parents: options.parents ?? [],
      content,
    }
    this.files.set(id, file)
    return file
  }

  private record(call: DriveCall): void {
    this.calls.push(call)
    this.trace.push(`drive:${call.op}`)
    if (this.onCall) this.onCall(call)
  }

  /** Fail the call if a failure was configured for it. */
  private maybeFail(call: DriveCall): void {
    const failure = this.failures.get(call.op)
    if (failure && (failure.name === undefined || failure.name === call.name)) {
      throw new Error(failure.message)
    }
  }

  async listChildren(folderId: string): Promise<DriveNode[]> {
    this.record({ op: 'list', id: folderId })
    const out: DriveNode[] = []

    for (const folder of this.folders.values()) {
      if (folder.parentId !== folderId) continue
      out.push({
        entry: {
          id: folder.id,
          name: folder.name,
          mimeType: 'application/vnd.google-apps.folder',
          modifiedTime: '2026-10-20T18:00:00.000Z',
          trashed: false,
          parents: [folder.parentId],
        },
        parentPath: '',
      })
    }

    for (const file of this.files.values()) {
      if (!file.trashed && file.parents.includes(folderId)) {
        out.push(this.node(file))
      }
    }
    return out
  }

  async getFile(fileId: string): Promise<DriveNode | null> {
    this.record({ op: 'get', id: fileId })
    const file = this.files.get(fileId)
    if (file) return this.node(file)
    // A folder is a file as far as the Drive API is concerned, so the
    // fake answers for folders too.
    const folder = this.folders.get(fileId)
    if (folder) {
      return {
        entry: {
          id: folder.id,
          name: folder.name,
          mimeType: 'application/vnd.google-apps.folder',
          modifiedTime: '2026-10-20T18:00:00.000Z',
          trashed: false,
          parents: [folder.parentId],
        },
        parentPath: '',
      }
    }
    return null
  }

  async createFolder(name: string, parentId: string): Promise<{ id: string }> {
    this.record({ op: 'createFolder', name, parentId })
    const id = `F${this.nextId++}`
    this.folders.set(id, { id, name, parentId })
    return { id }
  }

  async createFile(
    name: string,
    parentId: string,
    body: Readable,
    opts: { md5: string; size: number; mimeType?: string },
  ): Promise<{ id: string }> {
    const call: DriveCall = { op: 'createFile', name, parentId }
    this.record(call)
    // The body is read before the failure is raised, so a failing upload
    // does not leave a dangling stream behind.
    const content = await readAll(body)
    this.maybeFail(call)
    const id = `F${this.nextId++}`
    this.files.set(id, {
      id,
      name,
      mimeType: opts.mimeType ?? 'application/octet-stream',
      size: content.length,
      md5: opts.md5,
      modifiedTime: '2026-10-21T00:00:00.000Z',
      trashed: false,
      parents: [parentId],
      content,
    })
    return { id }
  }

  async updateContent(
    fileId: string,
    body: Readable,
    opts: { md5: string; size: number },
  ): Promise<void> {
    const call: DriveCall = { op: 'updateContent', id: fileId }
    this.record(call)
    const content = await readAll(body)
    this.maybeFail(call)
    const file = this.files.get(fileId)
    if (!file) throw new Error(`fake drive: no file ${fileId}`)
    file.content = content
    file.md5 = opts.md5
    file.size = file.content.length
    file.modifiedTime = '2026-10-21T00:00:00.000Z'
  }

  async downloadTo(fileId: string, destPath: string): Promise<void> {
    this.record({ op: 'download', id: fileId, dest: destPath })
    const file = this.files.get(fileId)
    if (!file) throw new Error(`fake drive: no file ${fileId}`)
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, file.content)
  }

  async exportTo(fileId: string, destPath: string, mimeType: string): Promise<void> {
    this.record({ op: 'export', id: fileId, dest: destPath })
    const file = this.files.get(fileId)
    if (!file) throw new Error(`fake drive: no file ${fileId}`)
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, Buffer.from(`export of ${file.name} as ${mimeType}`))
  }

  async trash(fileId: string): Promise<void> {
    this.record({ op: 'trash', id: fileId })
    const file = this.files.get(fileId)
    if (!file) throw new Error(`fake drive: no file ${fileId}`)
    file.trashed = true
  }

  async untrash(fileId: string): Promise<void> {
    this.record({ op: 'untrash', id: fileId })
    const file = this.files.get(fileId)
    if (!file) throw new Error(`fake drive: no file ${fileId}`)
    file.trashed = false
  }

  async moveFolder(
    fileId: string,
    newParentId: string,
    newName?: string,
  ): Promise<void> {
    this.record({ op: 'moveFolder', id: fileId, parentId: newParentId, name: newName })
    const folder = this.folders.get(fileId)
    if (folder) {
      folder.parentId = newParentId
      if (newName !== undefined) folder.name = newName
      return
    }
    const file = this.files.get(fileId)
    if (!file) throw new Error(`fake drive: no folder ${fileId}`)
    file.parents = [newParentId]
    if (newName !== undefined) file.name = newName
  }

  async getAccountEmail(): Promise<string | null> {
    this.record({ op: 'accountEmail' })
    return 'test@example.com'
  }

  private node(file: FakeFile): DriveNode {
    return {
      entry: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: String(file.size),
        md5Checksum: file.md5,
        modifiedTime: file.modifiedTime,
        trashed: file.trashed,
        parents: file.parents,
      },
      parentPath: '',
    }
  }
}

/**
 * An in-memory manifest store.
 *
 * It records the journal, and the order in which journal entries were
 * written relative to the fake Drive's calls.
 */
export class FakeStore {
  journal: JournalOp[] = []
  trace: string[]

  constructor(trace: string[] = []) {
    this.trace = trace
  }

  async read(): Promise<Manifest> {
    return emptyManifest()
  }

  async write(): Promise<void> {}

  async checkpoint(): Promise<void> {}

  async appendJournal(op: JournalOp): Promise<void> {
    this.journal.push(op)
    this.trace.push(
      op.op === 'intent' ? `journal:intent:${op.kind}` : 'journal:change',
    )
  }

  async readJournal(): Promise<JournalOp[]> {
    return [...this.journal]
  }

  async replayJournal(base: Manifest): Promise<Manifest> {
    return base
  }
}

/** Apply a journal change op to a mirror manifest, for the test's use. */
export function applyChange(mirror: Manifest['mirrors'][string], op: ManifestOp): void {
  if (op.op === 'set-file') mirror.files[op.path] = op.entry
  else if (op.op === 'del-file') delete mirror.files[op.path]
  else if (op.op === 'set-retired') mirror.retired[op.id] = op.record
  else if (op.op === 'del-retired') delete mirror.retired[op.id]
  else if (op.op === 'set-dir') mirror.dirs[op.path] = { driveFolderId: op.driveFolderId }
}
