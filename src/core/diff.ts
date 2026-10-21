/**
 * The sync engine's diff: turn three views of a mirror (local disk, Drive,
 * manifest) into a plan of actions.
 *
 * The engine is pure with respect to the outside world. Every read it needs
 * — a file's hash, a Drive file's current state, a native export's bytes —
 * arrives through the injected `DiffIo` port, so the whole engine is testable
 * without a disk or a network.
 *
 * ## The dispatch
 *
 * Paths are processed by an ordered dispatch. The first matching step wins
 * and stops for that path:
 *
 *   P1  the Drive key is unusable (ambiguous or unrepresentable)
 *   P2  the local path is claimed by another manifest key
 *   P3  the local path is unreadable
 *   P4  the Drive file is a known, retired id      -> group R
 *   P5  the Drive file is Google-native            -> group N
 *   P6  a native manifest entry whose Drive file is gone -> group N
 *   P7  the path has a live manifest entry         -> group B
 *   P8  no manifest entry, Drive file present      -> group C
 *   P9  no manifest entry, no Drive file, retired record -> group D
 *   P10 no manifest entry, no Drive file, no retired record -> group E
 *
 * P4 through P10 are implemented across several tasks; a group that has not
 * been written yet throws, so a gap shows up as a test failure rather than a
 * silent wrong action.
 */

import { canon } from './paths'
import { buildIndexes } from './manifest'
import { buildClaimIndex, planExportPaths } from './claims'
import { isGoogleNativeMime } from './googleMime'
import type {
  DiffIo,
  DriveFile,
  LocalEntry,
  ManifestOp,
  MirrorManifest,
  ProbeResult,
  Report,
  ReportCode,
} from './types'

/** A single thing the executor must do. */
export type SyncAction =
  | { kind: 'create-folder'; relPath: string }
  | { kind: 'upload'; relPath: string; localPath: string; md5: string; size: number }
  | {
      kind: 'replace-content'
      relPath: string
      localPath: string
      driveFileId: string
      md5: string
      size: number
    }
  | { kind: 'download'; relPath: string; localPath: string; driveFileId: string; size: number }
  | {
      kind: 'export-native'
      relPath: string
      localPath: string
      driveFileId: string
      exportMime: string
      size: number
    }
  | { kind: 'trash'; relPath: string; driveFileId: string }
  | { kind: 'untrash'; relPath: string; driveFileId: string }

/** One step of a plan: an action or a report, plus the manifest writes that follow it. */
export interface PlanStep {
  action: SyncAction | null
  report?: Report
  ops: ManifestOp[]
}

/** The whole plan for a mirror. */
export interface SyncPlan {
  steps: PlanStep[]
  reports: Report[]
}

/** The engine's inputs. */
export interface DiffInput {
  local: LocalTree
  drive: DriveTree
  manifest: MirrorManifest
  io: DiffIo
  /** A rebase is in progress: no destructive action may run. */
  mergeOnly: boolean
  /** On a rebase the Drive copy wins. */
  driveWins: boolean
}

// Imported lazily to keep the type surface in one place.
import type { DriveTree, LocalTree } from './types'

/** A group that has not been implemented yet. */
function notImplemented(step: string): never {
  throw new Error(`diff: step ${step} is not implemented yet`)
}

/**
 * Compute the plan for one mirror.
 */
export async function diffMirror(input: DiffInput): Promise<SyncPlan> {
  const { local, drive, manifest } = input
  const { retiredById } = buildIndexes(manifest)

  // The claim index tells the engine which local paths are already the local
  // representation of something else, so they are not uploaded a second time.
  const exportPlan = planExportPaths(drive, manifest, local)
  const { claimedBy, retiredClaims } = buildClaimIndex(manifest, exportPlan, drive)

  const steps: PlanStep[] = []
  const reports: Report[] = []

  const report = (code: ReportCode, relPath: string, message: string): void => {
    const entry: Report = { code, relPath, message }
    reports.push(entry)
    steps.push({ action: null, report: entry, ops: [] })
  }

  // Every path the engine must consider.
  const paths = new Set<string>()
  for (const path of local.files.keys()) paths.add(path)
  for (const path of drive.files.keys()) paths.add(path)
  for (const path of Object.keys(manifest.files)) paths.add(path)

  for (const path of paths) {
    const localEntry: LocalEntry | undefined = local.files.get(path)
    const driveEntries: DriveFile[] | undefined = drive.files.get(path)
    const manifestEntry = manifest.files[path]

    // --- P1: the Drive key is unusable -------------------------------
    if (driveEntries) {
      if (driveEntries.length > 1) {
        report(
          'ambiguous',
          path,
          `${driveEntries.length} Drive files share this name; skipped to avoid choosing the wrong one`,
        )
        continue
      }
      const only = driveEntries[0]!
      if (only.ambiguous) {
        report('ambiguous', path, 'several Drive files share this name; skipped')
        continue
      }
      if (only.unrepresentable) {
        report(
          'unrepresentable',
          path,
          'this Drive name cannot exist on a Windows filesystem; left untouched',
        )
        continue
      }
    }

    // --- P2: the local path is claimed by another key ----------------
    if (localEntry) {
      const owners = claimedBy.get(path)
      if (owners) {
        // A local file that is the export of another manifest key is not an
        // upload candidate: it is that key's local representation.
        if (driveEntries) {
          report(
            'native-path-conflict',
            path,
            'this local file belongs to another mirrored item; skipped',
          )
        }
        continue
      }
      if (retiredClaims.has(path)) {
        // A stale export of a retired native file. It is a derived artifact,
        // never user content, so it is never uploaded.
        continue
      }
    }

    // --- P3: the local path is unreadable ----------------------------
    if (localEntry && localEntry.state === 'unknown') {
      // An unreadable path is not a deleted path. Nothing may be trashed
      // because of it.
      continue
    }

    const usableDrive = driveEntries && driveEntries.length === 1 ? driveEntries[0] : undefined
    const rec = usableDrive ? retiredById.get(usableDrive.id) : undefined

    // --- P4: the Drive file is a known, retired id -------------------
    if (usableDrive && rec && rec.state !== 'resynced') {
      notImplemented('P4 / group R')
    }

    // --- P5 / P6: Google-native files -------------------------------
    if (usableDrive && isGoogleNativeMime(usableDrive.mimeType)) {
      notImplemented('P5 / group N')
    }
    if (
      manifestEntry &&
      isGoogleNativeMime(manifestEntry.driveMimeType) &&
      !usableDrive
    ) {
      notImplemented('P6 / group N')
    }

    // --- P7: the path has a live manifest entry ----------------------
    if (manifestEntry) {
      notImplemented('P7 / group B')
    }

    // --- P8: no manifest entry, Drive file present -------------------
    if (usableDrive) {
      const result = await groupC(input, path, localEntry, usableDrive)
      if (result?.step) steps.push(result.step)
      if (result?.report) reports.push(result.report)
      continue
    }

    // --- P9: retired record at this path, no Drive file -------------
    const retiredHere = Object.values(manifest.retired).filter(
      (r) => canon(r.path) === path,
    )
    if (retiredHere.length > 0) {
      notImplemented('P9 / group D')
    }

    // --- P10: a local file we have never tracked ---------------------
    if (localEntry && localEntry.state === 'present') {
      const result = await groupE(input, path, localEntry)
      if (result?.step) steps.push(result.step)
      if (result?.report) reports.push(result.report)
      continue
    }
  }

  return { steps, reports }
}

