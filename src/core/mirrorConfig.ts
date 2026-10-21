/**
 * The rules for which folders may be mirrored.
 *
 * A mirror is a folder on this machine and a folder under My Drive. This
 * module holds the shape of that pair and every rule about it, so the rules
 * can be tested without a screen, a disk or a network.
 *
 * The rules exist because a mirror is not a private affair. The name is the
 * key the manifest knows the mirror by, so two mirrors cannot share one -
 * not even with the names differing only by case. And a mirror cannot sit
 * inside another mirror's folder, nor contain one: a file would then be
 * synced twice, once through each mirror, and the two histories would
 * disagree about it.
 *
 * The module is pure. It imports nothing from Electron and nothing from
 * Node; it only knows the manifest's shape.
 */

import type { Manifest } from './types'

/** One of the trees the user mirrors. */
export interface MirrorConfig {
  /** The name of the tree. It is the key the manifest knows it by. */
  name: string
  /** The folder on this machine. */
  root: string
  /** Where it lives under My Drive. */
  drivePath: string
  /** Whether the app syncs it. */
  enabled: boolean
  /** ISO timestamp. Set when the mirror is removed. */
  removedAt?: string
}

/** One thing that is wrong with a candidate mirror. */
export interface MirrorProblem {
  /** The field the problem is about. */
  field: 'name' | 'root' | 'drivePath'
  /** The message shown to the user. */
  message: string
}

/** Characters Windows forbids in a folder name. */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/

/** Characters Windows forbids in a path segment, the separator apart. */
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*]/

/** Control characters, which Windows forbids in a name. */
const CONTROL_CHARS = /[\u0000-\u001f]/

/** A root is a drive letter, a colon and a separator. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/

/** A root is a UNC share: `\\server\share`. */
const UNC_ROOT = /^\\\\/

/**
 * True when `name` can be used as the name of a mirror.
 *
 * The name is the key the manifest knows the mirror by, so it has to be a
 * name Windows can hold: not empty, not `.` or `..`, without the
 * characters Windows forbids in a folder name, and not ending in a space
 * or a dot - Windows strips both, so the folder on disk would not carry
 * the name the manifest knows it by.
 */
export function isValidMirrorName(name: string): boolean {
  if (name.length === 0) return false
  if (name === '.' || name === '..') return false
  if (ILLEGAL_NAME_CHARS.test(name)) return false
  if (CONTROL_CHARS.test(name)) return false
  if (name.endsWith(' ') || name.endsWith('.')) return false
  return true
}

/**
 * True when `drivePath` is a folder path under My Drive.
 *
 * The path is relative to My Drive and its segments are separated by `/`.
 * Every segment must be a name Drive can hold, so no segment is empty, no
 * segment is `.` or `..`, and no segment carries a character Windows
 * forbids - a Drive folder the app could not create on this machine would
 * be a folder the user could not open either.
 */
export function isValidDrivePath(drivePath: string): boolean {
  if (drivePath.length === 0) return false
  for (const segment of drivePath.split('/')) {
    if (segment.length === 0) return false
    if (segment === '.' || segment === '..') return false
    if (segment.includes('\\')) return false
    if (ILLEGAL_SEGMENT_CHARS.test(segment)) return false
    if (CONTROL_CHARS.test(segment)) return false
  }
  return true
}

/**
 * True when two roots are the same folder or one of them holds the other.
 *
 * A file inside both would be synced twice, so the two may never be two
 * mirrors. The roots are compared the way Windows compares them: the
 * separator is a slash either way and the letters do not matter.
 */
export function overlaps(rootA: string, rootB: string): boolean {
  const a = normaliseRoot(rootA)
  const b = normaliseRoot(rootB)
  if (a === b) return true
  return a.startsWith(b + '/') || b.startsWith(a + '/')
}

/**
 * The problems with a candidate mirror. An empty list means it is good.
 *
 * The candidate is checked on its own - a name that cannot be a folder
 * name, a root that is not a folder on this machine, a Drive path that is
 * not a path - and against the mirrors that exist already: the name must
 * be free, and the root must not overlap a root that is already mirrored.
 * A candidate that breaks two rules gets both problems, so the user is
 * told everything at once.
 *
 * A mirror the user removed keeps its name and its folder. The same name
 * on the same folder puts it back and re-adopts the history the manifest
 * still holds; the same name on another folder would inherit that history
 * and read every old path as absent, so it is refused; and no other mirror
 * may take the folder while it is reserved, or the mirror the user
 * removed and the one they added would both be live on it.
 */
