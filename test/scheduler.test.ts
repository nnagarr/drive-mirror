import { describe, expect, it } from 'vitest'
import { createScheduler } from '../src/main/scheduler'
import { defaultSettings } from '../src/main/settings'
import type { RunSummary } from '../src/main/ipc'
import type { ScheduleShape } from '../src/core/schedule'
import type { Settings } from '../src/main/settings'

/** Everything the scheduler under test needs, and what it did. */
function harness(
  options: {
    shape?: ScheduleShape
    mechanism?: 'in-app' | 'windows-task'
    lastRunAt?: string | null
    now?: Date
    taskExists?: boolean
  } = {},
) {
  const settings: Settings = {
    ...defaultSettings(),
    schedule: {
      enabled: true,
      shape: options.shape ?? { kind: 'daily', at: '02:00' },
      mechanism: options.mechanism ?? 'in-app',
      lastRunAt: options.lastRunAt ?? null,
      nextRunAt: null,
    },
  }

  const calls = {
    runs: 0,
    armed: 0,
    registered: 0,
    notifications: [] as string[],
  }

  const deps = {
    settings: async (): Promise<Settings> => settings,
    saveSettings: async (patch: Partial<Settings>): Promise<Settings> => {
      Object.assign(settings, patch)
      return settings
    },
    runSync: async (): Promise<RunSummary> => {
      calls.runs += 1
      return {
        startedAt: '',
        finishedAt: '',
        uploaded: 0,
        updated: 0,
        downloaded: 0,
        trashed: 0,
        errors: 0,
        mirrors: [],
        changed: [],
        reports: [],
      }
    },
    now: (): Date => options.now ?? new Date('2026-03-01T10:00:00'),
    registerTask: async (): Promise<void> => {
      calls.registered += 1
    },
    unregisterTask: async (): Promise<void> => {},
    taskExists: async (): Promise<boolean> => options.taskExists ?? true,
    exePath: (): string => 'C:\\app\\Drive Mirror.exe',
    setTimer: (_fn: () => void, _ms: number): unknown => {
      calls.armed += 1
      return 1
    },
    clearTimer: (_handle: unknown): void => {},
    onResume: (_fn: () => void): (() => void) => () => {},
    notify: (_title: string, body: string): void => {
      calls.notifications.push(body)
    },
  }

  return { deps, calls, settings }
}

describe('the scheduler', () => {
  it('does not run at once when it is switched on', async () => {
    const h = harness({ lastRunAt: null })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.runs).toBe(0)
  })

  it('runs once when a run was missed', async () => {
    const h = harness({
      shape: { kind: 'every-hours', everyHours: 6 },
      lastRunAt: new Date('2026-03-01T00:00:00').toISOString(),
      now: new Date('2026-03-01T20:00:00'),
    })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.runs).toBe(1)
  })

  it('does not run again when the last run was recent', async () => {
    const h = harness({
      shape: { kind: 'every-hours', everyHours: 6 },
      lastRunAt: new Date('2026-03-01T18:00:00').toISOString(),
      now: new Date('2026-03-01T20:00:00'),
    })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.runs).toBe(0)
  })

  it('does not start a second run while one is in flight', async () => {
    const h = harness()
    let release: () => void = () => {}
    h.deps.runSync = () => {
      h.calls.runs += 1
      return new Promise((resolve) => {
        release = resolve as () => void
      }) as unknown as Promise<RunSummary>
    }
    const s = createScheduler(h.deps)

    const first = s.runNow()
    const second = s.runNow()

    expect(h.calls.runs).toBe(1)
    release()
    await Promise.all([first, second])
  })

  it('arms the timer for the next slot', async () => {
    const h = harness()
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.armed).toBe(1)
  })

  it('registers the Windows task when it is missing', async () => {
    const h = harness({ mechanism: 'windows-task', taskExists: false })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.registered).toBe(1)
  })

  it('leaves the Windows task alone when it is already there', async () => {
    const h = harness({ mechanism: 'windows-task', taskExists: true })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.registered).toBe(0)
  })

  it('does not arm a timer when the Windows task runs the app', async () => {
    const h = harness({ mechanism: 'windows-task' })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.armed).toBe(0)
  })

  it('does nothing when the schedule is switched off', async () => {
    const h = harness()
    h.settings.schedule.enabled = false
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.armed).toBe(0)
    expect(h.calls.runs).toBe(0)
  })

  it('tells the user when a scheduled run fails', async () => {
    const h = harness()
    h.deps.runSync = async (): Promise<RunSummary> => {
      throw new Error('the token could not be refreshed')
    }
    const s = createScheduler(h.deps)

    await s.runNow()

    expect(h.calls.notifications).toHaveLength(1)
    expect(h.calls.notifications[0]).toContain('the token could not be refreshed')
  })

  it('remembers when the last run happened', async () => {
    const now = new Date('2026-03-01T10:00:00')
    const h = harness({ now })
    const s = createScheduler(h.deps)

    await s.runNow()

    expect(h.settings.schedule.lastRunAt).toBe(now.toISOString())
  })
})
