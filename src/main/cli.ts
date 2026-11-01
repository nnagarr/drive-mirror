/**
 * The command line.
 *
 * The app is launched two ways: by the user, with a window, and by a
 * Windows task, which wants one sync and no window. The second is told
 * which account to sync with `--account`.
 */

export interface CliOptions {
  /** Whether this is a run that quits when it is done. */
  syncOnce: boolean
  /** Which account to run, or null for all of them. */
  accountId: string | null
}

/**
 * What the app was asked to do.
 *
 * `--account` takes the next argument as its value, and is ignored when
 * there is none.
 */
export function parseCli(argv: string[]): CliOptions {
  let syncOnce = false
  let accountId: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--sync-once') {
      syncOnce = true
      continue
    }
    if (arg === '--account') {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        accountId = value
        i++
      }
      continue
    }
  }
  return { syncOnce, accountId }
}
