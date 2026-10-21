/**
 * Assemble a Drive listing into a tree, and build the listing queries.
 *
 * The query builder lives here because the `trashed = false` filter is the
 * single most consequential line in the application. The Drive API's
 * `files.list` returns trashed files by default — its own reference says so
 * — so an unfiltered listing would bring every file the app has ever trashed
 * back into the mirror, where the engine would either re-trash it or
 * re-download it. The user's deletions would be undone in bulk.
 */

import { canon, isRepresentableOnWindows } from './paths'
import type { DriveFile, DriveNode, DriveTree } from './types'

/** The Drive mime type for a folder. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Prefix shared by every Google-native (Workspace) file type. */
const NATIVE_PREFIX = 'application/vnd.google-apps.'

/**
 * True for a Google-native file (Docs, Sheets, Slides, Drawings, …).
 *
 * Native files cannot be downloaded with `alt=media`; they must be exported.
 *
 * A folder is excluded even though its mime type shares the
 * `application/vnd.google-apps.` prefix: a folder is not an exportable
 * document, and the only consumer of this predicate is the export planner.
 */
export function isGoogleNativeMime(mimeType: string): boolean {
  if (mimeType === FOLDER_MIME) return false
  return mimeType.startsWith(NATIVE_PREFIX)
}

/**
 * Build the `q` parameter for a Drive listing.
 *
 * The `trashed = false` filter is always present, and the OR clause over
 * parent ids is always parenthesised: Drive evaluates clauses left to right
 * unless they are grouped, so `trashed = false and 'a' in parents or 'b' in
 * parents` would apply the filter to the first clause only.
 *
 * @throws if `parentIds` is empty — an unfiltered whole-drive listing is
 * never acceptable.
 */
export function buildListQuery(parentIds: string[]): string {
  if (parentIds.length === 0) {
    throw new Error('buildListQuery requires at least one parent id')
  }
  const clause = parentIds.map((id) => `'${id}' in parents`).join(' or ')
  return `trashed = false and (${clause})`
}

/**
 * Assemble listed Drive nodes into a tree.
 *
 * A path may hold more than one Drive file — Drive permits exact duplicate
 * names, and `A.psd` and `a.psd` collide under our case-insensitive
 * canonical key. Every colliding entry is flagged `ambiguous`, and the sync
 * engine skips such a path entirely: picking a winner arbitrarily could
 * trash the wrong file.
 */
export function buildDriveTree(nodes: DriveNode[]): DriveTree {
  const files = new Map<string, DriveFile[]>()
  const dirs = new Map<string, string>()
  const dirById = new Map<string, string>()

  for (const node of nodes) {
    const { entry, parentPath } = node
    const canonicalPath =
      parentPath === '' ? canon(entry.name) : `${parentPath}/${canon(entry.name)}`

    if (entry.mimeType === FOLDER_MIME) {
      dirs.set(canonicalPath, entry.id)
      dirById.set(entry.id, canonicalPath)
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
      unrepresentable: !isRepresentableOnWindows(entry.name),
    }

    const bucket = files.get(canonicalPath)
    if (bucket) bucket.push(file)
    else files.set(canonicalPath, [file])
  }

  // A key with more than one file is ambiguous; every member is flagged.
  for (const entries of files.values()) {
    if (entries.length > 1) {
      for (const entry of entries) entry.ambiguous = true
    }
  }

  return { files, dirs, dirById }
}
