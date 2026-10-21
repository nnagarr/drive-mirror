import type { Settings } from './settings'

/**
 * A note left for the user for something that happened while they were
 * not looking.
 *
 * A scheduled run has no window to show a banner in, so it leaves a note
 * behind. The interface shows the note the next time it is opened, and
 * clears it.
 *
 * The settings are not changed in place: a caller that keeps the object it
 * passed in must not find a note in it afterwards.
 */

/** Leave a note for the user. */
export async function setPendingNotice(
  settings: Settings,
  message: string,
  now: Date,
): Promise<Settings> {
  if (typeof message !== 'string' || message.length === 0) {
    return settings
  }
  return {
    ...settings,
    pendingNotice: { message, at: now.toISOString() },
  }
}

/** Take the note away, once the user has seen it. */
export async function clearPendingNotice(settings: Settings): Promise<Settings> {
  return { ...settings, pendingNotice: null }
}
