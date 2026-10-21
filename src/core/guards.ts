/**
 * The safety guards.
 *
 * These are the checks that stand between a misread disk and a mass deletion
 * on Drive. They run before any mutating operation, and a tripped guard
 * skips the whole mirror rather than part of it.
 */

import { canon } from './paths'
import type { MirrorManifest, RetiredRecord } from './types'

/** A directory whose file count fell by more than half. */
export interface CountDropHit {
  /** Canonical path of the directory, `''` for the mirror root. */
  dir: string
  /** The count at the last successful sync. */
  last: number
  /** The count now. */
  current: number
}

/** Why a mirror was blocked. */
export interface GuardResult {
  blocked: boolean
  reason?: 'missing-root' | 'volume-changed' | 'count-drop'
  hits: CountDropHit[]
  message?: string
}

/**
 * Find the directories whose file count fell by more than half.
 *
 * The comparison set is the **union** of the directories in the baseline and
 * the directories on disk now. A directory that has been deleted outright is
 * absent from the current counts, and would be invisible if only the current
 * tree were walked — which is exactly the catastrophe this guard exists to
 * stop.
 *
 * The ratio test applies only to a directory that had at least `threshold`
 * files. Below the threshold, a ratio is noise: a three-file folder losing
 * one file is ordinary editing, and a guard that cries wolf gets overridden
 * until it stops meaning anything. A **complete wipe** always trips, however
 * small the directory was.
 */
export function checkCountDrop(
  lastCounts: Record<string, number>,
  currentCounts: Record<string, number>,
  threshold: number,
): CountDropHit[] {
  const hits: CountDropHit[] = []

  const dirs = new Set<string>([
    ...Object.keys(lastCounts),
    ...Object.keys(currentCounts),
  ])

  for (const dir of dirs) {
    const last = lastCounts[dir] ?? 0
    const current = currentCounts[dir] ?? 0

    // A directory with no baseline cannot have dropped.
    if (last === 0) continue

    // A complete wipe always trips.
    if (current === 0) {
      hits.push({ dir, last, current })
      continue
    }

    // Otherwise the ratio test applies, but only above the threshold.
    if (last >= threshold && current < last * 0.5) {
      hits.push({ dir, last, current })
    }
  }

  return hits
}

/**
 * True when the volume's fingerprint changed.
 *
 * On Windows, `fs.statSync(path).dev` is the volume serial number, so a
 * change in it means a different physical volume is now mounted at the same
 * letter. There is no baseline to compare against on the first run, so there
 * is no change to report.
 */
export function checkVolumeFingerprint(
  recorded: { dev: number } | undefined,
  current: { dev: number },
): boolean {
  if (!recorded) return false
  return recorded.dev !== current.dev
}

/**
 * Convert a mirror into its rebase state.
 *
 * A rebase happens when the volume behind a mirror changed. The manifest's
 * live entries describe the OLD volume, so they cannot be trusted against
 * the new one. Each becomes a `rebased` retired record: it keeps the file
 * id, the path, and the local content hash from before the change, which is
 * what lets the engine later tell "the same file came back" from "a
 * different file took its place" — and, crucially, from "the user deleted
 * this file and it was never synced".
 *
 * The mirror's own root and its already-retired records survive. A
 * `resynced` record left over from an earlier restore is replaced: it would
 * make the next run skip the path and download a file the user deleted.
 */
export function rebaseMirror(m: MirrorManifest, now: string): MirrorManifest {
  const retired: Record<string, RetiredRecord> = { ...m.retired }

  for (const [path, entry] of Object.entries(m.files)) {
    const record: RetiredRecord = {
      id: entry.driveFileId,
      path,
      state: 'rebased',
      at: now,
      md5: entry.driveMd5,
      driveMimeType: entry.driveMimeType,
      localPath: entry.localPath,
      prevLocalMd5: entry.localMd5,
    }
    retired[entry.driveFileId] = record
  }

  return {
    ...m,
    lastCounts: {},
    rebase: { pending: true, mergePolicy: 'drive-wins' },
    dirs: {},
    files: {},
    retired,
  }
}

/**
 * The canonical path of a directory, for reporting.
 */
export function reportDir(dir: string): string {
  return dir === '' ? '(mirror root)' : canon(dir)
}