export function validateMirror(
  candidate: { name: string; root: string; drivePath: string },
  existing: MirrorConfig[],
): MirrorProblem[] {
  const problems: MirrorProblem[] = []

  if (!isValidMirrorName(candidate.name)) {
    problems.push({ field: 'name', message: 'That name cannot be used as a folder name.' })
  }
  if (!isUsableRoot(candidate.root)) {
    problems.push({ field: 'root', message: 'That is not a folder on this computer.' })
  }
  if (!isValidDrivePath(candidate.drivePath)) {
    problems.push({ field: 'drivePath', message: 'That is not a folder path.' })
  }

  for (const other of existing) {
    const sameName = other.name.toLowerCase() === candidate.name.toLowerCase()
    const sameRoot = normaliseRoot(other.root) === normaliseRoot(candidate.root)

    if (other.removedAt) {
      // The mirror is gone, but its name and its folder are still its own
      // until it is forgotten.
      if (sameName) {
        if (!sameRoot) {
          problems.push({
            field: 'root',
            message: `The removed mirror ${other.name} has the root ${other.root}, so it cannot be added with the root ${candidate.root}.`,
          })
        }
      } else if (overlaps(candidate.root, other.root)) {
        problems.push({ field: 'root', message: overlapMessage(candidate.root, other) })
      }
      continue
    }

    if (sameName) {
      problems.push({
        field: 'name',
        message: `There is already a mirror called ${other.name}.`,
      })
      continue
    }

    if (overlaps(candidate.root, other.root)) {
      problems.push({ field: 'root', message: overlapMessage(candidate.root, other) })
    }
  }

  return problems
}

/**
 * The Drive path to offer for a mirror with this name.
 *
 * The name is the suggestion, and a name that carries a character a Drive
 * folder cannot hold cannot be part of a Drive path either, so those
 * characters become `-` - the same characters the checks above reject.
 * The result is a path `isValidDrivePath` accepts.
 */
export function suggestDrivePath(name: string): string {
  return name
    .split('/')
    .map((segment) => segment.replace(/[<>:"\\|?*]/g, '-').replace(/[\u0000-\u001f]/g, '-').trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/')
}

/**
 * The mirrors the manifest already knows, as configurations.
 *
 * The manifest is the record of what the app has synced, so it holds the
 * names and the roots of the mirrors the user has set up. The list the app
 * works from is configuration and lives in the settings; this turns the
 * history back into a starting point for it, and a mirror the manifest
 * has no root for is not one the app can work with.
 */
export function mirrorConfigsFromManifest(manifest: Manifest): MirrorConfig[] {
  const configs: MirrorConfig[] = []
  for (const [name, mirror] of Object.entries(manifest.mirrors)) {
    if (!mirror.root) continue
    configs.push({
      name,
      root: mirror.root,
      drivePath: mirror.driveFolderName ?? name,
      enabled: true,
    })
  }
  return configs
}

/** A root in a form two roots can be compared in. */
function normaliseRoot(root: string): string {
  const forward = root.replace(/\\/g, '/')
  const trimmed = forward.length > 1 && forward.endsWith('/') ? forward.slice(0, -1) : forward
  return trimmed.toLowerCase()
}

/** True when the root is a folder on this machine. */
function isUsableRoot(root: string): boolean {
  if (root.trim().length === 0) return false
  const isDrive = DRIVE_ROOT.test(root)
  if (!isDrive && !UNC_ROOT.test(root)) return false
  // The drive letter carries the one colon a path may have; the rest of
  // the path may not carry a character Windows forbids.
  const rest = isDrive ? root.slice(2) : root
  if (ILLEGAL_SEGMENT_CHARS.test(rest)) return false
  if (CONTROL_CHARS.test(rest)) return false
  return true
}

/** Why the candidate's root cannot be mirrored beside this mirror. */
function overlapMessage(candidateRoot: string, other: MirrorConfig): string {
  const candidate = normaliseRoot(candidateRoot)
  const existing = normaliseRoot(other.root)
  if (other.removedAt) {
    // The mirror is gone, but its folder is reserved until it is
    // forgotten, and the user has to be told it is gone.
    if (candidate === existing) {
      return `The folder ${candidateRoot} belongs to the removed mirror ${other.name}, and stays reserved until that mirror is forgotten.`
    }
    if (existing.startsWith(candidate + '/')) {
      return `The folder of the removed mirror ${other.name} (${other.root}) is inside ${candidateRoot}, and stays reserved until that mirror is forgotten.`
    }
    return `${candidateRoot} is inside the folder of the removed mirror ${other.name} (${other.root}), which stays reserved until that mirror is forgotten.`
  }
  if (candidate === existing) {
    return `The folder ${candidateRoot} is already mirrored as ${other.name}.`
  }
  if (existing.startsWith(candidate + '/')) {
    return `The mirror ${other.name} (${other.root}) is inside ${candidateRoot}, so it would be synced twice.`
  }
  return `${candidateRoot} is inside the mirror ${other.name} (${other.root}), so it would be synced twice.`
}
