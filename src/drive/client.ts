/**
 * The Drive operations the app needs.
 *
 * This file holds the interface only. The implementation lives in the main
 * process and talks to the Drive REST API; the sync engine and its tests
 * depend on the shape, never on the network.
 *
 * There is deliberately no delete operation. The app's promise to the user
 * is that it never permanently removes anything from Drive: a local delete
 * becomes a Drive trash, and Drive's own trash purges it after thirty days.
 * A missing method is a stronger promise than a method nobody calls.
 */

import type { Readable } from 'node:stream'
import type { DriveNode } from '../core/types'

export interface DriveClient {
  /** The children of a Drive folder. */
  listChildren(folderId: string): Promise<DriveNode[]>

  /** One Drive file, or null when it does not exist. */
  getFile(fileId: string): Promise<DriveNode | null>

  /** Create a folder and return its id. */
  createFolder(name: string, parentId: string): Promise<{ id: string }>

  /** Create a file and return its id. */
  createFile(
    name: string,
    parentId: string,
    body: Readable,
    opts: { md5: string; size: number; mimeType?: string },
  ): Promise<{ id: string }>

  /** Replace the content of an existing Drive file, keeping its id. */
  updateContent(
    fileId: string,
    body: Readable,
    opts: { md5: string; size: number },
  ): Promise<void>

  /** Write the content of a Drive file to a local path. */
  downloadTo(fileId: string, destPath: string): Promise<void>

  /** Write an export of a Google-native Drive file to a local path. */
  exportTo(fileId: string, destPath: string, mimeType: string): Promise<void>

  /** Move a Drive file to the Drive trash. */
  trash(fileId: string): Promise<void>

  /** Restore a Drive file from the Drive trash. */
  untrash(fileId: string): Promise<void>
}
