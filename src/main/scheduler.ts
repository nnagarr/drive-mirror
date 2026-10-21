import { isRunMissed, nextFireAt } from '../core/schedule'
import type { ScheduleShape } from '../core/schedule'
import type { RunSummary } from './ipc'
import type { Settings } from './settings'

/**
 * The timer that runs the syncs on their own.
 *
 * There is **one** schedule and **one** way to run it. The in-app timer
 * fires while the app is open; a Windows task fires when it is not. Only
 * one of the two is ever active, because two would mean two syncs per
 * slot.
 *
 * A slot the machine slept through is not lost. The resume hook checks the
 * clock, and a run that was missed happens once, when the app next wakes.
 */

/** What the scheduler needs from the outside world. */
export interface SchedulerDeps {
  /** The settings as they are now. */
  settings(): Promise<Settings>
  /** Save part of the settings. */
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  /** Run a sync of every enabled mirror. */
  runSync(): Promise<RunSummary>
  /** The current time. */
  now(): Date
  /** Create the Windows task. */
  registerTask(shape: ScheduleShape, exePath: string, nextRunAt: Date): Promise<void>
  /** Remove the Windows task. */
  unregisterTask(): Promise<void>
  /** Whether the Windows task is there. */
  taskExists(): Promise<boolean>
  /** Where the app's executable is. */
  exePath(): string
  /** Arm a timer. */
  setTimer(fn: () => void, ms: number): unknown
  /** Disarm a timer. */
  clearTimer(handle: unknown): void
  /** Listen for the machine waking up. Returns a way to stop listening. */
  onResume(fn: () => void): () => void
  /** Tell the user something. */
  notify(title: string, body: string): void
}

/** The scheduler. */
export interface Scheduler {
  /** Start it: catch up on a missed run, and arm the timer. */
  start(): Promise<void>
  /** Stop it. */
  stop(): void
  /** Run now, whether a slot is due or not. */
  runNow(): Promise<void>
  /** When the next run is due, or null when there is not one. */
  nextRunAt(): string | null
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let shape: ScheduleShape | null = null
  let lastRunAt: string | null = null
  let nextRun: Date | null = null
  let stopResume: (() => void) | null = null

  /** Arm the timer for the next slot. */
  function arm(): void {
    if (!shape) return
    nextRun = nextFireAt(shape, deps.now(), lastRunAt)
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
    const wait = Math.max(0, nextRun.getTime() - deps.now().getTime())
    timer = deps.setTimer(() => {
      void runNow()
    }, wait)
  }

  /** Do the run, and remember when it happened. */
  async function doRun(): Promise<void> {
    try {
      await deps.runSync()
      lastRunAt = deps.now().toISOString()
      const settings = await deps.settings()
      await deps.saveSettings({
        schedule: { ...settings.schedule, lastRunAt, nextRunAt: null },
      })
    } catch (err) {
      // The user is not watching when a scheduled run happens, so a
      // failure that nobody hears about is a backup that quietly stopped.
      deps.notify(
        'The scheduled sync did not finish',
        err instanceof Error ? err.message : String(err),
      )
    }
    arm()
  }

  function runNow(): Promise<void> {
    // A run that is already going is the run. A second request joins it
    // rather than starting a second one.
    if (inFlight) return inFlight
    const run = doRun()
    inFlight = run
    const clear = (): void => {
      if (inFlight === run) inFlight = null
    }
    run.then(clear, clear)
    return run
  }

  /** Whether a slot was missed while the app was not looking. */
  function missed(): boolean {
    if (!shape) return false
    // A schedule that has never run has nothing to catch up on. The user
    // presses Sync now, or waits for the first slot.
    if (lastRunAt === null) return false
    return isRunMissed(shape, lastRunAt, deps.now())
  }

  /** Read the schedule out of the settings and remember it. */
  async function refresh(): Promise<Settings['schedule']> {
    const settings = await deps.settings()
    shape = settings.schedule.shape
    lastRunAt = settings.schedule.lastRunAt
    return settings.schedule
  }

  return {
    async start(): Promise<void> {
      const schedule = await refresh()
      if (!schedule.enabled) return

      if (schedule.mechanism === 'windows-task') {
        if (!(await deps.taskExists())) {
          await deps.registerTask(
            shape!,
            deps.exePath(),
            nextFireAt(shape!, deps.now(), lastRunAt),
          )
        }
      }

      // A run that was missed - the machine was off, or the user was not
      // signed in - happens once, now.
      if (missed()) {
        await runNow()
      }

      if (schedule.mechanism === 'in-app') {
        arm()
      }

      stopResume = deps.onResume(() => {
        void onWake()
      })
    },

    stop(): void {
      if (timer !== null) {
        deps.clearTimer(timer)
        timer = null
      }
      if (stopResume) {
        stopResume()
        stopResume = null
      }
    },

    runNow(): Promise<void> {
      return runNow()
    },

    nextRunAt(): string | null {
      return nextRun ? nextRun.toISOString() : null
    },
  }

  /** The machine woke up. A slot that went by while it slept is not lost. */
  async function onWake(): Promise<void> {
    const schedule = await refresh()
    if (!schedule.enabled) return
    if (missed()) {
      await runNow()
      return
    }
    if (schedule.mechanism === 'in-app') {
      arm()
    }
  }
}
