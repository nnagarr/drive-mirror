import type { DriveClient } from '../drive/client'
import { FOLDER_MIME } from './googleMime'

/**
 * Where a mirror lives on Drive.
 *
 * A destination is a path under My Drive, such as `Archive/2026/Photos`.
 * The last segment is the mirror's own folder; the ones before it are the
 * folders it sits inside.
 */

/** The parts of a destination path. */
export function splitDrivePath(drivePath: string): string[] {
  return drivePath.split('/').filter((segment) => segment.length > 0)
}

/** The name of the folder a destination path ends in. */
export function driveFolderNameOf(drivePath: string): string {
  const segments = splitDrivePath(drivePath)
  return segments[segments.length - 1] ?? ''
}

/** A destination that was found or made. */
export interface ResolvedDestination {
  /** The id of the mirror's folder on Drive. */
  id: string
  /** The name that folder actually has. */
  name: string
  /** The names of the folders that had to be created, in the order they were made. */
  created: string[]
}

/**
 * Find the folder a mirror lives in, making it if it is not there.
 *
 * **The stored id wins.** When the manifest already knows the folder's id,
 * that folder is used whatever its name is now: the user may have renamed
 * it in the Drive browser, and honouring that is much kinder than making a
 * second folder and uploading everything again. Only when the stored id is
 * gone does the path get walked.
 *
 * The walk visits each segment in turn. A segment that matches more than
 * one folder, or that matches a **file** rather than a folder, is reported
 * as ambiguous rather than guessed at - the app must not clobber anything.
 */
export async function resolveMirrorPath(
  client: DriveClient,
  drivePath: string,
  myDriveId: string,
  storedId?: string,
): Promise<ResolvedDestination | { ambiguous: true; segment: string }> {
  if (storedId) {
    const node = await client.getFile(storedId)
    if (node && !node.entry.trashed) {
      return { id: storedId, name: node.entry.name, created: [] }
    }
  }

  const segments = splitDrivePath(drivePath)
  if (segments.length === 0) {
    return { ambiguous: true, segment: drivePath }
  }

  const created: string[] = []
  let parentId = myDriveId

  for (const segment of segments) {
    const children = await client.listChildren(parentId)
    const wanted = segment.toLowerCase()

    const folders = children.filter(
      (node) =>
        node.entry.mimeType === FOLDER_MIME &&
        node.entry.name.toLowerCase() === wanted,
    )
    if (folders.length > 1) {
      return { ambiguous: true, segment }
    }
    if (folders.length === 1) {
      parentId = folders[0]!.entry.id
      continue
    }

    // A file sitting where a folder has to go. The app must not replace
    // it, so this is reported rather than resolved.
    const file = children.find(
      (node) =>
        node.entry.mimeType !== FOLDER_MIME &&
        node.entry.name.toLowerCase() === wanted,
    )
    if (file) {
      return { ambiguous: true, segment }
    }

    const made = await client.createFolder(segment, parentId)
    created.push(segment)
    parentId = made.id
  }

  return { id: parentId, name: segments[segments.length - 1]!, created }
}
