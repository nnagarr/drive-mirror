/**
 * The event log.
 *
 * The log is the app's record of what it did and why. It is written as one
 * JSON object per line, so it can be read by a human, tailed while a run is
 * in progress, and parsed by a script afterwards. The same events are kept
 * in memory for the interface to show.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** One logged event. */
export interface LogEvent {
  at: string
  level: 'info' | 'warn' | 'error'
  message: string
  relPath?: string
}

/** A logger writing to `<dir>/app.log`. */
export interface Logger {
  /** Record an event. The timestamp is added here. */
  log(e: Omit<LogEvent, 'at'>): void
  /** Every event recorded so far, oldest first. */
  events(): LogEvent[]
  /** Wait for the pending writes to reach the disk. */
  flush(): Promise<void>
}

/**
 * Create a logger rooted at `dir`.
 *
 * Writes are buffered and flushed in order, so the file never contains a
 * half-written line. A logger whose directory cannot be created still
 * records events in memory: losing the log is bad, but losing the run is
 * worse.
 */
export function createLogger(dir: string): Logger {
  const events: LogEvent[] = []
  const queue: string[] = []
  const logPath = join(dir, 'app.log')

  let writing: Promise<void> = Promise.resolve()
  let broken = false

  async function drain(): Promise<void> {
    if (broken) return
    try {
      await mkdir(dir, { recursive: true })
      while (queue.length > 0) {
        const lines = queue.splice(0, queue.length)
        await appendFile(logPath, lines.join(''), 'utf8')
      }
    } catch {
      // The log is a diagnostic aid, not a deliverable. If it cannot be
      // written the run continues.
      broken = true
    }
  }

  return {
    log(e): void {
      const event: LogEvent = { at: new Date().toISOString(), ...e }
      events.push(event)
      queue.push(`${JSON.stringify(event)}\n`)
      writing = writing.then(drain, drain)
    },
    events(): LogEvent[] {
      return [...events]
    },
    async flush(): Promise<void> {
      await writing
    },
  }
}
