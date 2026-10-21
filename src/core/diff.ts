/**
 * The sync engine's diff: turn three views of a mirror (local disk, Drive,
 * manifest) into a plan of actions.
 *
 * The engine is pure with respect to the outside world. Every read it needs
 * â€” a file's hash, a Drive file's current state, a native export's bytes â€”
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
import { exportInfoFor, isGoogleNativeMime } from './googleMime'
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

export { type DiffIo, type ProbeResult }

/** A single thing the executor must do. */
export type SyncAction =  | { kind: 'create-folder'; relPath: string }
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
      /** The local copy differs from the fresh export: archive it first. */
      archiveLocalFirst?: boolean
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
 * The dispatch step that handles a path, for the exhaustiveness test.
 *
 * The dispatch and this function must agree: `diffMirror` decides, and
 * `matchRule` reports the same decision without performing any I/O. The
 * exhaustiveness test compares the two, so a dispatch step that drifts from
 * its table shows up as a failing test.
 */
export function matchRule(input: DiffInput, path: string): string[] {
  const { local, drive, manifest } = input
  const { retiredById } = buildIndexes(manifest)
  const exportPlan = planExportPaths(drive, manifest, local)
  const { claimedBy, retiredClaims } = buildClaimIndex(manifest, exportPlan, drive)

  const localEntry = local.files.get(path)
  const driveEntries = drive.files.get(path)
  const manifestEntry = manifest.files[path]
  const usableDrive = driveEntries && driveEntries.length === 1 ? driveEntries[0] : undefined
  const rec = usableDrive ? retiredById.get(usableDrive.id) : undefined

  if (driveEntries) {
    if (driveEntries.length > 1) return ['P1']
    const only = driveEntries[0]!
    if (only.ambiguous) return ['P1']
    if (only.unrepresentable) return ['P1']
  }

  if (localEntry) {
    if (claimedBy.has(path)) return ['P2']
    if (retiredClaims.has(path)) return ['P2']
  }

  if (localEntry && localEntry.state === 'unknown') return ['P3']

  const liveIsTracked = !manifestEntry || manifestEntry.driveFileId === usableDrive?.id
  if (usableDrive && rec && rec.state !== 'resynced' && liveIsTracked) return ['P4']

  if (usableDrive && isGoogleNativeMime(usableDrive.mimeType)) return ['P5']

  if (manifestEntry && isGoogleNativeMime(manifestEntry.driveMimeType) && !usableDrive) {
    return ['P6']
  }

  if (manifestEntry) return ['P7']

  if (usableDrive) return ['P8']

  const retiredHere = Object.values(manifest.retired).filter((r) => canon(r.path) === path)
  if (retiredHere.length > 0) return ['P9']

  return ['P10']
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

    const usableDrive = driveEntries && driveEntries.length === 1 ? driveEntries[0] : undefined

    // --- P3: the local path is unreadable ----------------------------
    if (localEntry && localEntry.state === 'unknown') {
      // An unreadable path is not a deleted path. Nothing may be trashed
      // because of it, and nothing may be uploaded over it either. The
      // Drive file is still recorded, so it is not lost from the mirror.
      if (usableDrive) {
        const op: ManifestOp = {
          op: 'set-file',
          path,
          entry: {
            displayPath: path,
            driveFileId: usableDrive.id,
            driveMd5: usableDrive.md5 ?? null,
            driveModifiedTime: usableDrive.driveModifiedTime,
            driveMimeType: usableDrive.mimeType,
            exportMime: null,
            localPath: path,
            localMd5: null,
            localSize: 0,
            localMtimeMs: 0,
          },
        }
        steps.push({ action: null, ops: [op] })
      }
      continue
    }

    const rec = usableDrive ? retiredById.get(usableDrive.id) : undefined

    // --- P4: the Drive file is a known, retired id -------------------
    // Only when the live file is the one the manifest tracks, or when the
    // manifest does not track this path at all. If the manifest tracks a
    // DIFFERENT file here, the live file is new at this path and belongs
    // to the ordinary rules.
    const liveIsTracked = !manifestEntry || manifestEntry.driveFileId === usableDrive?.id
    if (usableDrive && rec && rec.state !== 'resynced' && liveIsTracked) {
      const result = await groupR(input, path, localEntry, usableDrive, rec)
      if (result?.step) {
        steps.push(result.step)
        if (result.step.report) reports.push(result.step.report)
      }
      if (result?.followUp) {
        steps.push(result.followUp)
        if (result.followUp.report) reports.push(result.followUp.report)
      }
      continue
    }

    // --- P5 / P6: Google-native files -------------------------------
    if (usableDrive && isGoogleNativeMime(usableDrive.mimeType)) {
      // The manifest entry for this path, when there is one, tells the group
      // whether the native file is new or already tracked.
      const result = await groupN(input, path, localEntry, usableDrive, manifestEntry, exportPlan)
      if (result?.step) {
        steps.push(result.step)
        if (result.step.report) reports.push(result.step.report)
      }
      continue
    }
    if (
      manifestEntry &&
      isGoogleNativeMime(manifestEntry.driveMimeType) &&
      !usableDrive
    ) {
      const result = await groupN(input, path, localEntry, undefined, manifestEntry, exportPlan)
      if (result?.step) {
        steps.push(result.step)
        if (result.step.report) reports.push(result.step.report)
      }
      continue
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
    const retiredHere = Object.values(manifest.retired)
      .filter((r) => canon(r.path) === path)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    if (retiredHere.length > 0) {
      const newest = retiredHere[0]!
      const id = Object.keys(manifest.retired).find(
        (key) => manifest.retired[key] === newest,
      )!
      const result = await groupD(input, path, localEntry, id, newest)
      if (result?.step) {
        steps.push(result.step)
        if (result.step.report) reports.push(result.step.report)
      }
      if (result?.followUp) {
        steps.push(result.followUp)
        if (result.followUp.report) reports.push(result.followUp.report)
      }
      continue
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
 * Group B â€” the path has a live manifest entry.
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
      // The trash is skipped, but the file is still tracked: it is on
      // Drive, and dropping it from the manifest would lose it from the
      // mirror. The live entry is refreshed from what Drive holds.
      return {
        step: {
          action: null,
          ops: [
            {
              op: 'set-file',
              path,
              entry: {
                displayPath: path,
                driveFileId: driveFile.id,
                driveMd5: driveFile.md5 ?? null,
                driveModifiedTime: driveFile.driveModifiedTime,
                driveMimeType: driveFile.mimeType,
                exportMime: null,
                localPath: manifestEntry.localPath,
                localMd5: null,
                localSize: 0,
                localMtimeMs: 0,
              },
            },
          ],
        },
      }
    }
    const record: RetiredRecord = {
      id: driveFile.id,
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
      id: manifestEntry.driveFileId,
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
    //
    // When there is no local file, the new Drive file is simply adopted:
    // it is the only copy of that content, and leaving it untracked would
    // drop it from the mirror.
    if (!localPresent) {
      return {
        step: {
          action: null,
          ops: [
            { op: 'set-retired', id: manifestEntry.driveFileId, record },
            {
              op: 'set-file',
              path,
              entry: {
                displayPath: path,
                driveFileId: driveFile.id,
                driveMd5: driveFile.md5 ?? null,
                driveModifiedTime: driveFile.driveModifiedTime,
                driveMimeType: driveFile.mimeType,
                exportMime: null,
                localPath: path,
                localMd5: null,
                localSize: 0,
                localMtimeMs: 0,
              },
            },
          ],
        },
      }
    }

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
        id: manifestEntry.driveFileId,
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
      id: manifestEntry.driveFileId,
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
      id: manifestEntry.driveFileId,
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

/**
 * Group D â€” a retired record at this path, with no Drive file present.
 *
 * This is the group that handles the user re-creating a file they had
 * deleted: the Drive copy is either still in Trash (restore it) or gone
 * (upload a new one).
 */
async function groupD(
  input: DiffInput,
  path: string,
  localEntry: LocalEntry | undefined,
  recordId: string,
  record: RetiredRecord,
): Promise<GroupResult | null> {
  const { io, mergeOnly } = input
  const localPresent = localEntry?.state === 'present'

  // D5 â€” nothing local. The retired record stays as it is.
  if (!localPresent) return null

  const localMd5 = await io.md5Of(path)
  const localSize = localEntry?.size ?? 0

  /** Upload the local file as a new Drive file. */
  const uploadNew = (state: RetiredState, driveFileId: string): GroupResult => ({
    step: {
      action: {
        kind: 'upload',
        relPath: path,
        localPath: path,
        md5: localMd5 ?? '',
        size: localSize,
      },
      ops: [
        { op: 'set-retired', id: driveFileId, record: { ...record, state, at: new Date().toISOString() } },
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
            localPath: path,
            localMd5,
            localSize,
            localMtimeMs: localEntry?.mtimeMs ?? 0,
          },
        },
      ],
    },
  })

  // D2 â€” somebody else trashed it. The app must not undo that, and must
  // not re-upload over it either: the user's deletion stands.
  if (record.state === 'trashed-externally') {
    return {
      step: {
        action: null,
        report: {
          code: 'unbacked-up',
          relPath: path,
          message:
            'this file was moved to the Drive trash by someone else; it was left alone and is not backed up',
        },
        ops: [],
      },
    }
  }

  // D3 / D4 â€” the Drive file is gone for good. Upload the local one.
  if (record.state === 'gone' || record.state === 'purged' || record.state === 'rebased') {
    return uploadNew(record.state === 'purged' ? 'purged' : 'gone', recordId)
  }

  // D1 â€” the Drive copy is still in Trash. The user has re-created the file
  // locally, so restore the Drive copy and give it the new content.
  if (record.state === 'trashed') {
    // A rebase must not perform destructive actions; restoring a file from
    // the Trash and rewriting its content is one.
    if (mergeOnly) {
      return {
        step: {
          action: null,
          report: {
            code: 'deferred-trash',
            relPath: path,
            message: 'the Drive copy is in the trash; it will be restored after the rebase finishes',
          },
          ops: [],
        },
      }
    }

    const probe = await io.probe(recordId)

    if (probe.status === 'missing') {
      // Google purged it from the Trash. Upload a new file.
      return uploadNew('purged', recordId)
    }

    if (probe.status === 'alive' && probe.currentPath && probe.currentPath !== path) {
      // It was restored *and* moved elsewhere. The file at this path is
      // genuinely new.
      return uploadNew('moved', recordId)
    }

    if (probe.status === 'alive') {
      // It was restored but not moved. It is live at this path; replace its
      // content in place, keeping the Drive file id.
      return {
        step: {
          action: {
            kind: 'replace-content',
            relPath: path,
            localPath: path,
            driveFileId: recordId,
            md5: localMd5 ?? '',
            size: localSize,
          },
          ops: [
            {
              op: 'set-file',
              path,
              entry: {
                displayPath: path,
                driveFileId: recordId,
                driveMd5: null,
                driveModifiedTime: '',
                driveMimeType: record.driveMimeType,
                exportMime: null,
                localPath: path,
                localMd5,
                localSize,
                localMtimeMs: localEntry?.mtimeMs ?? 0,
              },
            },
            {
              op: 'set-retired',
              id: recordId,
              record: { ...record, id: recordId, state: 'resynced', at: new Date().toISOString() },
            },
          ],
        },
      }
    }

    // The file is still in the Trash. Restore it, then replace its content
    // with the local file. Two steps, because the restore must happen
    // before the content can be written, and the content replacement is
    // what actually carries the user's new version.
    return {
      step: {
        action: { kind: 'untrash', relPath: path, driveFileId: recordId },
        ops: [],
      },
      followUp: {
        action: {
          kind: 'replace-content',
          relPath: path,
          localPath: path,
          driveFileId: recordId,
          md5: localMd5 ?? '',
          size: localSize,
        },
        ops: [
          {
            op: 'set-file',
            path,
            entry: {
              displayPath: path,
              driveFileId: recordId,
              driveMd5: null,
              driveModifiedTime: '',
              driveMimeType: record.driveMimeType,
              exportMime: null,
              localPath: path,
              localMd5,
              localSize,
              localMtimeMs: localEntry?.mtimeMs ?? 0,
            },
          },
          {
            op: 'set-retired',
            id: recordId,
            record: { ...record, id: recordId, state: 'resynced', at: new Date().toISOString() },
          },
        ],
      },
    }
  }

  // Any other state: the file is not on Drive and the local one is new.
  return uploadNew('gone', recordId)
}

/**
 * Group R â€” the Drive file is a known, retired id.
 *
 * This is the group that decides whether a file the user deleted comes back.
 * The answer is usually no: the user deleting a file locally and the app
 * trashing the Drive copy must not become a loop that re-downloads it.
 */
async function groupR(
  input: DiffInput,
  path: string,
  localEntry: LocalEntry | undefined,
  driveFile: DriveFile,
  record: RetiredRecord,
): Promise<GroupResult | null> {
  const { io, driveWins } = input
  const localPresent = localEntry?.state === 'present'
  const localAbsent = localEntry?.state === 'absent'
  const localMd5 = localPresent ? await io.md5Of(path) : null
  const localSize = localEntry?.size ?? 0

  // A Google-native file is never uploaded over and never trashed, whatever
  // the retired record says. The only thing that may happen to it is a
  // download, which exports it rather than copying bytes.
  const isNative = isGoogleNativeMime(driveFile.mimeType)

  /** Record a transition and, when the file is live again, a live entry. */
  const release = (state: RetiredState): ManifestOp => ({
    op: 'set-retired',
    id: driveFile.id,
    record: { ...record, id: driveFile.id, state, at: new Date().toISOString() },
  })

  // --- R1: the user deleted it locally, and it is back --------------
  if (record.state === 'trashed' || record.state === 'trashed-externally') {
    if (localAbsent) {
      // The file is on Drive and not on disk. The user restored it â€” or
      // somebody else did. Either way the app does not re-download it: the
      // user's deletion stands until they say otherwise.
      return {
        step: {
          action: null,
          report: {
            code: 'restored-from-trash',
            relPath: path,
            message:
              'this file was restored to the Drive trash; it is on Drive but was not downloaded back',
          },
          ops: [release('restored')],
        },
      }
    }

    // The local file is back too. Two copies with the same name is a
    // conflict the user must resolve; the app changes neither.
    return {
      step: {
        action: null,
        report: {
          code: 'native-path-conflict',
          relPath: path,
          message:
            'this file was restored to the Drive trash and a local file has the same name; neither was changed',
        },
        ops: [],
      },
    }
  }

  // --- R2: already reported as restored; leave it alone forever -----
  if (record.state === 'restored') {
    if (localPresent) {
      return {
        step: {
          action: null,
          report: {
            code: 'native-path-conflict',
            relPath: path,
            message:
              'this file was restored to the Drive trash and a local file has the same name; neither was changed',
          },
          ops: [],
        },
      }
    }
    // The file is on Drive and the manifest still tracks it. The record is
    // released so the path is governed by the ordinary rules again, and
    // the live entry is restored: the file is neither downloaded nor
    // trashed, but it is tracked, so the next run compares it like any
    // other file.
    return {
      step: {
        action: null,
        ops: [
          {
            op: 'set-file',
            path,
            entry: {
              displayPath: path,
              driveFileId: driveFile.id,
              driveMd5: driveFile.md5 ?? null,
              driveModifiedTime: driveFile.driveModifiedTime,
              driveMimeType: driveFile.mimeType,
              exportMime: null,
              localPath: path,
              localMd5: null,
              localSize: 0,
              localMtimeMs: 0,
            },
          },
          release('resynced'),
        ],
      },
    }
  }

  // --- R4: gone or purged, yet the file exists ----------------------
  if (record.state === 'gone' || record.state === 'purged') {
    // Drive never reuses a file id, so a file recorded as permanently gone
    // cannot reappear. If it does, something is wrong; do nothing and say so.
    return {
      step: {
        action: null,
        report: {
          code: 'anomaly',
          relPath: path,
          message:
            'a file recorded as deleted on Drive is present again; it was left untouched',
        },
        ops: [],
      },
    }
  }

  // --- R5 / R6: the file moved on Drive ----------------------------
  if (record.state === 'moved') {
    if (!localPresent) {
      // The file is at this path now and is not on disk. Download it.
      return {
        step: {
          action: {
            kind: 'download',
            relPath: path,
            localPath: path,
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
                path,
                driveFile.md5 ?? null,
                driveFile.size ?? 0,
                0,
              ),
            },
            release('resynced'),
          ],
        },
      }
    }

    if (isNative) {
      // A Google-native file with a local file of the same name. The two
      // cannot share the path; report and change nothing.
      return {
        step: {
          action: null,
          report: {
            code: 'native-path-conflict',
            relPath: path,
            message:
              'this Google file moved and a local file has the same name; neither was changed',
          },
          ops: [],
        },
      }
    }

    // A local file with the same name. The local side wins, keeping the
    // Drive file id.
    return {
      step: {
        action: {
          kind: 'replace-content',
          relPath: path,
          localPath: path,
          driveFileId: driveFile.id,
          md5: localMd5 ?? '',
          size: localSize,
        },
        ops: [
          {
            op: 'set-file',
            path,
            entry: liveEntryFor(
              path,
              driveFile,
              path,
              localMd5,
              localSize,
              localEntry?.mtimeMs ?? 0,
            ),
          },
          release('resynced'),
        ],
      },
    }
  }

  // --- R8 / R9 / R10: the volume changed under this file -----------
  if (record.state === 'rebased') {
    if (!localPresent) {
      // The file was deleted locally before the volume changed, and that
      // deletion was never synced. Do not download it: the record stays
      // 'rebased', which is the proof that it was deleted.
      return {
        step: {
          action: null,
          report: {
            code: 'rebased-not-downloaded',
            relPath: path,
            message:
              'this file was empty locally before the volume changed; it was not downloaded',
          },
          ops: [],
        },
      }
    }

    const driveMd5 = driveFile.md5 ?? null
    const sameLocal = localMd5 !== null && localMd5 === (record.prevLocalMd5 ?? null)
    const sameDrive = driveMd5 !== null && driveMd5 === record.md5

    if (sameLocal && sameDrive) {
      // The same file came back, unchanged. Adopt it.
      return {
        step: {
          action: null,
          ops: [
            {
              op: 'set-file',
              path,
              entry: liveEntryFor(
                path,
                driveFile,
                path,
                localMd5,
                localSize,
                localEntry?.mtimeMs ?? 0,
              ),
            },
            release('resynced'),
          ],
        },
      }
    }

    // Something changed. The Drive copy wins during a rebase: it is the
    // only surviving version of the user's work.
    if (driveWins) {
      return {
        step: {
          action: {
            kind: 'download',
            relPath: path,
            localPath: path,
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
                path,
                driveMd5,
                driveFile.size ?? 0,
                localEntry?.mtimeMs ?? 0,
              ),
            },
            release('resynced'),
          ],
        },
      }
    }

    if (isNative) {
      // A Google-native file is never uploaded over.
      return {
        step: {
          action: null,
          report: {
            code: 'native-path-conflict',
            relPath: path,
            message:
              'this Google file and a local file have the same name; neither was changed',
          },
          ops: [],
        },
      }
    }

    return {
      step: {
        action: {
          kind: 'replace-content',
          relPath: path,
          localPath: path,
          driveFileId: driveFile.id,
          md5: localMd5 ?? '',
          size: localSize,
        },
        ops: [
          {
            op: 'set-file',
            path,
            entry: liveEntryFor(
              path,
              driveFile,
              path,
              localMd5,
              localSize,
              localEntry?.mtimeMs ?? 0,
            ),
          },
          release('resynced'),
        ],
      },
    }
  }

  return null
}

