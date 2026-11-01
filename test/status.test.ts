import { describe, it, expect } from 'vitest'
import type { AppSettings, AccountSummary } from '../src/main/settings'
import type { AppState, MirrorCard, RunSummary } from '../src/main/ipc'
import { verdict, rowStatus, folderNeedsYou } from '../src/renderer/status'

const rt = () => '2 minutes ago'

const aSummary = (overrides: Partial<AccountSummary> = {}): AccountSummary => ({
  id: 'a1',
  email: 'user@example.com',
  addedAt: '2026-01-01T00:00:00Z',
  signedIn: true,
  mirrorCount: 1,
  hasNotice: false,
  ...overrides,
})

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  clientId: 'id',
  accounts: [aSummary()],
  currentAccountId: 'a1',
  clientSecretSet: true,
  guardThreshold: 5,
  startWithWindows: false,
  extraBackupPath: null,
  pendingNotice: null,
  ...overrides,
})

const card = (overrides: Partial<MirrorCard> = {}): MirrorCard => ({
  name: 'Documents',
  localRoot: 'C:/Users/test/Documents',
  drivePath: 'My Drive/Documents',
  fileCount: 100,
  lastSyncedAt: null,
  status: 'idle',
  enabled: true,
  counts: { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 0 },
  recovered: [],
  ...overrides,
})

const state = (overrides: Partial<AppState> = {}): AppState => ({
  accountId: 'a1',
  mirrors: [],
  running: false,
  phase: 'idle',
  lastRun: null,
  accountEmail: 'user@example.com',
  needsAuth: false,
  ...overrides,
})

const summary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  startedAt: '2026-10-24T10:00:00Z',
  finishedAt: '2026-10-24T10:02:00Z',
  uploaded: 0,
  updated: 0,
  downloaded: 0,
  trashed: 0,
  errors: 0,
  mirrors: [],
  changed: [],
  reports: [],
  ...overrides,
})

