/**
 * What the shared log remembers about one account.
 *
 * The log is a single file for the whole app, and every account writes
 * into it. Removing an account has to take its lines out without touching
 * the lines another account left behind.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../core/atomic'

/**
 * Remove every line that names this account.
 *
 * A line belongs to the account when it carries the account's address or
 * id, and a line the app wrote without an owner still goes when its
 * message names the address. A line that cannot be read is not attributed
 * to anyone, so it stays.
 */
export async function stripAccountFromLog(
  dir: string,
  account: { email: string; id: string },
): Promise<void> {
  const path = join(dir, 'app.log')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // There is no log to clean.
    return
  }

  const email = account.email.trim().toLowerCase()
  const id = account.id.trim().toLowerCase()

  const kept = text.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return false

    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      return true
    }
    if (typeof event !== 'object' || event === null) return true

    const record = event as { account?: unknown; message?: unknown }
    if (typeof record.account === 'string') {
      const owner = record.account.trim().toLowerCase()
      if (owner === email || owner === id) return false
    }
    if (typeof record.message === 'string') {
      const message = record.message.toLowerCase()
      if (email.length > 0 && message.includes(email)) return false
      if (id.length > 0 && message.includes(id)) return false
    }
    return true
  })

  await writeAtomic(path, kept.length > 0 ? `${kept.join('\n')}\n` : '')
}
