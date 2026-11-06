/**
 * A small helper for showing a time the way a person would say it.
 */

/**
 * How long ago something happened, in words.
 *
 * A null time means it has never happened, which is worth saying plainly
 * rather than showing a dash the user has to interpret.
 */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'unknown'

  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 90) return 'a minute ago'

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`

  return new Date(then).toLocaleDateString()
}

/** A whole number, with a thousands separator. */
export function count(value: number): string {
  return value.toLocaleString()
}

/** Singular or plural word for a count, e.g. "1 file" / "2 files". */
export function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? singular + 's')
}

/** A count plus its word, e.g. "1 file" / "2 files". */
export function countWith(n: number, singular: string, plural?: string): string {
  return `${n} ${pluralize(n, singular, plural)}`
}

/** Format a run's counts for the Last run strip: non-zero counts plus errors. */
export interface RunCounts {
  uploaded: number
  updated: number
  downloaded: number
  trashed: number
  errors: number
}

export function formatLastRunCounts(c: RunCounts): string {
  const hasChanges = c.uploaded > 0 || c.updated > 0 || c.downloaded > 0 || c.trashed > 0
  if (!hasChanges && c.errors === 0) {
    return 'Everything up to date'
  }

  const parts: string[] = []
  if (c.uploaded > 0) parts.push(`${c.uploaded} uploaded`)
  if (c.updated > 0) parts.push(`${c.updated} updated`)
  if (c.downloaded > 0) parts.push(`${c.downloaded} downloaded`)
  if (c.trashed > 0) parts.push(`${c.trashed} moved to trash`)
  if (hasChanges || c.errors > 0) {
    parts.push(`${c.errors} ${pluralize(c.errors, 'error')}`)
  }
  return parts.join(' · ')
}

/** What a run did, as far as the summary bar cares. */
export interface RunOutcome {
  uploaded: number
  updated: number
  downloaded: number
  trashed: number
  errors: number
  reports: readonly unknown[]
}

/**
 * Whether a run has nothing to report.
 *
 * A run that changed nothing is quiet. A run that had something to say -
 * even when it changed nothing - is not: it skipped a folder, or it did
 * not run at all because another sync was going, and the user needs to
 * know that rather than being told everything is up to date.
 */
export function summaryIsQuiet(summary: RunOutcome): boolean {
  return (
    summary.uploaded === 0 &&
    summary.updated === 0 &&
    summary.downloaded === 0 &&
    summary.trashed === 0 &&
    summary.errors === 0 &&
    summary.reports.length === 0
  )
}

/**
 * Format an ISO date string into a friendly localized human-readable date.
 * Returns null if the input is null, undefined, empty, or unparseable.
 */
export function formatFriendlyDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return null
  }
}
