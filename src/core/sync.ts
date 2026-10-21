/**
 * The plan executor.
 *
 * The diff engine decides what should happen; this module does it. The two
 * are kept apart so that the decisions can be tested without a network and
 * without a disk.
 *
 * Two properties matter more than anything else here.
 *
 * **Order.** Folders are created before uploads, uploads before downloads,
 * downloads before trashes. Trashing last means a run that dies halfway
 * leaves a file on Drive that was about to be trashed, rather than a Drive
 * copy removed before the local side was confirmed.
 *
 * **Fail-closed archiving.** Before a Drive file is overwritten or trashed,
 * its bytes are copied to the superseded store. If that copy cannot be
 * written, the Drive file is left exactly as it was. The archive is the only
 * second copy the app keeps, so continuing past a failed archive would
 * destroy the only version of the file.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { applyManifestOp } from './manifest'
import { baseName, canon, parentPath, sanitizePathSegment } from './paths'
import type { DriveClient } from '../drive/client'
import type { ManifestStore } from './manifest'
import type { ManifestOp, MirrorManifest, Report } from './types'
import type { PlanStep, SyncAction, SyncPlan } from './diff'

/** The phases a run goes through, in order. */
export type Phase = 'folders' | 'uploads' | 'downloads' | 'trashes'

/** A progress notification for the interface. */
export interface ProgressEvent {
  phase: Phase
  relPath: string
  kind: SyncAction['kind']
  status: 'start' | 'done' | 'failed'
  message?: string
}

/** What a run did. */
export interface SyncRunResult {
  uploaded: number
  replaced: number
  downloaded: number
  exported: number
  trashed: number
  untrashed: number
  errors: Array<{ relPath: string; message: string }>
  reports: Report[]
  manifest: MirrorManifest
}

/** Everything the executor needs from the outside world. */
export interface ExecutorContext {
  client: DriveClient
  store: ManifestStore
  manifest: MirrorManifest
  /** Absolute path of the mirror root on disk. */
  root: string
  /** Where superseded copies are kept. */
  archiveDir: string
  onProgress?: (event: ProgressEvent) => void
}

/** The action kinds in each phase, in phase order. */
const PHASES: Array<{ phase: Phase; kinds: SyncAction['kind'][] }> = [
  { phase: 'folders', kinds: ['create-folder'] },
  { phase: 'uploads', kinds: ['upload', 'replace-content', 'untrash'] },
  { phase: 'downloads', kinds: ['download', 'export-native'] },
  { phase: 'trashes', kinds: ['trash'] },
]

/** Raised when the superseded copy could not be written. */
class ArchiveFailure extends Error {}

/**
 * Run a plan.
 *
 * The plan is a list of steps; each step is one action plus the manifest
 * writes that follow it. A step that fails is recorded and skipped: one bad
 * file never stops the rest of the mirror. The exception is a failed
 * archive, which skips the step's Drive action as well.
 */
export async function executePlan(
  plan: SyncPlan,
  ctx: ExecutorContext,
): Promise<SyncRunResult> {
  const result: SyncRunResult = {
    uploaded: 0,
    replaced: 0,
    downloaded: 0,
    exported: 0,
    trashed: 0,
    untrashed: 0,
    errors: [],
    reports: [...plan.reports],
    manifest: ctx.manifest,
  }

  const mirrorName = basename(ctx.root)

  // The steps that act on Drive, grouped by phase.
  for (const { phase, kinds } of PHASES) {
    for (const step of plan.steps) {
      if (!step.action || !kinds.includes(step.action.kind)) continue
      await runStep(step, phase, ctx, result, mirrorName)
    }
  }

  // The steps that only record something. They carry no Drive action, so
  // they cannot fail, and they are applied last so the manifest describes
  // the state the run ended in.
  for (const step of plan.steps) {
    if (step.action) continue
    await applyOps(step.ops, ctx, mirrorName)
  }

  return result
}

