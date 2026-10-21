import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScheduleShape } from '../core/schedule'

const run = promisify(execFile)

/**
 * The Windows task that runs the app when it is closed.
 *
 * The task is created for the current user, in the user's own session, and
 * without a stored password. That is not a shortcut: the app's credentials
 * are encrypted with the Windows account, so a task that ran under a
 * service account could not decrypt them, and the task could not run at
 * all. The trade is that the task only fires while the user is signed in.
 */

/** The name the task carries in Windows. */
export const TASK_NAME = 'Drive Mirror Sync'

/** The weekdays, as Windows spells them. */
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/**
 * The arguments for `schtasks.exe /Create`.
 *
 * The command that runs the app is one argument: the path in quotes,
 * followed by the flag that makes the app do one sync and exit. A path
 * with spaces in it has to survive as one piece, so the quotes are part
 * of the value rather than part of the shell.
 */
export function buildSchtasksArgs(
  shape: ScheduleShape,
  exePath: string,
  nextRunAt: Date,
): string[] {
  const args = [
    '/Create',
    '/TN',
    TASK_NAME,
    '/TR',
    `"${exePath}" --sync-once`,
    '/F',
    // Run in the user's own session, so the encrypted credentials can be
    // read. Without a stored password, so nothing has to be saved.
    '/IT',
  ]

  switch (shape.kind) {
    case 'every-hours':
      args.push('/SC', 'HOURLY', '/MO', String(shape.everyHours))
      break
    case 'daily':
      args.push('/SC', 'DAILY', '/ST', shape.at)
      break
    case 'every-days':
      args.push('/SC', 'DAILY', '/MO', String(shape.everyDays), '/ST', timeOf(nextRunAt))
      break
    case 'weekly':
      args.push('/SC', 'WEEKLY', '/D', DAYS[shape.day] ?? 'SUN', '/ST', shape.at)
      break
  }

  return args
}

/** The arguments for `schtasks.exe /Delete`. */
export function buildDeleteArgs(): string[] {
  return ['/Delete', '/TN', TASK_NAME, '/F']
}

/** A time of day, as Windows wants it. */
function timeOf(when: Date): string {
  const hours = String(when.getHours()).padStart(2, '0')
  const minutes = String(when.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Create the task, replacing any task of the same name.
 *
 * The task is created for the current user without a password, so it runs
 * in the user's session.
 */
export async function registerTask(
  shape: ScheduleShape,
  exePath: string,
  nextRunAt: Date,
): Promise<void> {
  await run('schtasks.exe', buildSchtasksArgs(shape, exePath, nextRunAt))
}

/** Remove the task. A task that is not there is not an error. */
export async function unregisterTask(): Promise<void> {
  try {
    await run('schtasks.exe', buildDeleteArgs())
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/** Whether the task is there. */
export async function taskExists(): Promise<boolean> {
  try {
    await run('schtasks.exe', ['/Query', '/TN', TASK_NAME])
    return true
  } catch {
    return false
  }
}

/** Whether a failure means "there is no such task". */
function isNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /cannot find|no tasks|not find/i.test(message)
}
