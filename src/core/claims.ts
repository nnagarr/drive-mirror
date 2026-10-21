/**
 * The claim index and the native export-path planner.
 *
 * A local file is not automatically a candidate for upload. A local path is
 * *claimed* when it is already the local representation of something the app
 * tracks — most importantly the export of a Google-native Drive file. Without
 * the claim index, every Google-native file would produce a duplicate binary
 * copy on Drive on every run, and the export would be uploaded over the
 * user's own file if their name happened to match.
 */

import { canon } from './paths'
import { exportInfoFor, isGoogleNativeMime } from './googleMime'
import type { DriveTree, LocalTree, MirrorManifest } from './types'

/**
 * Which manifest keys claim which local paths.
 *
 * `claimedBy` maps a canonical local path to the set of manifest keys that
 * own it. `retiredClaims` holds the export paths of native files the app has
 * retired: they are derived artifacts, never user content, so they are never
 * uploaded.
 */
export interface ClaimIndex {
  claimedBy: Map<string, Set<string>>
  retiredClaims: Set<string>
}

/**
 * Plan the local export path for every Google-native Drive file.
 *
 * The plan is keyed by Drive file id and computed in canonical path order so
 * the result is deterministic regardless of the order the listing arrived in.
 *
 * A candidate path is *taken* when it collides with another Drive file, with
 * another manifest entry's local path, with an export path planned for another
 * native file, or with a file present on disk. The last of those is what
 * stops the export from overwriting a file the user happens to have named
 * `Budget.csv`.
 */
export function planExportPaths(
  drive: DriveTree,
  manifest: MirrorManifest,
  local: LocalTree,
): Map<string, string> {
  /** Drive file id -> canonical path, for native files only. */
  const nativeById = new Map<string, string>()

  for (const [path, entries] of drive.files) {
    for (const entry of entries) {
      if (!isGoogleNativeMime(entry.mimeType)) continue
      if (!exportInfoFor(entry.mimeType)) continue
      nativeById.set(entry.id, path)
    }
  }

  const plan = new Map<string, string>()
  const plannedPaths = new Set<string>()

  // Paths already spoken for, by anything other than the file being planned.
  const drivePaths = new Set<string>(drive.files.keys())
  const manifestLocalPaths = new Set<string>(
    Object.values(manifest.files).map((entry) => canon(entry.localPath)),
  )
  const retiredLocalPaths = new Set<string>(
    Object.values(manifest.retired)
      .map((record) => record.localPath)
      .filter((p): p is string => typeof p === 'string')
      .map((p) => canon(p)),
  )

  // The manifest entry that already tracks a given Drive file id, if any.
  const trackedById = new Map<string, { key: string; localPath: string }>()
  for (const [key, entry] of Object.entries(manifest.files)) {
    trackedById.set(entry.driveFileId, { key, localPath: canon(entry.localPath) })
  }

  const ordered = [...nativeById.entries()].sort((a, b) =>
    a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  )

  for (const [driveFileId, path] of ordered) {
    const entry = drive.files.get(path)?.find((f) => f.id === driveFileId)
    if (!entry) continue
    const info = exportInfoFor(entry.mimeType)
    if (!info) continue

    const tracked = trackedById.get(driveFileId)

    // The path this file already owns, if the manifest tracks it.
    if (tracked) {
      plan.set(driveFileId, tracked.localPath)
      plannedPaths.add(tracked.localPath)
      continue
    }

    let chosen: string | undefined
    for (let n = 0; n < 1000; n += 1) {
      // The export path is the Drive path's own name with the export
      // extension appended, plus a folder when there is a parent:
      //   'budget'        -> 'budget.csv'
      //   'docs/budget'   -> 'docs/budget.csv'
      //   'budget' (taken)-> 'budget (export 1).csv'
      // The path is already canonical, so the derived name is canonical too.
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
      const stem = n === 0 ? base : `${base} (export ${n})`
      const withExt = `${stem}${info.ext}`
      const candidate = parent === '' ? withExt : `${parent}/${withExt}`

      if (
        drivePaths.has(candidate) ||
        manifestLocalPaths.has(candidate) ||
        plannedPaths.has(candidate) ||
        retiredLocalPaths.has(candidate) ||
        local.files.has(candidate)
      ) {
        continue
      }
      chosen = candidate
      break
    }

    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path
    const finalPath = chosen ?? (parent === '' ? `${base}${info.ext}` : `${parent}/${base}${info.ext}`)
    plan.set(driveFileId, finalPath)
    plannedPaths.add(finalPath)
  }

  return plan
}

/**
 * Build the claim index from the manifest and the export plan.
 *
 * `drive` resolves a planned export back to the native file's own canonical
 * Drive path, which is the key that owns the export. A first-sight native
 * file is not in the manifest yet, so the Drive tree is the only place its
 * key can come from.
 */
export function buildClaimIndex(
  manifest: MirrorManifest,
  plan: Map<string, string>,
  drive?: DriveTree,
): ClaimIndex {
  const claimedBy = new Map<string, Set<string>>()
  const retiredClaims = new Set<string>()

  const claim = (localPath: string, key: string): void => {
    const path = canon(localPath)
    const bucket = claimedBy.get(path)
    if (bucket) bucket.add(key)
    else claimedBy.set(path, new Set([key]))
  }

  for (const [key, entry] of Object.entries(manifest.files)) {
    // An entry whose local path is its own key is an ordinary mirror of that
    // path; it does not "claim" the path from itself, or the engine would
    // skip every file it tracks. Only an entry whose local representation
    // lives elsewhere — a Google-native export — claims a foreign path.
    if (canon(entry.localPath) === canon(key)) continue
    claim(entry.localPath, key)
  }

  // Drive file id -> its canonical Drive path, for the planned exports.
  const pathById = new Map<string, string>()
  if (drive) {
    for (const [path, entries] of drive.files) {
      for (const entry of entries) pathById.set(entry.id, path)
    }
  }

  for (const [driveFileId, localPath] of plan) {
    const key = pathById.get(driveFileId) ?? driveFileId
    claim(localPath, key)
  }

  for (const record of Object.values(manifest.retired)) {
    if (typeof record.localPath === 'string' && record.localPath.length > 0) {
      retiredClaims.add(canon(record.localPath))
    }
  }

  return { claimedBy, retiredClaims }
}