/** Run one step: archive if needed, act on Drive, then record it. */
async function runStep(
  step: PlanStep,
  phase: Phase,
  ctx: ExecutorContext,
  result: SyncRunResult,
  mirrorName: string,
): Promise<void> {
  const action = step.action!
  ctx.onProgress?.({
    phase,
    relPath: action.relPath,
    kind: action.kind,
    status: 'start',
  })

  /** Manifest writes the step produced beyond its own ops. */
  let extraOps: ManifestOp[] = []
  /** Rewrites the step's ops once the Drive side is known. */
  let patch: (op: ManifestOp) => ManifestOp = (op) => op

  try {
    switch (action.kind) {
      case 'create-folder': {
        const parent = parentPath(action.relPath)
        const parentId = folderIdFor(ctx.manifest, parent)
        if (!parentId) {
          throw new Error(`the Drive folder for "${parent || '.'}" is not known yet`)
        }
        const name =
          (await localDisplayName(ctx.root, action.relPath)) ?? baseName(action.relPath)
        const created = await ctx.client.createFolder(name, parentId)
        extraOps = [{ op: 'set-dir', path: action.relPath, driveFolderId: created.id }]
        break
      }

      case 'upload': {
        const parent = parentPath(action.relPath)
        const parentId = folderIdFor(ctx.manifest, parent)
        if (!parentId) {
          throw new Error(`the Drive folder for "${parent || '.'}" is not known yet`)
        }
        const name =
          (await localDisplayName(ctx.root, action.localPath)) ?? baseName(action.relPath)

        // The write-ahead intent: if the app dies between the upload and
        // the manifest write, the next run must not conclude that the file
        // was deleted locally and restore it.
        await ctx.store.appendJournal({
          op: 'intent',
          kind: 'create-upload',
          mirror: mirrorName,
          path: action.relPath,
          parentId,
          localMd5: action.md5,
          size: action.size,
        })

        const created = await ctx.client.createFile(
          name,
          parentId,
          await localStream(join(ctx.root, action.localPath)),
          { md5: action.md5, size: action.size },
        )

        const createdId = created.id
        patch = (op) => {
          if (op.op === 'set-file' && !op.entry.driveFileId) {
            return {
              ...op,
              entry: { ...op.entry, driveFileId: createdId, driveMd5: action.md5 },
            }
          }
          return op
        }
        result.uploaded += 1
        break
      }

      case 'replace-content': {
        // The Drive bytes are the ones being replaced, so they are the ones
        // archived. If the archive fails, the Drive file is not touched.
        await archiveDriveBytes(ctx.client, action.driveFileId, action.relPath, ctx, mirrorName)
        await ctx.client.updateContent(
          action.driveFileId,
          await localStream(join(ctx.root, action.localPath)),
          { md5: action.md5, size: action.size },
        )
        result.replaced += 1
        break
      }

      case 'untrash': {
        await ctx.store.appendJournal({
          op: 'intent',
          kind: 'untrash',
          mirror: mirrorName,
          path: action.relPath,
          driveFileId: action.driveFileId,
        })
        await ctx.client.untrash(action.driveFileId)
        result.untrashed += 1
        break
      }

      case 'download': {
        if (action.archiveLocalFirst) {
          await archiveLocalBytes(ctx.root, action.localPath, ctx, mirrorName)
        }
        const driveName = await driveNameOf(ctx.client, action.driveFileId, action.relPath)
        const dest = join(
          ctx.root,
          parentPath(action.localPath),
          withDriveName(baseName(action.localPath), driveName),
        )
        await mkdir(dirname(dest), { recursive: true })
        await ctx.client.downloadTo(action.driveFileId, dest)
        result.downloaded += 1
        break
      }

      case 'export-native': {
        if (action.archiveLocalFirst) {
          await archiveLocalBytes(ctx.root, action.localPath, ctx, mirrorName)
        }
        const driveName = await driveNameOf(ctx.client, action.driveFileId, action.relPath)
        const dest = join(
          ctx.root,
          parentPath(action.localPath),
          withDriveName(baseName(action.localPath), driveName),
        )
        await mkdir(dirname(dest), { recursive: true })
        await ctx.client.exportTo(action.driveFileId, dest, action.exportMime)
        result.exported += 1
        break
      }

      case 'trash': {
        // The Drive bytes are archived unconditionally, not only when the
        // Drive content changed since the last sync: the case worth keeping
        // is exactly the one that was synced.
        await archiveDriveBytes(ctx.client, action.driveFileId, action.relPath, ctx, mirrorName)
        await ctx.client.trash(action.driveFileId)
        result.trashed += 1
        break
      }
    }
  } catch (err) {
    const message =
      err instanceof ArchiveFailure
        ? 'the archived copy could not be written; the Drive file was left untouched'
        : err instanceof Error
          ? err.message
          : String(err)
    result.errors.push({ relPath: action.relPath, message })
    ctx.onProgress?.({
      phase,
      relPath: action.relPath,
      kind: action.kind,
      status: 'failed',
      message,
    })
    return
  }

  ctx.onProgress?.({
    phase,
    relPath: action.relPath,
    kind: action.kind,
    status: 'done',
  })

  await applyOps(step.ops, ctx, mirrorName, patch)
  if (extraOps.length > 0) {
    await applyOps(extraOps, ctx, mirrorName)
  }
}