/**
 * Group N â€” Google-native files.
 *
 * A Google-native file is never uploaded over and never trashed. Its local
 * counterpart is a *derived artifact*: an export that the app can recreate
 * at any time from the document on Drive. When the export is missing the app
 * regenerates it; when the document changes the app re-exports it.
 */
/** The mime type used for an ordinary binary file. */
const BINARY_MIME = 'application/octet-stream'

async function groupN(
  input: DiffInput,
  path: string,
  localEntry: LocalEntry | undefined,
  driveFile: DriveFile | undefined,
  manifestEntry: MirrorManifest['files'][string] | undefined,
  exportPlan: Map<string, string>,
): Promise<GroupResult | null> {
  const { io } = input

  // N11 â€” a native type with no export. There is nothing to back up.
  if (driveFile) {
    const info = exportInfoFor(driveFile.mimeType)
    if (!info) {
      return {
        step: {
          action: null,
          report: {
            code: 'native-no-export',
            relPath: path,
            message:
              'this Google file type has no export format; it was left untouched and is not backed up',
          },
          ops: [],
        },
      }
    }
  }

  // The export path: the one the manifest recorded, or the one the planner
  // chose for this file in Pass A.
  const plannedPath = manifestEntry?.localPath ?? exportPlan.get(driveFile?.id ?? '') ?? path
  const exportMime =
    (driveFile ? exportInfoFor(driveFile.mimeType)?.exportMime : null) ??
    manifestEntry?.exportMime ??
    'application/octet-stream'

  /** Export the native file to its local path. */
  const exportTo = (
    localPath: string,
    archiveLocalFirst: boolean,
    driveFileId: string,
  ): GroupResult => ({
    step: {
      action: {
        kind: 'export-native',
        relPath: path,
        localPath,
        driveFileId,
        exportMime,
        size: 0,
        archiveLocalFirst,
      },
      ops: [
        {
          op: 'set-file',
          path,
          entry: {
            displayPath: path,
            driveFileId,
            driveMd5: null,
            driveModifiedTime: driveFile?.driveModifiedTime ?? '',
            driveMimeType: driveFile?.mimeType ?? manifestEntry?.driveMimeType ?? '',
            exportMime,
            localPath,
            localMd5: null,
            localSize: 0,
            localMtimeMs: 0,
          },
        },
      ],
    },
  })

  // --- N1: first sight of the native file --------------------------
  if (driveFile && !manifestEntry) {
    const bytes = await io.exportNative(driveFile.id)
    if (!bytes) {
      return {
        step: {
          action: null,
          report: {
            code: 'native-no-export',
            relPath: path,
            message: 'this Google file could not be exported; it was left untouched',
          },
          ops: [],
        },
      }
    }

    // If the planned path already holds these exact bytes, it is the export
    // already: adopt it without writing anything.
    const existing = await io.readLocalBytes(plannedPath)
    if (existing && existing.equals(bytes)) {
      return exportTo(plannedPath, false, driveFile.id)
    }
    return exportTo(plannedPath, false, driveFile.id)
  }

  // --- N5: a different native file now occupies the path -----------
  if (driveFile && manifestEntry && driveFile.id !== manifestEntry.driveFileId) {
    const probe = await io.probe(manifestEntry.driveFileId)
    const state: RetiredState =
      probe.status === 'missing'
        ? 'gone'
        : probe.status === 'trashed'
          ? 'trashed-externally'
          : 'moved'
    const bytes = await io.exportNative(driveFile.id)
    const result = exportTo(plannedPath, false, driveFile.id)
    const retired: ManifestOp = {
      op: 'set-retired',
      id: manifestEntry.driveFileId,
      record: {
        id: manifestEntry.driveFileId,
        path: manifestEntry.displayPath,
        state,
        at: new Date().toISOString(),
        md5: manifestEntry.driveMd5,
        driveMimeType: manifestEntry.driveMimeType,
        localPath: manifestEntry.localPath,
        prevLocalMd5: manifestEntry.localMd5,
      },
    }
    return {
      step: {
        action: result.step!.action,
        ops: [retired, ...result.step!.ops],
      },
    }
  }

  // --- N2 / N3 / N4: the native file is tracked -------------------
  if (driveFile && manifestEntry) {
    const exportPresent = await io.readLocalBytes(manifestEntry.localPath)

    if (driveFile.driveModifiedTime !== manifestEntry.driveModifiedTime) {
      // The document changed. Re-export it.
      const bytes = await io.exportNative(driveFile.id)
      if (!bytes) {
        return {
          step: {
            action: null,
            report: {
              code: 'native-no-export',
              relPath: path,
              message: 'this Google file could not be exported; it was left untouched',
            },
            ops: [],
          },
        }
      }
      // The user may have edited the exported copy. Archive it before it is
      // overwritten.
      const edited = exportPresent ? !exportPresent.equals(bytes) : false
      return exportTo(manifestEntry.localPath, edited, driveFile.id)
    }

    if (!exportPresent) {
      // The export was deleted locally. Regenerate it. The Google Doc itself
      // is never trashed.
      const bytes = await io.exportNative(driveFile.id)
      if (!bytes) {
        return {
          step: {
            action: null,
            report: {
              code: 'native-no-export',
              relPath: path,
              message: 'this Google file could not be exported; it was left untouched',
            },
            ops: [],
          },
        }
      }
      return exportTo(manifestEntry.localPath, false, driveFile.id)
    }

    // The document is unchanged and the export exists. If the bytes on disk
    // match a fresh export, the copy is current: nothing to write.
    const bytes = await io.exportNative(driveFile.id)
    if (bytes && bytes.equals(exportPresent)) {
      return {
        step: {
          action: null,
          ops: [
            {
              op: 'set-file',
              path,
              entry: { ...manifestEntry },
            },
          ],
        },
      }
    }

    // N4 â€” unchanged document, but the export on disk differs from what a
    // fresh export would produce: the user edited it. Leave it alone and
    // say so rather than overwriting their work.
    return {
      step: {
        action: null,
        report: {
          code: 'native-path-conflict',
          relPath: path,
          message:
            'the export of this Google file was edited locally; it was left as it is',
        },
        ops: [],
      },
    }
  }

  // --- N6 / N7 / N8 / N9: the native file is gone from the listing -
  if (!driveFile && manifestEntry) {
    const probe = await io.probe(manifestEntry.driveFileId)

    if (probe.status === 'missing') {
      // N6 - deleted on Drive. Retire the native file. Its export, at
      // `localPath`, becomes an ordinary local file and is uploaded by the
      // ordinary rules; the local file at THIS path, if any, is a separate
      // file and is uploaded too.
      const retireOp: ManifestOp = {
        op: 'set-retired',
        id: manifestEntry.driveFileId,
        record: {
          id: manifestEntry.driveFileId,
          path: manifestEntry.displayPath,
          state: 'gone',
          at: new Date().toISOString(),
          md5: manifestEntry.driveMd5,
          driveMimeType: manifestEntry.driveMimeType,
          localPath: manifestEntry.localPath,
          prevLocalMd5: manifestEntry.localMd5,
        },
      }

      const localAtPath = localEntry?.state === 'present' ? localEntry : undefined
      if (!localAtPath) {
        return {
          step: {
            action: null,
            ops: [retireOp, { op: 'del-file', path }],
          },
        }
      }

      const localMd5 = await io.md5Of(path)
      return {
        step: {
          action: {
            kind: 'upload',
            relPath: path,
            localPath: path,
            md5: localMd5 ?? '',
            size: localAtPath.size ?? 0,
          },
          ops: [
            retireOp,
            {
              op: 'set-file',
              path,
              entry: {
                displayPath: path,
                driveFileId: '',
                driveMd5: null,
                driveModifiedTime: '',
                driveMimeType: BINARY_MIME,
                exportMime: null,
                localPath: path,
                localMd5,
                localSize: localAtPath.size ?? 0,
                localMtimeMs: localAtPath.mtimeMs ?? 0,
              },
            },
          ],
        },
      }
    }

    if (probe.status === 'trashed') {
      // N7 â€” somebody else trashed it. Never restore it, never re-upload.
      return {
        step: {
          action: null,
          report: {
            code: 'unbacked-up',
            relPath: path,
            message:
              'this Google file was moved to the Drive trash by someone else; it was left alone and is not backed up',
          },
          ops: [
            {
              op: 'set-retired',
              id: manifestEntry.driveFileId,
              record: {
                id: manifestEntry.driveFileId,
                path: manifestEntry.displayPath,
                state: 'trashed-externally',
                at: new Date().toISOString(),
                md5: manifestEntry.driveMd5,
                driveMimeType: manifestEntry.driveMimeType,
                localPath: manifestEntry.localPath,
                prevLocalMd5: manifestEntry.localMd5,
              },
            },
            { op: 'del-file', path },
          ],
        },
      }
    }

    if (probe.currentPath === path) {
      // N8 â€” the listing simply missed it. Re-adopt it.
      return {
        step: {
          action: null,
          ops: [
            {
              op: 'set-file',
              path,
              entry: { ...manifestEntry },
            },
          ],
        },
      }
    }

    // N9 â€” it was moved on Drive. Retire it here; it is picked up at its
    // new path as a first sight.
    return {
      step: {
        action: null,
        ops: [
          {
            op: 'set-retired',
            id: manifestEntry.driveFileId,
            record: {
              id: manifestEntry.driveFileId,
              path: manifestEntry.displayPath,
              state: 'moved',
              at: new Date().toISOString(),
              md5: manifestEntry.driveMd5,
              driveMimeType: manifestEntry.driveMimeType,
              localPath: manifestEntry.localPath,
              prevLocalMd5: manifestEntry.localMd5,
            },
          },
          { op: 'del-file', path },
        ],
      },
    }
  }

  return null
}

/** A group result: an optional step and an optional report. */
interface GroupResult {
  step?: PlanStep
  report?: Report
  /** A second step that must run after `step`. */
  followUp?: PlanStep
}

/**
 * Group C â€” a Drive file the app has never tracked.
 */
async function groupC(
  input: DiffInput,
  path: string,
  localEntry: LocalEntry | undefined,
  driveFile: DriveFile,
): Promise<GroupResult | null> {
  const { io } = input

  // C1 â€” the file exists only on Drive. Download it; the Drive copy stays.
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
    // C2 â€” identical. Record it; transfer nothing.
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

  // C3 â€” the content differs. The local side wins.
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
 * Group E â€” a local file the app has never tracked.
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
