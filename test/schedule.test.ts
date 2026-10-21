import { describe, expect, it } from 'vitest'
import { intervalMs, isRunMissed, isValidShape, nextFireAt } from '../src/core/schedule'

const HOUR = 3600_000
const DAY = 24 * HOUR

describe('the schedule', () => {
  it('adds the hours for an every-hours shape', () => {
    const from = new Date('2026-03-01T10:00:00')
    const next = nextFireAt({ kind: 'every-hours', everyHours: 6 }, from, null)
    expect(next.getTime()).toBe(from.getTime() + 6 * HOUR)
  })

  it('anchors an every-hours shape on the last run, not on now', () => {
    const from = new Date('2026-03-01T12:00:00')
    const lastRun = new Date('2026-03-01T08:00:00')
    const next = nextFireAt(
      { kind: 'every-hours', everyHours: 6 },
      from,
      lastRun.toISOString(),
    )
    expect(next.getTime()).toBe(lastRun.getTime() + 6 * HOUR)
  })

  it('advances past a slot that has already gone', () => {
    const from = new Date('2026-03-01T20:00:00')
    const lastRun = new Date('2026-03-01T02:00:00')
    const next = nextFireAt(
      { kind: 'every-hours', everyHours: 6 },
      from,
      lastRun.toISOString(),
    )
    // 02:00 + 6h = 08:00, +6h = 14:00, +6h = 20:00 (not after `from`),
    // +6h = 02:00 the next day.
    expect(next.getDate()).toBe(2)
    expect(next.getHours()).toBe(2)
  })

  it('finds the next occurrence of a time of day', () => {
    const from = new Date('2026-03-01T10:00:00')
    const next = nextFireAt({ kind: 'daily', at: '02:00' }, from, null)
    expect(next.getHours()).toBe(2)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(2)
  })

  it('finds today when the time has not gone yet', () => {
    const from = new Date('2026-03-01T01:00:00')
    const next = nextFireAt({ kind: 'daily', at: '02:00' }, from, null)
    expect(next.getDate()).toBe(1)
    expect(next.getHours()).toBe(2)
  })

  it('finds the next occurrence of a weekday', () => {
    const from = new Date('2026-03-01T10:00:00') // a Sunday
    const next = nextFireAt({ kind: 'weekly', day: 3, at: '03:00' }, from, null)
    expect(next.getDay()).toBe(3)
    expect(next.getHours()).toBe(3)
    expect(next.getDate()).toBe(4)
  })

  it('adds the days for an every-days shape', () => {
    const from = new Date('2026-03-01T10:00:00')
    const next = nextFireAt({ kind: 'every-days', everyDays: 3 }, from, null)
    expect(next.getDate()).toBe(4)
  })

  it('crosses a month boundary', () => {
    const from = new Date('2026-01-30T10:00:00')
    const next = nextFireAt({ kind: 'every-days', everyDays: 3 }, from, null)
    expect(next.getMonth()).toBe(1)
    expect(next.getDate()).toBe(2)
  })

  it('knows when a run was missed', () => {
    const shape = { kind: 'every-hours', everyHours: 6 } as const
    const now = new Date('2026-03-01T20:00:00')
    expect(
      isRunMissed(shape, new Date('2026-03-01T10:00:00').toISOString(), now),
    ).toBe(true)
    expect(
      isRunMissed(shape, new Date('2026-03-01T18:00:00').toISOString(), now),
    ).toBe(false)
    expect(isRunMissed(shape, null, now)).toBe(true)
  })

  it('treats a run that has just finished as not missed', () => {
    const shape = { kind: 'every-hours', everyHours: 6 } as const
    const now = new Date('2026-03-01T20:00:00')
    expect(isRunMissed(shape, now.toISOString(), now)).toBe(false)
  })

  it('rejects a shape it cannot run', () => {
    expect(isValidShape({ kind: 'every-hours', everyHours: 0 })).toBe(false)
    expect(isValidShape({ kind: 'every-hours', everyHours: 24 })).toBe(false)
    expect(isValidShape({ kind: 'every-hours', everyHours: 6 })).toBe(true)
    expect(isValidShape({ kind: 'every-days', everyDays: 0 })).toBe(false)
    expect(isValidShape({ kind: 'every-days', everyDays: 32 })).toBe(false)
    expect(isValidShape({ kind: 'every-days', everyDays: 3 })).toBe(true)
    expect(isValidShape({ kind: 'daily', at: '99:99' })).toBe(false)
    expect(isValidShape({ kind: 'daily', at: '2:00' })).toBe(false)
    expect(isValidShape({ kind: 'daily', at: '02:00' })).toBe(true)
    expect(isValidShape({ kind: 'weekly', day: 9, at: '02:00' })).toBe(false)
    expect(isValidShape({ kind: 'weekly', day: 3, at: '02:00' })).toBe(true)
  })

  it('gives the length of one interval', () => {
    expect(intervalMs({ kind: 'every-hours', everyHours: 6 })).toBe(6 * HOUR)
    expect(intervalMs({ kind: 'every-days', everyDays: 3 })).toBe(3 * DAY)
    expect(intervalMs({ kind: 'daily', at: '02:00' })).toBe(DAY)
    expect(intervalMs({ kind: 'weekly', day: 3, at: '02:00' })).toBe(7 * DAY)
  })
})
