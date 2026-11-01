/**
 * A note left for the user for something that happened while they were
 * not looking.
 *
 * A scheduled run has no window to show a banner in, so it leaves a note
 * behind. The interface shows the note the next time it is opened, and
 * clears it.
 *
 * The note belongs to the account it came from, and the app itself can
 * leave one too, so these functions work on any settings object that
 * carries a note. The settings are not changed in place: a caller that
 * keeps the object it passed in must not find a note in it afterwards.
 */

/** A note, and when it was left. */
export interface PendingNotice {
  message: string
  at: string
}

/** Any settings object that can carry a note. */
export interface HasPendingNotice {
  pendingNotice: PendingNotice | null
}

/** Leave a note for the user. */
export async function setPendingNotice<T extends HasPendingNotice>(
  settings: T,
  message: string,
  now: Date,
): Promise<T> {
  if (typeof message !== 'string' || message.length === 0) {
    return settings
  }
  return {
    ...settings,
    pendingNotice: { message, at: now.toISOString() },
  }
}

/** Take the note away, once the user has seen it. */
export async function clearPendingNotice<T extends HasPendingNotice>(
  settings: T,
): Promise<T> {
  return { ...settings, pendingNotice: null }
}
