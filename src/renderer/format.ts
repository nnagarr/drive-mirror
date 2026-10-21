/**
 * A small helper for showing a time the way a person would say it.
 */

/**
 * How long ago something happened, in words.
 *
 * A null time means it has never happened, which is worth saying plainly
 * rather than showing a dash the user has to interpret.
 */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'unknown'

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
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