describe('verdict', () => {
  it('setup: credentials missing', () => {
    const v = verdict({
      settings: settings({ clientId: '', clientSecretSet: false }),
      state: state(),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('setup')
    expect(v.sentence).toBe('Finish setting up Google.')
    expect(v.action).toBe('Finish setup')
    expect(v.dot).toBe('danger')
  })

  it('connect: no accounts configured', () => {
    const v = verdict({
      settings: settings({ accounts: [], currentAccountId: null }),
      state: state(),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('connect')
    expect(v.sentence).toBe('Connect your Google account.')
    expect(v.action).toBe('Connect account')
  })

  it('choose: accounts exist, none current', () => {
    const v = verdict({
      settings: settings({ currentAccountId: null }),
      state: state({ accountEmail: null, needsAuth: false }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('choose')
    expect(v.sentence).toBe('Choose an account.')
    expect(v.action).toBe('Choose account')
  })

  it('signed out: needsAuth', () => {
    const v = verdict({
      settings: settings(),
      state: state({ needsAuth: true }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('signedout')
    expect(v.sentence).toBe('This account is signed out.')
    expect(v.action).toBe('Sign in')
    expect(v.dot).toBe('danger')
  })

  it('syncing: running', () => {
    const v = verdict({
      settings: settings(),
      state: state({ running: true, phase: 'uploads' }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('syncing')
    expect(v.sentence).toBe('Backing up now.')
    expect(v.action).toBe('Syncing…')
  })

  it('waiting: phase waiting', () => {
    const v = verdict({
      settings: settings(),
      state: state({ running: false, phase: 'waiting' }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('waiting')
    expect(v.sentence).toBe('Waiting for the other account.')
    expect(v.action).toBe('Waiting…')
  })

  it('empty: no mirrors', () => {
    const v = verdict({
      settings: settings(),
      state: state({ mirrors: [] }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('empty')
    expect(v.sentence).toBe('Nothing is mirrored yet.')
    expect(v.action).toBe('Add a folder')
  })

  it('paused: all mirrors paused', () => {
    const v = verdict({
      settings: settings(),
      state: state({
        mirrors: [card({ enabled: false }), card({ name: 'Music', enabled: false })],
      }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('paused')
    expect(v.sentence).toBe('Everything is paused.')
    expect(v.action).toBe('Review paused')
  })

  it('attention: active guard', () => {
    const v = verdict({
      settings: settings(),
      state: state({ mirrors: [card()] }),
      summary: summary(),
      guard: { mirror: 'Documents', reason: 'volume-changed', message: 'Photos was stopped.', canOverride: true },
      relativeTime: rt,
    })
    expect(v.kind).toBe('attention')
    expect(v.sentence).toBe('1 folder needs you.')
    expect(v.action).toBe('Review')
    expect(v.dot).toBe('attention')
  })

  it('attention: blocked recovered file', () => {
    const v = verdict({
      settings: settings(),
      state: state({
        mirrors: [card({ recovered: [{ driveFileId: 'f1', path: 'x', at: 't', blocked: 'There is already a file at that path.' }] })],
      }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('attention')
    expect(v.sentence).toBe('1 folder needs you.')
  })

  it('error: last run had errors', () => {
    const v = verdict({
      settings: settings(),
      state: state({ mirrors: [card()] }),
      summary: summary({ errors: 3, mirrors: [{ name: 'Documents', counts: { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 3 } }] }),
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('error')
    expect(v.sentence).toBe('The last backup hit a problem.')
    expect(v.action).toBe('View details')
    expect(v.dot).toBe('danger')
    expect(v.subline).toContain('3 files could not be uploaded')
  })

  it('first backup: no last run, nothing ever synced', () => {
    const v = verdict({
      settings: settings(),
      state: state({ mirrors: [card({ lastSyncedAt: null })] }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('first')
    expect(v.sentence).toBe('Ready for the first backup.')
    expect(v.action).toBe('Sync now')
  })

  it('last checked: no last run, but folders have synced before (migration)', () => {
    const v = verdict({
      settings: settings(),
      state: state({ mirrors: [card({ lastSyncedAt: '2026-10-21T00:00:00Z' })] }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('lastchecked')
    expect(v.sentence).toBe('Last checked 2 minutes ago.')
    expect(v.action).toBe('Sync now')
    expect(v.dot).toBe('sage')
  })

  it('safe: last run present, nothing wrong', () => {
    const v = verdict({
      settings: settings(),
      state: state({
        mirrors: [card({ lastSyncedAt: '2026-10-24T10:02:00Z', fileCount: 6771 })],
        lastRun: summary({ finishedAt: '2026-10-24T10:02:00Z', uploaded: 16, updated: 1 }),
      }),
      summary: null,
      guard: null,
      relativeTime: rt,
    })
    expect(v.kind).toBe('safe')
    expect(v.sentence).toBe('Everything is backed up.')
    expect(v.action).toBe('Sync now')
    expect(v.dot).toBe('safe')
    expect(v.subline).toContain('6,771 files')
  })
})

describe('rowStatus', () => {
  it('paused', () => expect(rowStatus(card({ enabled: false }))).toBe('paused'))
  it('syncing', () => expect(rowStatus(card({ status: 'syncing' }))).toBe('syncing'))
  it('needs-you: skipped', () => expect(rowStatus(card({ status: 'skipped' }))).toBe('needs-you'))
  it('needs-you: attention', () => expect(rowStatus(card({ status: 'attention' }))).toBe('needs-you'))
  it('error: status error', () => expect(rowStatus(card({ status: 'error' }))).toBe('error'))
  it('error: counts.errors > 0', () => expect(rowStatus(card({ counts: { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 2 } }))).toBe('error'))
  it('not synced yet: idle, no lastSyncedAt', () => expect(rowStatus(card({ lastSyncedAt: null }))).toBe('not-synced'))
  it('up to date: idle, lastSyncedAt set', () => expect(rowStatus(card({ lastSyncedAt: 't' }))).toBe('up-to-date'))
  it('paused wins over error', () => expect(rowStatus(card({ enabled: false, status: 'error', counts: { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 2 } }))).toBe('paused'))
})

describe('folderNeedsYou', () => {
  it('skipped', () => expect(folderNeedsYou(card({ status: 'skipped' }))).toBe(true))
  it('blocked recovered', () => expect(folderNeedsYou(card({ recovered: [{ driveFileId: 'f1', path: 'x', at: 't', blocked: 'nope' }] }))).toBe(true))
  it('errors', () => expect(folderNeedsYou(card({ counts: { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 1 } }))).toBe(true))
  it('up to date', () => expect(folderNeedsYou(card({ status: 'idle', lastSyncedAt: 't' }))).toBe(false))
})
