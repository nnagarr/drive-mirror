/**
 * Domain types shared by the whole sync engine.
 *
 * This module holds types only — no logic, no I/O.
 */

/** State of a path in the local tree. */
export type LocalState = 'present' | 'absent' | 'unknown'

/**
 * One path in the local tree.
 *
 * `absent` means the path is not on disk (the user deleted it). `unknown`
 * means the path could not be read — it must never be treated as deleted.
 */
export interface LocalEntry {
  state: LocalState
  size?: number
  mtimeMs?: number
  md5?: string
}

/** A scanned local mirror root. */
export interface LocalTree {
  /** Canonical relative path -> entry. */
  files: Map<string, LocalEntry>
  /** Canonical relative directory paths. */
  dirs: Set<string>
  /** Canonical directory path -> why it could not be read. */
  unreadableDirs: Map<string, string>
  /** Canonical directory path -> number of present files in it and below. */
  recursiveCounts: Record<string, number>
}

/** One file in the Drive tree. */
export interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: number
  md5?: string | null
  driveModifiedTime: string
  /** More than one Drive file resolves to this path. */
  ambiguous: boolean
  /** The name cannot exist on a Windows filesystem. */
  unrepresentable: boolean
}

/** A raw Drive listing entry plus the mirror-relative path of its folder. */
export interface DriveNode {
  entry: {
    id: string
    name: string
    mimeType: string
    size?: string
    md5Checksum?: string
    modifiedTime: string
    trashed: boolean
    parents: string[]
  }
  /** Canonical path of the containing folder, `''` for the mirror root. */
  parentPath: string
}

/** A listed Drive mirror subtree. */
export interface DriveTree {
  /** Canonical relative path -> every Drive file at that path. */
  files: Map<string, DriveFile[]>
  /** Canonical relative directory path -> Drive folder id. */
  dirs: Map<string, string>
  /** Drive folder id -> canonical relative directory path. */
  dirById: Map<string, string>
}

/** A file the app currently tracks on both sides. */
export interface LiveEntry {
  displayPath: string
  driveFileId: string
  driveMd5: string | null
  driveModifiedTime: string
  driveMimeType: string
  /** Export mime for a Google-native file, else null. */
  exportMime: string | null
  /** Canonical local path. Differs from displayPath only for native exports. */
  localPath: string
  localMd5: string | null
  localSize: number
  localMtimeMs: number
}

/**
 * Why a Drive file is no longer tracked.
 *
 * `trashed` is the app's own doing (the local file was deleted).
 * `trashed-externally` is somebody else's doing and is never undone.
 */
export type RetiredState =
  | 'trashed'
  | 'trashed-externally'
  | 'gone'
  | 'restored'
  | 'purged'
  | 'moved'
  | 'rebased'
  | 'resynced'

/** A Drive file the app has stopped tracking. Never pruned. */
export interface RetiredRecord {
  /** The Drive file id. It is the key of the `retired` map, and the id of
   *  the file this record describes. */
  id: string
  /** The path the id occupied when it was retired. */
  path: string
  state: RetiredState
  at: string
  md5: string | null
  driveMimeType: string
  /** Export path, for a retired Google-native file. */
  localPath: string | null
  /** The local content hash at the moment of retirement. */
  prevLocalMd5?: string | null
}

/** Everything the app knows about one mirror. */
export interface MirrorManifest {
  root: string
  /** The destination under My Drive, e.g. "Archive/Photos". */
  drivePath?: string
  driveFolderId?: string
  driveFolderName?: string
  lastSyncAt?: string
  /** Canonical directory path -> recursive file count at the last sync. */
  lastCounts: Record<string, number>
  rebase: { pending: boolean; mergePolicy: 'local-wins' | 'drive-wins' } | null
  /** Canonical directory path -> Drive folder id. */
  dirs: Record<string, { driveFolderId: string }>
  /** Canonical Drive path -> live entry. */
  files: Record<string, LiveEntry>
  /** Drive file id -> retired record. */
  retired: Record<string, RetiredRecord>
}

/** The whole manifest. */
export interface Manifest {
  version: number
  updatedAt: string
  /** Drive letter -> volume fingerprint. */
  volumes: Record<string, { dev: number; label?: string; checkedAt: string }>
  mirrors: Record<string, MirrorManifest>
  /**
   * The Google account that owns this Drive data.
   *
   * Null when no run has recorded the account yet: not known yet, not
   * "no account".
   */
  accountEmail: string | null
}

/** A mutation of the manifest. */
export type ManifestOp =
  | { op: 'set-file'; path: string; entry: LiveEntry }
  | { op: 'del-file'; path: string }
  | { op: 'set-retired'; id: string; record: RetiredRecord }
  | { op: 'del-retired'; id: string }
  | { op: 'set-dir'; path: string; driveFolderId: string }

/**
 * A journalled operation.
 *
 * Every journalled operation names the mirror it belongs to. A `ManifestOp`
 * alone is not enough: it addresses a path within *a* mirror, and the
 * manifest holds several, so replaying an unscoped op against every mirror
 * would invent entries in mirrors that never held the file.
 *
 * An `intent` is written *before* a Drive mutation that cannot be recovered
 * from the manifest alone, so a crash mid-write can be reconciled.
 */
export type JournalOp =
  | { op: 'change'; mirror: string; change: ManifestOp }
  | {
      op: 'intent'
      kind: 'create-upload' | 'untrash'
      mirror: string
      path: string
      driveFileId?: string
      parentId?: string
      localMd5?: string
      size?: number
    }

/** Why the app is telling the user about a path it did not act on. */
export type ReportCode =
  | 'restored-from-trash'
  | 'unbacked-up'
  | 'native-path-conflict'
  | 'native-no-export'
  | 'anomaly'
  | 'rebased-not-downloaded'
  | 'stale-export'
  | 'ambiguous'
  | 'unrepresentable'
  | 'deferred-trash'

/** A note for the user about a path the app deliberately did not sync. */
export interface Report {
  code: ReportCode
  relPath: string
  message: string
}

/** What a probe of a known Drive file id found. */
export interface ProbeResult {
  status: 'missing' | 'trashed' | 'alive'
  /** The file's current path within the mirror, when it could be resolved. */
  currentPath?: string
}

/** Everything the diff engine needs from the outside world. */
export interface DiffIo {
  /** Ask what happened to a Drive file id the app used to track. */
  probe(driveFileId: string): Promise<ProbeResult>
  /** The MD5 of a local file, or null when it cannot be read. */
  md5Of(relPath: string): Promise<string | null>
  /** The bytes of a local file, or null when it cannot be read. */
  readLocalBytes(relPath: string): Promise<Buffer | null>
  /** The exported bytes of a Google-native Drive file, or null. */
  exportNative(driveFileId: string): Promise<Buffer | null>
}
