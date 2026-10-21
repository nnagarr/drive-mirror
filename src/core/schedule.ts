/**
 * When the app syncs on its own.
 *
 * The schedule is pure arithmetic on the clock: it knows nothing about the
 * app, the Drive, or the user's folders, so it can be worked out and
 * checked on its own.
 */

/** How the schedule repeats. */
export type ScheduleShape =
  | { kind: 'every-hours'; everyHours: number }
  | { kind: 'daily'; at: string }
  | { kind: 'every-days'; everyDays: number }
  | { kind: 'weekly'; day: number; at: string }

/** An hour, in milliseconds. */
const HOUR_MS = 60 * 60 * 1000
/** A day, in milliseconds. */
const DAY_MS = 24 * HOUR_MS

/**
 * When the next run is due.
 *
 * The shapes that count intervals - every N hours, every N days - are
 * **anchored on the last run**, not on the moment the question was asked.
 * A schedule that restarted its interval every time it was recomputed
 * would drift, and one that counted from "now" would never catch up after
 * the machine had been off.
 *
 * The shapes that name a time of day - daily, weekly - are anchored on the
 **wall clock**, because that is what they mean: 02:00 is 02:00 whether the
 * app was open or not.
 */
export function nextFireAt(
  shape: ScheduleShape,
  from: Date,
  lastRunAt: string | null,
): Date {
  switch (shape.kind) {
    case 'every-hours':
      return advance(from, lastRunAt, shape.everyHours * HOUR_MS)
    case 'every-days':
      return advance(from, lastRunAt, shape.everyDays * DAY_MS)
    case 'daily': {
      const next = atTimeOfDay(from, shape.at)
      if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
      return next
    }
    case 'weekly': {
      const next = atTimeOfDay(from, shape.at)
      const days = (shape.day - next.getDay() + 7) % 7
      next.setDate(next.getDate() + days)
      if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 7)
      return next
    }
  }
}

/**
 * The next slot after the last run, or after `from` when there has never
 * been a run.
 */
function advance(from: Date, lastRunAt: string | null, step: number): Date {
  const last = lastRunAt ? Date.parse(lastRunAt) : Number.NaN
  if (Number.isNaN(last)) return new Date(from.getTime() + step)
  let next = new Date(last + step)
  while (next.getTime() <= from.getTime()) {
    next = new Date(next.getTime() + step)
  }
  return next
}

/** The same day as `from`, at the given time of day. */
function atTimeOfDay(from: Date, at: string): Date {
  const [hours, minutes] = parseTime(at)
  const next = new Date(from)
  next.setHours(hours, minutes, 0, 0)
  return next
}

/** "HH:MM" as an hour and a minute. */
function parseTime(at: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(at)
  if (!match) return [0, 0]
  return [Number(match[1]), Number(match[2])]
}

/** How long one interval is. */
export function intervalMs(shape: ScheduleShape): number {
  switch (shape.kind) {
    case 'every-hours':
      return shape.everyHours * HOUR_MS
    case 'every-days':
      return shape.everyDays * DAY_MS
    case 'daily':
      return DAY_MS
    case 'weekly':
      return 7 * DAY_MS
  }
}

/**
 * Whether a run was missed.
 *
 * A run that has never happened counts as missed: the app has files to
 * copy and has not copied them.
 */
export function isRunMissed(
  shape: ScheduleShape,
  lastRunAt: string | null,
  now: Date,
): boolean {
  if (!lastRunAt) return true
  const last = Date.parse(lastRunAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last > intervalMs(shape)
}

/** Whether a shape is one the app can actually run. */
export function isValidShape(shape: ScheduleShape): boolean {
  switch (shape.kind) {
    case 'every-hours':
      return (
        Number.isInteger(shape.everyHours) &&
        shape.everyHours >= 1 &&
        shape.everyHours <= 23
      )
    case 'every-days':
      return (
        Number.isInteger(shape.everyDays) &&
        shape.everyDays >= 1 &&
        shape.everyDays <= 31
      )
    case 'daily':
      return isValidTime(shape.at)
    case 'weekly':
      return (
        Number.isInteger(shape.day) &&
        shape.day >= 0 &&
        shape.day <= 6 &&
        isValidTime(shape.at)
      )
  }
}

/** Whether a string is a time of day the app can use. */
function isValidTime(at: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(at)
  if (!match) return false
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
}
