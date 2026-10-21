/**
 * Test doubles for the sync engine.
 *
 * These builders are the shared vocabulary for every diff test: a tree is
 * described by what it holds, not by how the engine reads it.
 */

import { canon, isRepresentableOnWindows } from '../../src/core/paths'
import { emptyManifest, emptyMirror } from '../../src/core/manifest'
import type {
  DiffIo,
  DriveFile,
  DriveNode,
  DriveTree,
  LocalEntry,
  LocalState,
  LocalTree,
  Manifest,
  ManifestOp,
  MirrorManifest,
  ProbeResult,
} from '../../src/core/types'

/** A local file described by its path, state and content hash. */
export interface LocalSpec {
  state?: LocalState
  size?: number
  mtimeMs?: number
  md5?: string
}

/** Build a local tree from a map of path -> spec. */
export function localTree(
  files: Record<string, LocalSpec | LocalState>,
  dirs: string[] = [],
): LocalTree {
  const entries = new Map<string, LocalEntry>()
  for (const [path, spec] of Object.entries(files)) {
    const key = canon(path)
    if (typeof spec === 'string') {
      entries.set(key, { state: spec })
      continue
    }
    const entry: LocalEntry = { state: spec.state ?? 'present' }
    if (entry.state === 'present') {
      if (spec.size !== undefined) entry.size = spec.size
      if (spec.mtimeMs !== undefined) entry.mtimeMs = spec.mtimeMs
      if (spec.md5 !== undefined) entry.md5 = spec.md5
    }
    entries.set(key, entry)
  }
  return {
    files: entries,
    dirs: new Set(dirs.map(canon)),
    unreadableDirs: new Map(),
    recursiveCounts: {},
  }
}

/** A Drive file described by the fields the engine reads. */
export interface DriveSpec {
  id: string
  name: string
  mimeType?: string
  size?: number
  md5?: string | null
  driveModifiedTime?: string
  parentPath?: string
  ambiguous?: boolean
  unrepresentable?: boolean
}

/** Build a Drive tree from a list of file specs. */
export function driveTree(specs: DriveSpec[]): DriveTree {
  const files = new Map<string, DriveFile[]>()
  const dirs = new Map<string, string>()
  const dirById = new Map<string, string>()

  for (const spec of specs) {
    const parentPath = spec.parentPath ?? ''
    const raw = parentPath === '' ? spec.name : `${parentPath}/${spec.name}`
    const path = canon(raw)
    const file: DriveFile = {
      id: spec.id,
      name: spec.name,
      mimeType: spec.mimeType ?? 'application/octet-stream',
      size: spec.size ?? 1024,
      md5: spec.md5 === undefined ? 'drive-md5' : spec.md5,
      driveModifiedTime: spec.driveModifiedTime ?? '2026-10-20T18:00:00.000Z',
      ambiguous: spec.ambiguous ?? false,
      unrepresentable: spec.unrepresentable ?? !isRepresentableOnWindows(spec.name),
    }
    const bucket = files.get(path)
    if (bucket) bucket.push(file)
    else files.set(path, [file])
  }

  return { files, dirs, dirById }
}

/** Build a Drive tree from raw listing nodes, the way the HTTP client does. */
export function driveTreeFromNodes(nodes: DriveNode[]): DriveTree {
  const files = new Map<string, DriveFile[]>()
  const dirs = new Map<string, string>()
  const dirById = new Map<string, string>()

  for (const node of nodes) {
    const { entry, parentPath } = node
    const raw = parentPath === '' ? entry.name : `${parentPath}/${entry.name}`
    const path = canon(raw)
    if (entry.mimeType === 'application/vnd.google-apps.folder') {
      dirs.set(path, entry.id)
      dirById.set(entry.id, path)
      continue
    }
    const file: DriveFile = {
      id: entry.id,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size === undefined ? undefined : Number(entry.size),
      md5: entry.md5Checksum ?? null,
      driveModifiedTime: entry.modifiedTime,
      ambiguous: false,
      unrepresentable: false,
    }
    const bucket = files.get(path)
    if (bucket) bucket.push(file)
    else files.set(path, [file])
  }

  return { files, dirs, dirById }
}

/** A live manifest entry, with only the fields a test cares about. */
export interface LiveSpec {
  driveFileId: string
  driveMd5?: string | null
  driveModifiedTime?: string
  driveMimeType?: string
  exportMime?: string | null
  localPath?: string
  localMd5?: string | null
  localSize?: number
  localMtimeMs?: number
}

/** Build a mirror manifest from a map of path -> live spec. */
export function mirrorManifest(
  files: Record<string, LiveSpec> = {},
  retired: MirrorManifest['retired'] = {},
  root = 'E:\\Medicine',
): MirrorManifest {
  const mirror = emptyMirror(root)
  for (const [path, spec] of Object.entries(files)) {
    const key = canon(path)
    mirror.files[key] = {
      displayPath: path,
      driveFileId: spec.driveFileId,
      driveMd5: spec.driveMd5 === undefined ? 'drive-md5' : spec.driveMd5,
      driveModifiedTime: spec.driveModifiedTime ?? '2026-10-20T18:00:00.000Z',
      driveMimeType: spec.driveMimeType ?? 'application/octet-stream',
      exportMime: spec.exportMime ?? null,
      localPath: canon(spec.localPath ?? path),
      localMd5: spec.localMd5 === undefined ? 'drive-md5' : spec.localMd5,
      localSize: spec.localSize ?? 1024,
      localMtimeMs: spec.localMtimeMs ?? 1759660800000,
    }
  }
  mirror.retired = { ...retired }
  return mirror
}

/**
 * The default I/O double.
 *
 * `md5Of` resolves against the local tree, so a test that puts an `md5` on a
 * local file gets that hash back. Everything else is unknown by default.
 */
export function diffIo(overrides: Partial<DiffIo> = {}, local?: LocalTree): DiffIo {
  return {
    probe: async (): Promise<ProbeResult> => ({ status: 'missing' }),
    md5Of: async (relPath: string) => {
      if (!local) return null
      const entry = local.files.get(canon(relPath))
      return entry?.md5 ?? null
    },
    readLocalBytes: async () => null,
    exportNative: async () => null,
    ...overrides,
  }
}

/** A whole empty manifest. */
export function manifest(): Manifest {
  return emptyManifest()
}

/** The manifest operations on a plan, flattened. */
export function planOps(ops: ManifestOp[]): ManifestOp[] {
  return ops
}
