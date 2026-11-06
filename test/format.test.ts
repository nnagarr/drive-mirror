import { describe, expect, it } from 'vitest'
import {
  formatFriendlyDate,
  formatLastRunCounts,
  pluralize,
  relativeTime,
  countWith,
} from '../src/renderer/format'

describe('relativeTime', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')

  it('returns never for null', () => {
    expect(relativeTime(null)).toBe('never')
  })

  it('returns unknown for invalid iso', () => {
    expect(relativeTime('not-a-date')).toBe('unknown')
  })

  it('just now for under 45 seconds', () => {
    expect(relativeTime('2026-10-24T11:59:30Z', now)).toBe('just now')
  })

  it('a minute ago around 60 seconds', () => {
    expect(relativeTime('2026-10-24T11:59:00Z', now)).toBe('a minute ago')
  })

  it('minutes', () => {
    expect(relativeTime('2026-10-24T11:55:00Z', now)).toBe('5 minutes ago')
  })

  it('hours', () => {
    expect(relativeTime('2026-10-24T09:00:00Z', now)).toBe('3 hours ago')
  })

  it('days', () => {
    expect(relativeTime('2026-10-21T12:00:00Z', now)).toBe('3 days ago')
  })

  it('uses Date.now by default', () => {
    // Just ensure it does not throw and returns a string.
    expect(typeof relativeTime('2026-10-24T11:59:00Z')).toBe('string')
  })
})

describe('pluralize', () => {
  it('singular for one', () => {
    expect(pluralize(1, 'file')).toBe('file')
  })
  it('plural for zero and many', () => {
    expect(pluralize(0, 'file')).toBe('files')
    expect(pluralize(2, 'file')).toBe('files')
  })
  it('custom plural', () => {
    expect(pluralize(2, 'child', 'children')).toBe('children')
  })
})

describe('countWith', () => {
  it('formats count plus word', () => {
    expect(countWith(1, 'file')).toBe('1 file')
    expect(countWith(2, 'file')).toBe('2 files')
  })
})

describe('formatLastRunCounts', () => {
  it('shows Everything up to date when there are no changes and no errors', () => {
    expect(formatLastRunCounts({ uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 0 })).toBe('Everything up to date')
  })

  it('shows non-zero counts plus errors', () => {
    expect(formatLastRunCounts({ uploaded: 16, updated: 1, downloaded: 0, trashed: 0, errors: 0 })).toBe('16 uploaded · 1 updated · 0 errors')
  })

  it('shows only errors when there are errors and no file changes', () => {
    expect(formatLastRunCounts({ uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 1 })).toBe('1 error')
    expect(formatLastRunCounts({ uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 2 })).toBe('2 errors')
  })

  it('includes moved to trash when non-zero', () => {
    expect(formatLastRunCounts({ uploaded: 0, updated: 0, downloaded: 0, trashed: 2, errors: 1 })).toBe('2 moved to trash · 1 error')
  })
})

describe('formatFriendlyDate', () => {
  it('returns null for empty or null', () => {
    expect(formatFriendlyDate(null)).toBeNull()
    expect(formatFriendlyDate(undefined)).toBeNull()
    expect(formatFriendlyDate('')).toBeNull()
  })

  it('formats valid iso date', () => {
    const formatted = formatFriendlyDate('2026-11-02T03:00:00.000Z')
    expect(typeof formatted).toBe('string')
    expect(formatted).toContain('Nov')
    expect(formatted).toContain('2')
  })

  it('returns null for invalid date string', () => {
    expect(formatFriendlyDate('invalid')).toBeNull()
  })
})