/** Apply manifest writes and record them in the journal. */
async function applyOps(
  ops: ManifestOp[],
  ctx: ExecutorContext,
  mirrorName: string,
  patch: (op: ManifestOp) => ManifestOp = (op) => op,
): Promise<void> {
  for (const op of ops) {
    const final = patch(op)
    applyManifestOp(ctx.manifest, final)
    await ctx.store.appendJournal({
      op: 'change',
      mirror: mirrorName,
      change: final,
    })
  }
}

/** The Drive folder id that holds a canonical directory path. */
function folderIdFor(manifest: MirrorManifest, dir: string): string | undefined {
  if (dir === '') return manifest.driveFolderId
  return manifest.dirs[dir]?.driveFolderId
}

/**
 * The name of a local path as it is spelled on disk.
 *
 * Paths are compared canonically, so the plan carries lowercased names. The
 * file on disk is called "Scene.psd" and the plan says "scene.psd"; using
 * the plan's spelling would rename the user's file on Drive.
 */
export async function localDisplayName(
  root: string,
  relPath: string,
): Promise<string | null> {
  const segments = relPath.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return null

  let abs = root
  for (let i = 0; i < segments.length; i += 1) {
    let entries: Dirent[]
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return null
    }
    const wanted = segments[i]!.toLowerCase()
    const match = entries.find((e) => e.name.toLowerCase() === wanted)
    if (!match) return null
    if (i === segments.length - 1) return match.name
    abs = join(abs, match.name)
  }
  return null
}

/**
 * The Drive file's own name.
 *
 * The plan carries a canonical path; the Drive file carries the name the
 * user sees.
 */
async function driveNameOf(
  client: DriveClient,
  driveFileId: string,
  fallbackPath: string,
): Promise<string> {
  try {
    const node = await client.getFile(driveFileId)
    if (node) return node.entry.name
  } catch {
    // Fall through to the plan's spelling.
  }
  return baseName(fallbackPath)
}

/**
 * Restore the Drive file's spelling in a planned leaf name.
 *
 * Only the leading part that corresponds to the Drive file's own name is
 * replaced, so a planned export path such as "budget (export 1).csv" for a
 * Drive file called "Budget" becomes "Budget (export 1).csv" and keeps its
 * disambiguating suffix.
 */
function withDriveName(plannedLeaf: string, driveName: string): string {
  const canonical = canon(driveName)
  if (canonical.length === 0) return plannedLeaf
  if (!plannedLeaf.toLowerCase().startsWith(canonical)) return plannedLeaf
  return driveName + plannedLeaf.slice(canonical.length)
}

