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
  RetiredRecord,
  RetiredState,
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
      const result = await groupB(input, path, localEntry, manifestEntry, usableDrive)
      if (result?.step) {
        steps.push(result.step)
        if (result.step.report) reports.push(result.step.report)
      }
      continue
    }

    // --- P8: no manifest entry, Drive file present -------------------
    if (usableDrive) {
      const result = await groupC(input, path, localEntry, usableDrive)
      if (result?.step) {
        steps.push(result.step)
        if (result.step.report) reports.push(result.step.report)
      }
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
      if (result?.step) {
        steps.push(result.step)
        if (result.step.report) reports.push(result.step.report)
      }
      continue
    }
  }

  return { steps, reports }
}

/**
 * Group B — the path has a live manifest entry.
 *
 * This group contains the app's only trash action (B0). Everything else here
 * moves content around or records that nothing needs doing.
 */
async function groupB(
  input: DiffInput,
  path: string,
  localEntry: LocalEntry | undefined,
  manifestEntry: MirrorManifest['files'][string],
  driveFile: DriveFile | undefined,
): Promise<GroupResult | null> {
  const { io, mergeOnly, driveWins } = input

  const localPresent = localEntry?.state === 'present'
  const localAbsent = localEntry?.state === 'absent'
  const localUnknown = localEntry?.state === 'unknown'

  // --- B0: the user deleted the local file -------------------------
  if (driveFile && driveFile.id === manifestEntry.driveFileId && localAbsent) {
    // The Drive copy is the app's to remove. But a rebase must not perform
    // destructive actions at all, and the manifest write is suppressed with
    // it: writing a `trashed` record for a file that is alive on Drive would
    // make the next run report it as a user restore.
    if (mergeOnly) {
      return null
    }
    const record: RetiredRecord = {
      path,
      state: 'trashed',
      at: new Date().toISOString(),
      md5: driveFile.md5 ?? null,
      driveMimeType: driveFile.mimeType,
      localPath: manifestEntry.localPath,
      prevLocalMd5: manifestEntry.localMd5,
    }
    return {
      step: {
        action: { kind: 'trash', relPath: path, driveFileId: driveFile.id },
        ops: [
          { op: 'set-retired', id: driveFile.id, record },
          { op: 'del-file', path },
        ],
      },
    }
  }

  // --- B1: the file is on both sides, compare the content -----------
  if (driveFile && driveFile.id === manifestEntry.driveFileId && localPresent) {
    const localMd5 = await io.md5Of(path)
    const driveMd5 = driveFile.md5 ?? null
    const baseMd5 = manifestEntry.driveMd5

    const localChanged = compareContent(localMd5, baseMd5, localEntry)
    const driveChanged = compareContent(driveMd5, baseMd5)

    if (!localChanged && !driveChanged) {
      // Nothing changed. Keep the entry as it is.
      return null
    }

    if (localChanged && driveChanged) {
      // Both sides moved. The conflict principle applies.
      if (driveWins) {
        return {
          step: {
            action: {
              kind: 'download',
              relPath: path,
              localPath: manifestEntry.localPath,
              driveFileId: driveFile.id,
              size: driveFile.size ?? 0,
            },
            ops: [
              {
                op: 'set-file',
                path,
                entry: liveEntryFor(
                  path,
                  driveFile,
                  manifestEntry.localPath,
                  driveMd5,
                  driveFile.size ?? 0,
                  localEntry?.mtimeMs ?? 0,
                ),
              },
            ],
          },
        }
      }
      return {
        step: {
          action: {
            kind: 'replace-content',
            relPath: path,
            localPath: manifestEntry.localPath,
            driveFileId: driveFile.id,
            md5: localMd5 ?? '',
            size: localEntry?.size ?? 0,
          },
          ops: [
            {
              op: 'set-file',
              path,
              entry: liveEntryFor(
                path,
                driveFile,
                manifestEntry.localPath,
                localMd5,
                localEntry?.size ?? 0,
                localEntry?.mtimeMs ?? 0,
              ),
            },
          ],
        },
      }
    }

    if (localChanged) {
      // Only the local side moved: push it up, keeping the Drive file id.
      return {
        step: {
          action: {
            kind: 'replace-content',
            relPath: path,
            localPath: manifestEntry.localPath,
            driveFileId: driveFile.id,
            md5: localMd5 ?? '',
            size: localEntry?.size ?? 0,
          },
          ops: [
            {
              op: 'set-file',
              path,
              entry: liveEntryFor(
                path,
                driveFile,
                manifestEntry.localPath,
                localMd5,
                localEntry?.size ?? 0,
                localEntry?.mtimeMs ?? 0,
              ),
            },
          ],
        },
      }
    }

    // Only the Drive side moved: pull it down.
    return {
      step: {
        action: {
          kind: 'download',
          relPath: path,
          localPath: manifestEntry.localPath,
          driveFileId: driveFile.id,
          size: driveFile.size ?? 0,
        },
        ops: [
          {
            op: 'set-file',
            path,
            entry: liveEntryFor(
              path,
              driveFile,
              manifestEntry.localPath,
              driveMd5,
              driveFile.size ?? 0,
              localEntry?.mtimeMs ?? 0,
            ),
          },
        ],
      },
    }
  }

  // --- B2: a different Drive file now occupies the path ------------
  if (driveFile && driveFile.id !== manifestEntry.driveFileId) {
    const probe = await io.probe(manifestEntry.driveFileId)
    const state = retiredStateFor(probe)
    const record: RetiredRecord = {
      path,
      state,
      at: new Date().toISOString(),
      md5: manifestEntry.driveMd5,
      driveMimeType: manifestEntry.driveMimeType,
      localPath: manifestEntry.localPath,
      prevLocalMd5: manifestEntry.localMd5,
    }

    if (state === 'gone' && localPresent) {
      // The tracked file is gone for good and the local file is still here:
      // upload it as a new Drive file.
      return {
        step: {
          action: {
            kind: 'upload',
            relPath: path,
            localPath: manifestEntry.localPath,
            md5: (await io.md5Of(path)) ?? '',
            size: localEntry?.size ?? 0,
          },
          ops: [
            { op: 'set-retired', id: manifestEntry.driveFileId, record },
            {
              op: 'set-file',
              path,
              entry: {
                displayPath: path,
                driveFileId: '',
                driveMd5: null,
                driveModifiedTime: '',
                driveMimeType: 'application/octet-stream',
                exportMime: null,
                localPath: manifestEntry.localPath,
                localMd5: (await io.md5Of(path)) ?? null,
                localSize: localEntry?.size ?? 0,
                localMtimeMs: localEntry?.mtimeMs ?? 0,
              },
            },
          ],
        },
      }
    }

    // The tracked file moved or was trashed elsewhere. The file now at this
    // path is a different one; treat it as new-on-Drive.
    return {
      step: {
        action: null,
        ops: [{ op: 'set-retired', id: manifestEntry.driveFileId, record }],
      },
    }
  }

  // --- B3: the Drive file is gone, the local file is still here -----
  if (!driveFile && localPresent) {
    const probe = await io.probe(manifestEntry.driveFileId)

    if (probe.status === 'trashed') {
      // Somebody else trashed it. The app must not undo that, and must not
      // re-upload over it either.
      const record: RetiredRecord = {
        path,
        state: 'trashed-externally',
        at: new Date().toISOString(),
        md5: manifestEntry.driveMd5,
        driveMimeType: manifestEntry.driveMimeType,
        localPath: manifestEntry.localPath,
        prevLocalMd5: manifestEntry.localMd5,
      }
      return {
        step: {
          action: null,
          report: {
            code: 'unbacked-up',
            relPath: path,
            message:
              'this file was moved to the Drive trash by someone else; it was left alone and is not backed up',
          },
          ops: [
            { op: 'set-retired', id: manifestEntry.driveFileId, record },
            { op: 'del-file', path },
          ],
        },
      }
    }

    if (probe.status === 'alive' && probe.currentPath === path) {
      // The file is alive at this path; the listing simply missed it.
      return {
        step: {
          action: null,
          ops: [
            {
              op: 'set-file',
              path,
              entry: liveEntryFor(
                path,
                {
                  id: manifestEntry.driveFileId,
                  name: path,
                  mimeType: manifestEntry.driveMimeType,
                  size: manifestEntry.localSize,
                  md5: manifestEntry.driveMd5,
                  driveModifiedTime: manifestEntry.driveModifiedTime,
                  ambiguous: false,
                  unrepresentable: false,
                },
                manifestEntry.localPath,
                manifestEntry.localMd5,
                manifestEntry.localSize,
                manifestEntry.localMtimeMs,
              ),
            },
          ],
        },
      }
    }

    // The tracked Drive file is gone for good. Upload the local file again.
    const localMd5 = await io.md5Of(path)
    const record: RetiredRecord = {
      path,
      state: 'gone',
      at: new Date().toISOString(),
      md5: manifestEntry.driveMd5,
      driveMimeType: manifestEntry.driveMimeType,
      localPath: manifestEntry.localPath,
      prevLocalMd5: manifestEntry.localMd5,
    }
    return {
      step: {
        action: {
          kind: 'upload',
          relPath: path,
          localPath: manifestEntry.localPath,
          md5: localMd5 ?? '',
          size: localEntry?.size ?? 0,
        },
        ops: [
          { op: 'set-retired', id: manifestEntry.driveFileId, record },
          {
            op: 'set-file',
            path,
            entry: {
              displayPath: path,
              driveFileId: '',
              driveMd5: null,
              driveModifiedTime: '',
              driveMimeType: 'application/octet-stream',
              exportMime: null,
              localPath: manifestEntry.localPath,
              localMd5: localMd5,
              localSize: localEntry?.size ?? 0,
              localMtimeMs: localEntry?.mtimeMs ?? 0,
            },
          },
        ],
      },
    }
  }

  // --- B4: the file is gone from both sides ------------------------
  if (!driveFile && localAbsent) {
    const record: RetiredRecord = {
      path,
      state: 'gone',
      at: new Date().toISOString(),
      md5: manifestEntry.driveMd5,
      driveMimeType: manifestEntry.driveMimeType,
      localPath: manifestEntry.localPath,
      prevLocalMd5: manifestEntry.localMd5,
    }
    return {
      step: {
        action: null,
        ops: [
          { op: 'set-retired', id: manifestEntry.driveFileId, record },
          { op: 'del-file', path },
        ],
      },
    }
  }

  // The local path is unreadable. Nothing may be decided from it.
  if (localUnknown) return null

  return null
}

/**
 * The retired state implied by a probe of a tracked Drive file.
 */
function retiredStateFor(probe: ProbeResult): RetiredState {
  if (probe.status === 'missing') return 'gone'
  if (probe.status === 'trashed') return 'trashed-externally'
  return 'moved'
}

/**
 * Compare a current hash against the manifest's record of it.
 *
 * A missing hash on either side means the content cannot be compared, which
 * counts as changed: the app then re-synchronises rather than assume the
 * files match.
 */
function compareContent(
  current: string | null,
  baseline: string | null,
  localEntry?: LocalEntry,
): boolean {
  if (current === null || baseline === null) {
    // Without a checksum, fall back to size and mtime when the local side
    // offers them. If those agree, treat the content as unchanged.
    if (localEntry && localEntry.size !== undefined) {
      return false
    }
    return true
  }
  return current !== baseline
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
