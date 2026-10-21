import { describe, it, expect } from 'vitest'
import { summaryIsQuiet } from '../src/renderer/format'

describe('what the summary bar says about a run', () => {
  const nothing = {
    uploaded: 0,
    updated: 0,
    downloaded: 0,
    trashed: 0,
    errors: 0,
    reports: [],
  }

  it('is quiet when a run changed nothing and had nothing to say', () => {
    expect(summaryIsQuiet(nothing)).toBe(true)
  })

  it('is not quiet when a run reported something', () => {
    expect(
      summaryIsQuiet({
        ...nothing,
        reports: [{ code: 'anomaly', relPath: '', message: 'another sync was running' }],
      }),
    ).toBe(false)
  })

  it('is not quiet when a run changed something', () => {
    expect(summaryIsQuiet({ ...nothing, uploaded: 1 })).toBe(false)
    expect(summaryIsQuiet({ ...nothing, errors: 1 })).toBe(false)
  })
})
