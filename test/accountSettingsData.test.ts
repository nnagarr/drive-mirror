import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountDir,
  accountSettingsPath,
} from '../src/main/accountPaths'
import {
  createAccountSettingsStore,
  defaultAccountSettings,
} from '../src/main/accountSettings'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dm-acctdata-'))
}

describe('account settings data-honesty fields', () => {
  it('reads an old file without the new fields as null/empty', async () => {
    const root = await tempRoot()
    await mkdir(accountDir(root, 'acc_x'), { recursive: true })
    await writeFile(
      accountSettingsPath(root, 'acc_x'),
      JSON.stringify({ mirrors: [], schedule: defaultAccountSettings().schedule, pendingNotice: null }),
      'utf8',
    )
    const s = await createAccountSettingsStore(root).read('acc_x')
    expect(s.lastRun).toBeNull()
    expect(s.mirrorState).toEqual({})
    await rm(root, { recursive: true, force: true })
  })

  it('round trips lastRun and mirrorState', async () => {
    const root = await tempRoot()
    const store = createAccountSettingsStore(root)
    const settings = defaultAccountSettings()
    const run = {
      startedAt: '2026-10-24T10:00:00Z',
      finishedAt: '2026-10-24T10:02:00Z',
      uploaded: 1,
      updated: 2,
      downloaded: 0,
      trashed: 0,
      errors: 0,
      mirrors: [{ name: 'Docs', counts: { uploaded: 1, updated: 2, downloaded: 0, trashed: 0, errors: 0 } }],
      changed: [],
      reports: [],
    }
    settings.lastRun = run as unknown as typeof settings.lastRun
    settings.mirrorState = { Docs: { status: 'idle', counts: { uploaded: 1, updated: 2, downloaded: 0, trashed: 0, errors: 0 } } }
    await store.write('acc_x', settings)
    const read = await store.read('acc_x')
    expect(read.lastRun?.uploaded).toBe(1)
    expect(read.lastRun?.finishedAt).toBe('2026-10-24T10:02:00Z')
    expect(read.mirrorState.Docs?.status).toBe('idle')
    expect(read.mirrorState.Docs?.counts.updated).toBe(2)
    await rm(root, { recursive: true, force: true })
  })

  it('drops an entry whose status is syncing (never persisted)', async () => {
    const root = await tempRoot()
    await mkdir(accountDir(root, 'acc_x'), { recursive: true })
    await writeFile(
      accountSettingsPath(root, 'acc_x'),
      JSON.stringify({
        ...defaultAccountSettings(),
        mirrorState: { Docs: { status: 'syncing', counts: { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 0 } } },
      }),
      'utf8',
    )
    const s = await createAccountSettingsStore(root).read('acc_x')
    expect(s.mirrorState.Docs).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it('drops a lastRun that is not a RunSummary', async () => {
    const root = await tempRoot()
    await mkdir(accountDir(root, 'acc_x'), { recursive: true })
    await writeFile(
      accountSettingsPath(root, 'acc_x'),
      JSON.stringify({ ...defaultAccountSettings(), lastRun: { foo: 'bar' } }),
      'utf8',
    )
    const s = await createAccountSettingsStore(root).read('acc_x')
    expect(s.lastRun).toBeNull()
    await rm(root, { recursive: true, force: true })
  })
})
