/**
 * Scan a local mirror root into a three-state local tree.
 *
 * The third state — `unknown` — is the point of this module. A path that
 * could not be read (access denied, path too long, a junction in the way) is
 * NOT the same as a path that is gone. The sync engine trashes a Drive copy
 * when the local path reads as `absent`, so collapsing "I could not read it"
 * into "it is gone" would destroy Drive copies of files that still exist.
 *
 * No md5 is computed here; the diff engine hashes lazily through an injected
 * port so that a 1.93 GB tree is not re-hashed on every run.
 */

import { readdir, lstat, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { canon } from './paths'
import type { LocalEntry, LocalTree } from './types'

export interface ScanOptions {
  /** Absolute path of the mirror root. */
  root: string
  /** Canonical relative paths the manifest already knows about. */
  knownPaths: string[]
}

/** Errors that mean "we could not read this", not "this does not exist". */
function isUnreadableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ELOOP' ||
    code === 'ENAMETOOLONG' ||
    code === 'EMFILE' ||
    code === 'ENFILE' ||
    code === 'EIO' ||
    code === 'EBUSY' ||
    code === 'UNKNOWN'
  )
}

/** True when `child` is inside `parent` (or equal to it). */
function isUnder(child: string, parent: string): boolean {
  if (parent === '') return true
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Walk `root` and return the local tree.
 *
 * `knownPaths` are the paths the manifest already tracks. Any known path that
 * is not on disk — or that lies under a directory that could not be read — is
 * recorded so the diff can see it. A known path under an unreadable
 * directory is recorded as `unknown`, never as `absent`.
 */
export async function scanLocal(opts: ScanOptions): Promise<LocalTree> {
  const files = new Map<string, LocalEntry>()
  const dirs = new Set<string>()
  const unreadableDirs = new Map<string, string>()
  const recursiveCounts: Record<string, number> = {}

  /** Directories that could not be read, in canonical form. */
  const blockedDirs: string[] = []

  const knownPaths = opts.knownPaths.map((p) => canon(p))

  function addCount(dir: string): void {
    // A file in `dir` counts towards `dir`, every strict ancestor of `dir`,
    // and the root. The strict ancestors of `dir` are its own path prefixes
    // excluding `dir` itself, which is counted first. The root is counted
    // only once, whether `dir` is the root or a descendant of it.
    recursiveCounts[dir] = (recursiveCounts[dir] ?? 0) + 1
    const parts = dir.split('/').filter((p) => p.length > 0)
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      const ancestor = parts.slice(0, i + 1).join('/')
      recursiveCounts[ancestor] = (recursiveCounts[ancestor] ?? 0) + 1
    }
    if (dir !== '') {
      recursiveCounts[''] = (recursiveCounts[''] ?? 0) + 1
    }
  }

  async function walk(absDir: string, relDir: string): Promise<void> {
    dirs.add(relDir)

    let entries: Dirent[]
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch (err) {
      // The directory itself could not be read. Everything beneath it is
      // unknown, never absent.
      const reason = err instanceof Error ? err.message : String(err)
      unreadableDirs.set(relDir, reason)
      blockedDirs.push(relDir)
      return
    }

    for (const entry of entries) {
      const abs = join(absDir, entry.name)
      const rel = relDir === '' ? canon(entry.name) : `${relDir}/${canon(entry.name)}`

      // A symlink or junction is never followed. Following one can walk out
      // of the mirror entirely, or into a cycle.
      let isLink = entry.isSymbolicLink()
      if (!isLink && !entry.isDirectory() && !entry.isFile()) {
        // Dirent type is unknown on some filesystems; confirm with lstat.
        try {
          isLink = (await lstat(abs)).isSymbolicLink()
        } catch {
          isLink = false
        }
      }
      if (isLink) continue

      if (entry.isDirectory()) {
        await walk(abs, rel)
        continue
      }

      let size: number | undefined
      let mtimeMs: number | undefined
      try {
        const st = await stat(abs)
        size = st.size
        mtimeMs = st.mtimeMs
        files.set(rel, { state: 'present', size, mtimeMs })
        addCount(relDir)
      } catch (err) {
        // The file exists in the directory listing but cannot be read. It is
        // unknown, not absent: the Drive copy must not be trashed.
        files.set(rel, { state: 'unknown' })
        if (isUnreadableError(err)) {
          unreadableDirs.set(relDir, err instanceof Error ? err.message : String(err))
        }
      }
    }
  }

  try {
    await walk(opts.root, '')
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    unreadableDirs.set('', reason)
  }

  // Known paths the scan did not reach: absent, unless they sit under a
  // directory that could not be read, in which case they are unknown.
  //
  // A missing *root* is a special case: the whole mirror could not be
  // walked, so every known path is unknown, never absent. Marking them
  // absent would tell the engine the files were deleted and trash their
  // Drive copies. The runner's Guard 1 skips a missing root anyway, but the
  // scanner must not be the thing that decides to delete data.
  for (const known of knownPaths) {
    if (files.has(known)) continue
    const blocked = blockedDirs.some((d) => isUnder(known, d))
    if (blocked) {
      files.set(known, { state: 'unknown' })
    } else {
      files.set(known, { state: 'absent' })
    }
  }

  return { files, dirs, unreadableDirs, recursiveCounts }
}
