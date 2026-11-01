import { isRunMissed, nextFireAt } from '../core/schedule'
import type { ScheduleShape } from '../core/schedule'
import type { RunSummary } from './ipc'
import type { ScheduleConfig } from './settings'
import type { AccountSettings } from './accountSettings'

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
  /** The account this scheduler runs. */
  accountId: string
  /** The address of that account, which its Windows task is named after. */
  accountEmail: string
  /** The account's settings as they are now. */
  settings(): Promise<AccountSettings>
  /** Save part of the account's settings. */
  saveSettings(patch: Partial<AccountSettings>): Promise<AccountSettings>
  /** Run a sync of every enabled mirror of this account. */
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
  /**
   * Take a new schedule into account.
   *
   * Called when the user changes the schedule, so the app does not need
   * restarting for the change to mean anything. The Windows task is
   * removed when the schedule is switched off or the mechanism moves away
   * from it, because a task that outlives its schedule keeps firing.
   */
  applySchedule(): Promise<void>
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
  let mechanism: ScheduleConfig['mechanism'] = 'in-app'
  let lastRunAt: string | null = null
  let nextRun: Date | null = null
  /**
   * The slot the timer is armed for.
   *
   * A slot that was missed because another account was syncing is retried
   * as soon as the lock is free, and this is the slot it was.
   */
  let dueAt: Date | null = null
  let stopResume: (() => void) | null = null

  /**
   * Arm the timer for the next slot.
   *
   * A slot that was given up on is armed again with `retryAt`, so the work
   * happens as soon as the other account is finished rather than a whole
   * period later.
   */
  function arm(retryAt?: Date): void {
    if (!shape) return
    const now = deps.now()
    nextRun = retryAt ?? nextFireAt(shape, now, lastRunAt)
    dueAt = nextRun
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
    const wait = Math.max(0, nextRun.getTime() - now.getTime())
    timer = deps.setTimer(() => {
      void runNow()
    }, wait)
    // The next run is shown in the interface, so it has to be written
    // down. A slot being retried is already past, so the next run is now.
    const shown = nextRun.getTime() > now.getTime() ? nextRun : now
    void persist({ nextRunAt: shown.toISOString() })
  }

  /** Save part of the schedule. */
  async function persist(patch: Partial<ScheduleConfig>): Promise<void> {
    const settings = await deps.settings()
    await deps.saveSettings({ schedule: { ...settings.schedule, ...patch } })
  }

  /** Do the run, and remember when it happened. */
  async function doRun(): Promise<void> {
    try {
      const summary = await deps.runSync()
      if (summary.skipped) {
        // The run did not happen: another account was syncing. The clock
        // must not move, or the slot is lost and never caught up.
        deps.notify(
          'The scheduled sync did not run',
          'another sync was already running, so this slot was missed',
        )
        // The slot is retried as soon as the lock is free, rather than
        // waiting a whole period for the next one. The retry waits for
        // the lock in its turn, so the work is not lost.
        if (mechanism === 'in-app') arm(dueAt ?? deps.now())
        return
      }
      lastRunAt = deps.now().toISOString()
      await persist({ lastRunAt })
    } catch (err) {
      // The user is not watching when a scheduled run happens, so a
      // failure that nobody hears about is a backup that quietly stopped.
      deps.notify(
        'The scheduled sync did not finish',
        err instanceof Error ? err.message : String(err),
      )
    }
    // Only the in-app timer is armed here. With the Windows task as the
    // mechanism, the app's own timer must stay off, or there would be two
    // syncs per slot.
    if (mechanism === 'in-app') arm()
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

  /**
   * Whether a slot was missed while the app was not looking.
   *
   * A schedule that has **never run** has nothing to catch up on: the
   * user pressed Sync now, or the first slot is still to come. That is a
   * different question from `isRunMissed`, which asks whether a run that
   * was due did not happen.
   */
  function catchUpIsDue(): boolean {
    if (!shape) return false
    if (lastRunAt === null) return false
    return isRunMissed(shape, lastRunAt, deps.now())
  }

  /** Read the schedule out of the settings and remember it. */
  async function refresh(): Promise<ScheduleConfig> {
    const settings = await deps.settings()
    shape = settings.schedule.shape
    mechanism = settings.schedule.mechanism
    lastRunAt = settings.schedule.lastRunAt
    return settings.schedule
  }

  /** Take the Windows task away. A task that is not there is not an error. */
  async function removeTask(): Promise<void> {
    try {
      await deps.unregisterTask()
    } catch {
      // Nothing to remove, or Windows would not say. Either way there is
      // no task to fire.
    }
  }

  /** Disarm the timer and stop listening for the machine waking up. */
  function stopTimer(): void {
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
    if (stopResume) {
      stopResume()
      stopResume = null
    }
  }

  return {
    async start(): Promise<void> {
      const schedule = await refresh()
      if (!schedule.enabled) {
        await removeTask()
        return
      }

      if (schedule.mechanism === 'windows-task') {
        if (!(await deps.taskExists())) {
          await deps.registerTask(
            shape!,
            deps.exePath(),
            nextFireAt(shape!, deps.now(), lastRunAt),
          )
        }
      } else {
        await removeTask()
      }

      // A run that was missed - the machine was off, or the user was not
      // signed in - happens once, now.
      if (catchUpIsDue()) {
        // The run arms the timer itself: with the next slot, or with a
        // retry of the missed one.
        await runNow()
      } else if (schedule.mechanism === 'in-app') {
        arm()
      }

      stopResume = deps.onResume(() => {
        void onWake()
      })
    },

    async applySchedule(): Promise<void> {
      const schedule = await refresh()

      if (!schedule.enabled) {
        // The task must not outlive the schedule that asked for it.
        await removeTask()
        stopTimer()
        return
      }

      if (schedule.mechanism === 'windows-task') {
        // The app's own timer must not also run.
        stopTimer()
        if (!(await deps.taskExists())) {
          await deps.registerTask(
            shape!,
            deps.exePath(),
            nextFireAt(shape!, deps.now(), lastRunAt),
          )
        }
        return
      }

      await removeTask()
      arm()
    },

    stop(): void {
      stopTimer()
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
    if (catchUpIsDue()) {
      await runNow()
      return
    }
    if (schedule.mechanism === 'in-app') {
      arm()
    }
  }
}
