/**
 * Atomic writes.
 *
 * A file written in one go is not safe to interrupt: `writeFile` truncates
 * the target before it writes, so a crash halfway through leaves a file
 * that is empty, or half a file. The manifest is the app's memory, and a
 * copy of it is the user's safety net - a safety net that is destroyed by
 * the act of refreshing it is no safety net at all.
 *
 * The pattern is the same wherever it is used: the contents are written to
 * a temporary file beside the target, flushed to the disk, and renamed
 * over the target. A rename within one volume is atomic, so the target is
 * either the old file or the new one - never a half-written one.
 *
 * The folder that holds the file must exist: the temporary file is
 * written beside the target, so that the rename stays within one volume.
 */

import { open, rename, rm } from 'node:fs/promises'

/**
 * Write `contents` to `path`, atomically.
 *
 * The old file is left alone until the new one is complete and on the
 * disk. If the write cannot be finished, the temporary file is removed
 * and the error is raised - and the old file is still there.
 */
export async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmpPath = `${path}.tmp`
  const handle = await open(tmpPath, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmpPath, path)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}