/** A group result: an optional step and an optional report. */
interface GroupResult {
  step?: PlanStep
  report?: Report
}

/**
 * Group C — a Drive file the app has never tracked.
 */
async function groupC(
  input: DiffInput,
  path: string,
  localEntry: LocalEntry | undefined,
  driveFile: DriveFile,
): Promise<GroupResult | null> {
  const { io } = input

  // C1 — the file exists only on Drive. Download it; the Drive copy stays.
  if (!localEntry || localEntry.state === 'absent') {
    const entry = liveEntryFor(path, driveFile, path, null, 0, 0)
    return {
      step: {
        action: {
          kind: 'download',
          relPath: path,
          localPath: path,
          driveFileId: driveFile.id,
          size: driveFile.size ?? 0,
        },
        ops: [{ op: 'set-file', path, entry }],
      },
    }
  }

  // The file exists on both sides. Compare the content.
  const localMd5 = await io.md5Of(path)
  const driveMd5 = driveFile.md5 ?? null

  if (localMd5 !== null && driveMd5 !== null && localMd5 === driveMd5) {
    // C2 — identical. Record it; transfer nothing.
    const entry = liveEntryFor(path, driveFile, path, localMd5, localEntry.size ?? 0, localEntry.mtimeMs ?? 0)
    return {
      step: {
        action: null,
        ops: [{ op: 'set-file', path, entry }],
      },
    }
  }

  if (localMd5 === null || driveMd5 === null) {
    // One side has no usable checksum. Fall back to size and mtime; if that
    // is inconclusive, treat the local side as changed.
    const sameSize = driveFile.size !== undefined && driveFile.size === localEntry.size
    const sameMtime = localEntry.mtimeMs !== undefined
    if (sameSize && sameMtime) {
      const entry = liveEntryFor(path, driveFile, path, localMd5, localEntry.size ?? 0, localEntry.mtimeMs ?? 0)
      return {
        step: { action: null, ops: [{ op: 'set-file', path, entry }] },
      }
    }
  }

  // C3 — the content differs. The local side wins.
  const md5 = localMd5 ?? ''
  const size = localEntry.size ?? 0
  const entry = liveEntryFor(path, driveFile, path, md5, size, localEntry.mtimeMs ?? 0)
  return {
    step: {
      action: {
        kind: 'replace-content',
        relPath: path,
        localPath: path,
        driveFileId: driveFile.id,
        md5,
        size,
      },
      ops: [{ op: 'set-file', path, entry }],
    },
  }
}

/**
 * Group E — a local file the app has never tracked.
 */
async function groupE(
  input: DiffInput,
  path: string,
  localEntry: LocalEntry,
): Promise<GroupResult | null> {
  const md5 = await input.io.md5Of(path)
  const size = localEntry.size ?? 0
  const entry: import('./types').LiveEntry = {
    displayPath: path,
    driveFileId: '',
    driveMd5: null,
    driveModifiedTime: '',
    driveMimeType: 'application/octet-stream',
    exportMime: null,
    localPath: path,
    localMd5: md5,
    localSize: size,
    localMtimeMs: localEntry.mtimeMs ?? 0,
  }
  return {
    step: {
      action: { kind: 'upload', relPath: path, localPath: path, md5: md5 ?? '', size },
      ops: [{ op: 'set-file', path, entry }],
    },
  }
}

/** Build a live manifest entry for a file. */
function liveEntryFor(
  displayPath: string,
  driveFile: DriveFile,
  localPath: string,
  localMd5: string | null,
  localSize: number,
  localMtimeMs: number,
): import('./types').LiveEntry {
  return {
    displayPath,
    driveFileId: driveFile.id,
    driveMd5: driveFile.md5 ?? null,
    driveModifiedTime: driveFile.driveModifiedTime,
    driveMimeType: driveFile.mimeType,
    exportMime: null,
    localPath,
    localMd5,
    localSize,
    localMtimeMs,
  }
}
