import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripAccountFromLog } from '../src/main/logFile'

/** A log folder holding the given lines. */
async function logWith(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dm-log-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'app.log'), `${lines.join('\n')}\n`, 'utf8')
  return dir
}

/** One log line, as the app writes it. */
function line(event: Record<string, unknown>): string {
  return JSON.stringify({ at: '2026-10-22T00:00:00.000Z', level: 'info', ...event })
}

describe('removing an account from the shared log', () => {
  it('drops its lines and keeps every other line', async () => {
    const dir = await logWith([
      line({ message: 'state', account: 'you@example.com' }),
      line({ message: 'state', account: 'acc_7f3a2b' }),
      line({ message: 'the task for you@example.com was removed' }),
      line({ message: 'state', account: 'other@example.com' }),
      line({ message: 'the app started' }),
    ])

    await stripAccountFromLog(dir, { email: 'you@example.com', id: 'acc_7f3a2b' })

    const kept = await readFile(join(dir, 'app.log'), 'utf8')
    expect(kept).not.toContain('you@example.com')
    expect(kept).not.toContain('acc_7f3a2b')
    expect(kept).toContain('other@example.com')
    expect(kept).toContain('the app started')
  })

  it('does nothing when there is no log yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-log-'))
    await expect(
      stripAccountFromLog(dir, { email: 'you@example.com', id: 'acc_7f3a2b' }),
    ).resolves.toBeUndefined()
  })

  it('keeps a line it cannot read', async () => {
    const dir = await logWith(['not json at all'])

    await stripAccountFromLog(dir, { email: 'you@example.com', id: 'acc_7f3a2b' })

    expect(await readFile(join(dir, 'app.log'), 'utf8')).toContain('not json at all')
  })
})
