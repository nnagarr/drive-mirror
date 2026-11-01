/**
 * Canonical path keys and Windows filename legality.
 *
 * Every path in the manifest, the local tree, and the Drive tree is stored as
 * a canonical key so that the same file is recognised regardless of how it is
 * spelled. The local filesystem is case-insensitive while Drive is
 * case-sensitive, so keys are lowercased. Drive normalises to Unicode NFC, so
 * keys are NFC-normalised before comparison.
 *
 * This module performs no I/O and imports nothing.
 */

/**
 * Canonical key for a relative path: forward slashes, NFC, lowercase.
 *
 * `canon('Renders\\Final\\Scene.PSD')` === `'renders/final/scene.psd'`
 */
export function canon(p: string): string {
  return p.replace(/\\/g, '/').normalize('NFC').toLowerCase()
}

/** Device names Windows reserves regardless of extension. */
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * True when `name` is a Windows reserved device name (`CON`, `NUL`,
 * `COM1`…`COM9`, `LPT1`…`LPT9`), with or without an extension.
 */
export function isWindowsReservedName(name: string): boolean {
  return RESERVED_DEVICE_NAMES.test(name)
}

/** Characters Windows forbids in a filename. */
const ILLEGAL_FILENAME_CHARS = /[:*?"<>|]/

/**
 * True when a file with this name can exist on a Windows filesystem.
 *
 * False for names containing `: * ? " < > |`, names ending in a dot or a
 * space, and reserved device names. A Drive file whose name fails this test
 * can never be mirrored onto this computer and is treated as inert by the
 * sync engine.
 */
export function isRepresentableOnWindows(name: string): boolean {
  if (ILLEGAL_FILENAME_CHARS.test(name)) return false
  if (name.endsWith('.') || name.endsWith(' ')) return false
  if (isWindowsReservedName(name)) return false
  return true
}

/** The containing directory of a relative path, or `''` for a top-level path. */
export function parentPath(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i)
}

/** The final segment of a relative path. */
export function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/**
 * Join path segments and canonicalise the result.
 *
 * Empty segments are ignored so that `joinPath('a', '', 'b')` is `'a/b'`.
 */
export function joinPath(...segments: string[]): string {
  const parts = segments
    .map((s) => s.replace(/\\/g, '/'))
    .filter((s) => s.length > 0)
  return canon(parts.join('/'))
}

/**
 * Make a single path segment safe to write to disk.
 *
 * Illegal filename characters and control characters become `_`. Without
 * this, a `:` in a name would be interpreted as an NTFS alternate data
 * stream.
 */
export function sanitizePathSegment(seg: string): string {
  return seg
    .replace(/[:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '_')
}
