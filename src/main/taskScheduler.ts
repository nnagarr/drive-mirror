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
 *
 * Each account has a task of its own, named after the account, so two
 * accounts can run at their own times. The command carries the account's
 * id, so the app knows which one to run.
 */

/**
 * The name the task carried before accounts existed.
 *
 * The migration removes this task: it fired a run with no account in it,
 * which would now run every account at once.
 */
export const TASK_NAME = 'Drive Mirror Sync'

/** The weekdays, as Windows spells them. */
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/**
 * The name one account's task carries in Windows.
 *
 * The account's address is in it, so a person looking at Task Scheduler
 * can tell which account a task belongs to.
 */
export function taskNameFor(email: string): string {
  return `${TASK_NAME} - ${email}`
}

/**
 * The arguments for `schtasks.exe /Create`.
 *
 * The command that runs the app is one argument: the path in quotes,
 * followed by the flag that makes the app do one sync and exit, and the
 * account to sync. A path with spaces in it has to survive as one piece,
 * so the quotes are part of the value rather than part of the shell.
 */
export function buildSchtasksArgs(
  shape: ScheduleShape,
  exePath: string,
  nextRunAt: Date,
  accountId: string,
  accountEmail: string,
): string[] {
  const args = [
    '/Create',
    '/TN',
    taskNameFor(accountEmail),
    '/TR',
    `"${exePath}" --sync-once --account ${accountId}`,
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

/** The arguments for `schtasks.exe /Delete`, for one account's task. */
export function buildDeleteArgs(accountEmail: string): string[] {
  return ['/Delete', '/TN', taskNameFor(accountEmail), '/F']
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
  accountId: string,
  accountEmail: string,
): Promise<void> {
  await run(
    'schtasks.exe',
    buildSchtasksArgs(shape, exePath, nextRunAt, accountId, accountEmail),
  )
}

/** Remove one account's task. A task that is not there is not an error. */
export async function unregisterTask(accountEmail: string): Promise<void> {
  try {
    await run('schtasks.exe', buildDeleteArgs(accountEmail))
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/**
 * Remove the task that older versions of the app used.
 *
 * It fired a run with no account in it, which would now run every account
 * at once, and it has no account to be named after.
 */
export async function unregisterLegacyTask(): Promise<void> {
  try {
    await run('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'])
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/** Whether one account's task is there. */
export async function taskExists(accountEmail: string): Promise<boolean> {
  try {
    await run('schtasks.exe', ['/Query', '/TN', taskNameFor(accountEmail)])
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
