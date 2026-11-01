import { describe, it, expect } from 'vitest'
import { buildListQuery } from '../src/core/driveTree'

describe('buildListQuery', () => {
  it('always filters trashed files', () => {
    // The Drive API returns trashed files by default. Without this filter
    // every file the app has ever trashed would reappear in the mirror.
    expect(buildListQuery(['abc'])).toBe("trashed = false and ('abc' in parents)")
  })

  it('parenthesises a multi-parent OR clause', () => {
    // Drive evaluates clauses left to right unless grouped, so an
    // unparenthesised OR would apply the filter to only the last clause.
    const q = buildListQuery(['abc', 'def'])
    expect(q.startsWith('trashed = false and (')).toBe(true)
    expect(q.endsWith(')')).toBe(true)
    expect(q).toContain("'abc' in parents or 'def' in parents")
  })

  it('keeps the filter outside the parentheses', () => {
    const q = buildListQuery(['a', 'b', 'c'])
    const parenStart = q.indexOf('(')
    const filterEnd = q.indexOf('and')
    expect(filterEnd).toBeLessThan(parenStart)
  })

  it('rejects an empty parent list', () => {
    // An unfiltered whole-drive listing is never acceptable.
    expect(() => buildListQuery([])).toThrow()
  })

  it('quotes each id', () => {
    expect(buildListQuery(['id-1'])).toContain("'id-1'")
  })
})
