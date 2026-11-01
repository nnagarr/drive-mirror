/**
 * Google-native (Workspace) file types and their export formats.
 *
 * A Google-native file cannot be downloaded with `alt=media`; it must be
 * exported. Only the types listed here have a defined export. A native type
 * with no export (forms, scripts, sites) is left completely alone on Drive
 * and reported to the user.
 */

/** The Drive mime type for a folder. */
export const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Prefix shared by every Google-native (Workspace) file type. */
const NATIVE_PREFIX = 'application/vnd.google-apps.'

/** How a Google-native file is exported. */
export interface NativeExport {
  /** The mime type to request from the export endpoint. */
  exportMime: string
  /** The file extension the export is written with. */
  ext: string
}

/** The native types that have a defined export. */
export const NATIVE_EXPORT_MAP: Record<string, NativeExport> = {
  'application/vnd.google-apps.document': { exportMime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': { exportMime: 'text/csv', ext: '.csv' },
  'application/vnd.google-apps.presentation': { exportMime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.drawing': { exportMime: 'image/png', ext: '.png' },
}

/**
 * True for a Google-native file (Docs, Sheets, Slides, Drawings, …).
 *
 * A folder is excluded even though its mime type shares the
 * `application/vnd.google-apps.` prefix: a folder is not an exportable
 * document, and the only consumer of this predicate is the export planner.
 */
export function isGoogleNativeMime(mimeType: string): boolean {
  if (mimeType === FOLDER_MIME) return false
  return mimeType.startsWith(NATIVE_PREFIX)
}

/** The export format for a native mime type, or null when it has none. */
export function exportInfoFor(mimeType: string): NativeExport | null {
  return NATIVE_EXPORT_MAP[mimeType] ?? null
}
