/**
 * Folders the user deleted locally.
 *
 * The diff engine works on file paths only: a deleted local file is trashed
 * on Drive by the ordinary rules. A deleted local FOLDER is not a file
 * path, so nothing in the engine speaks for it, and its Drive folder would
 * sit there empty forever after its files have been trashed.
 *
 * This planner decides which Drive folders the mirror should trash because
 * the directory behind them is gone from the disk. It is pure: it sees
 * only what the scan and the Drive tree already know.
 */

import type { LocalEntry, LocalTree } from './types'

/** One Drive folder the mirror should move to the trash. */
export interface FolderTrash {
  /** The mirror-relative path of the folder. */
  relPath: string
  /** The Drive folder's id. */
  driveFolderId: string
}

/**
 * Plan the trashes for Drive folders whose local directory is gone.
 *
 * A folder is planned when:
 *
 * - the Drive tree holds it and the manifest knew its id, and
 * - the directory does not exist on disk now, and
 * - nothing under it could be misread: a directory that could not be
 *   read — anywhere in the subtree — makes the absence of this one
 *   untrustworthy, so the folder stays, and
 * - no local file beneath it is present. A present file under a gone
 *   directory is a contradiction; when one turns up the folder stays.
 *
 * The trashes come back deepest first. Moving a parent folder to the
 * trash on Drive takes everything under it with it, so children are
 * named before their parents and the parent is only trashed for its own
 * sake. A child whose id is already inside a trashed parent is harmless:
 * setting `trashed` on a trashed item does nothing.
 */
export function planDeletedFolders(
  driveDirs: Map<string, string>,
  local: Pick<LocalTree, 'dirs' | 'files' | 'unreadableDirs'>,
): FolderTrash[] {
  const trashes: FolderTrash[] = []

  for (const [dir, id] of driveDirs) {
    if (local.dirs.has(dir)) continue

    // Anything unreadable in or under this directory means the scan
    // cannot vouch for what is really there. Absence is not proof.
    const unreadableHere = local.unreadableDirs.has(dir)
    const unreadableBelow = [...local.unreadableDirs.keys()].some((u) =>
      u.startsWith(`${dir}/`),
    )
    if (unreadableHere || unreadableBelow) continue

    // A present file beneath a gone directory is a contradiction. When
    // one turns up, the folder is not really gone.
    const stillHasFile = [...local.files.entries()].some(
      ([path, entry]: [string, LocalEntry]) =>
        entry.state === 'present' && path.startsWith(`${dir}/`),
    )
    if (stillHasFile) continue

    trashes.push({ relPath: dir, driveFolderId: id })
  }

  // Deepest first, so a child is always named before its parent.
  const depth = (path: string): number => path.split('/').length
  return trashes.sort((a, b) => depth(b.relPath) - depth(a.relPath))
}