/** Where a superseded copy is kept, and what it is called. */
function archiveTarget(
  archiveDir: string,
  mirrorName: string,
  relPath: string,
  md5: string | null,
): { dir: string; file: string } {
  const segments = relPath.split('/').filter((s) => s.length > 0).map(sanitizePathSegment)
  const leaf = segments.pop() ?? 'file'
  const dir = join(archiveDir, sanitizePathSegment(mirrorName), ...segments, leaf)
  const stamp = new Date().toISOString().replace(/[-:.]/g, '')
  const prefix = md5 ? md5.slice(0, 8) : '00000000'
  const ext = extname(leaf)
  return { dir, file: join(dir, `${stamp}-${prefix}${ext}`) }
}

/** Write the sidecar that says what this copy is. */
async function writeMeta(
  file: string,
  originalPath: string,
  side: 'drive' | 'local',
  md5: string | null,
): Promise<void> {
  await writeFile(
    `${file}.meta.json`,
    JSON.stringify({ path: originalPath, side, md5, at: new Date().toISOString() }, null, 2),
    'utf8',
  )
}

/**
 * Copy a Drive file into the superseded store.
 *
 * Throws `ArchiveFailure` when the copy cannot be made. The caller then
 * leaves the Drive file alone.
 */
async function archiveDriveBytes(
  client: DriveClient,
  driveFileId: string,
  relPath: string,
  ctx: ExecutorContext,
  mirrorName: string,
): Promise<string> {
  let md5: string | null = null
  try {
    const node = await client.getFile(driveFileId)
    if (!node) {
      throw new Error(`the Drive file ${driveFileId} could not be read`)
    }
    md5 = node.entry.md5Checksum ?? null
  } catch (err) {
    throw new ArchiveFailure(
      err instanceof Error ? err.message : 'the Drive file could not be read',
    )
  }

  const { dir, file } = archiveTarget(ctx.archiveDir, mirrorName, relPath, md5)
  try {
    await mkdir(dir, { recursive: true })
    await client.downloadTo(driveFileId, file)
    await writeMeta(file, relPath, 'drive', md5)
  } catch (err) {
    throw new ArchiveFailure(
      err instanceof Error ? err.message : 'the archived copy could not be written',
    )
  }
  return file
}

/**
 * Copy a local file into the superseded store.
 *
 * Throws `ArchiveFailure` when the copy cannot be made.
 */
async function archiveLocalBytes(
  root: string,
  localPath: string,
  ctx: ExecutorContext,
  mirrorName: string,
): Promise<string> {
  const abs = join(root, localPath)
  const md5 = await md5OfFile(abs)
  const { dir, file } = archiveTarget(ctx.archiveDir, mirrorName, localPath, md5)
  try {
    await mkdir(dir, { recursive: true })
    await copyFile(abs, file)
    await writeMeta(file, localPath, 'local', md5)
  } catch (err) {
    throw new ArchiveFailure(
      err instanceof Error ? err.message : 'the archived copy could not be written',
    )
  }
  return file
}

/** The MD5 of a file, or null when it cannot be read. */
async function md5OfFile(abs: string): Promise<string | null> {
  try {
    const hash = createHash('md5')
    await pipeline(createReadStream(abs), hash)
    return hash.digest('hex')
  } catch {
    return null
  }
}

/**
 * A stream of a local file, for uploading.
 *
 * The file is checked first so that a missing file produces a clear error
 * instead of an asynchronous stream failure that the client may never see.
 * The stream also carries an error handler, so a client that rejects without
 * reading the body cannot leave an unhandled error and a locked file
 * behind.
 */
async function localStream(abs: string): Promise<Readable> {
  try {
    await stat(abs)
  } catch {
    throw new Error(`the local file "${abs}" could not be read`)
  }
  const stream = createReadStream(abs)
  stream.on('error', () => {})
  return stream
}
