import { describe, expect, it } from 'vitest'
import { createScheduler } from '../src/main/scheduler'
import { defaultAccountSettings } from '../src/main/accountSettings'
import type { RunSummary } from '../src/main/ipc'
import type { ScheduleShape } from '../src/core/schedule'
import type { AccountSettings } from '../src/main/accountSettings'

/** Everything the scheduler under test needs, and what it did. */
function harness(
  options: {
    shape?: ScheduleShape
    mechanism?: 'in-app' | 'windows-task'
    lastRunAt?: string | null
    now?: Date
    taskExists?: boolean
    /** Whether the run is given up on, as it is when another account is syncing. */
    skipped?: boolean
  } = {},
) {
  const settings: AccountSettings = {
    ...defaultAccountSettings(),
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
    unregistered: 0,
    notifications: [] as string[],
  }

  const deps = {
    accountId: 'acc_test',
    accountEmail: 'user@example.com',
    settings: async (): Promise<AccountSettings> => settings,
    saveSettings: async (patch: Partial<AccountSettings>): Promise<AccountSettings> => {
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
        errors: options.skipped ? 1 : 0,
        mirrors: [],
        changed: [],
        reports: [],
        ...(options.skipped ? { skipped: true as const } : {}),
      }
    },
    now: (): Date => options.now ?? new Date('2026-03-01T10:00:00'),
    registerTask: async (): Promise<void> => {
      calls.registered += 1
    },
    unregisterTask: async (): Promise<void> => {
      calls.unregistered += 1
    },
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

  it('retries a slot that was missed, and does not move the clock', async () => {
    const h = harness({
      shape: { kind: 'every-hours', everyHours: 6 },
      lastRunAt: new Date('2026-03-01T00:00:00').toISOString(),
      now: new Date('2026-03-01T20:00:00'),
      skipped: true,
    })
    const s = createScheduler(h.deps)

    await s.start()

    // The run was given up on, so the clock stays where it was and the
    // slot is caught up rather than lost.
    expect(h.calls.runs).toBe(1)
    expect(h.settings.schedule.lastRunAt).toBe(new Date('2026-03-01T00:00:00').toISOString())
    // And the timer is armed again, for the slot that was missed.
    expect(h.calls.armed).toBeGreaterThan(0)
    expect(h.calls.notifications.join(' ')).toContain('another sync was already running')
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

  it('notifies the user when catching up on a missed run', async () => {
    const h = harness({
      shape: { kind: 'every-hours', everyHours: 6 },
      lastRunAt: new Date('2026-03-01T00:00:00').toISOString(),
      now: new Date('2026-03-01T20:00:00'),
    })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.runs).toBe(1)
    expect(h.calls.notifications).toContain('Catching up on missed scheduled sync')
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

  it('removes any existing Windows task and always arms in-app timer on start', async () => {
    const h = harness({ mechanism: 'windows-task', taskExists: true })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.calls.unregistered).toBe(1)
    expect(h.calls.registered).toBe(0)
    expect(h.calls.armed).toBe(1)
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

  it('persists nextRunAt when the in-app timer is armed', async () => {
    const h = harness({ mechanism: 'in-app' })
    const s = createScheduler(h.deps)

    await s.start()

    expect(h.settings.schedule.nextRunAt).not.toBeNull()
  })

  it('notifies only once when waking up multiple times to catch up', async () => {
    let wake: (() => void) | null = null
    let currentTime = new Date('2026-03-01T05:00:00')
    const h = harness({
      shape: { kind: 'every-hours', everyHours: 6 },
      lastRunAt: new Date('2026-03-01T00:00:00').toISOString(),
    })
    h.deps.now = () => currentTime
    h.deps.onResume = (fn) => {
      wake = fn
      return () => {
        wake = null
      }
    }
    const s = createScheduler(h.deps)
    await s.start()
    expect(h.calls.notifications).toHaveLength(0)

    // Machine slept past 06:00 slot, now wakes at 10:00
    currentTime = new Date('2026-03-01T10:00:00')
    const triggerWake = wake as (() => void) | null
    triggerWake?.()
    triggerWake?.()
    triggerWake?.()

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(h.calls.notifications.filter((n) => n === 'Catching up on missed scheduled sync')).toHaveLength(1)
  })

  it('does not send catch-up notification if a sync is already in flight when waking', async () => {
    let wake: (() => void) | null = null
    let releaseSync: (() => void) | null = null
    const currentTime = new Date('2026-03-01T10:00:00')
    const h = harness({
      shape: { kind: 'every-hours', everyHours: 6 },
      lastRunAt: new Date('2026-03-01T00:00:00').toISOString(),
      now: currentTime,
    })
    h.deps.runSync = () => {
      h.calls.runs += 1
      return new Promise((resolve) => {
        releaseSync = () => {
          resolve({
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
          })
        }
      })
    }
    h.deps.onResume = (fn) => {
      wake = fn
      return () => {
        wake = null
      }
    }
    const s = createScheduler(h.deps)

    // Start a sync manually first
    const running = s.runNow()
    expect(h.calls.runs).toBe(1)

    // Wake arrives while running is in flight
    const triggerWake = wake as (() => void) | null
    triggerWake?.()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Should not notify because sync is already in flight
    expect(h.calls.notifications).toHaveLength(0)

    const release = releaseSync as (() => void) | null
    release?.()
    await running
  })
})
