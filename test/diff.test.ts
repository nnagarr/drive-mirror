import { describe, it, expect } from 'vitest'
import { diffMirror } from '../src/core/diff'
import { localTree, driveTree, mirrorManifest, diffIo } from './helpers/fixtures'
import type { DiffInput, SyncPlan } from '../src/core/diff'
import type { SyncAction } from '../src/core/diff'

function plan(overrides: Partial<DiffInput> = {}): Promise<SyncPlan> {
  const local = overrides.local ?? localTree({})
  return diffMirror({
    local,
    drive: driveTree([]),
    manifest: mirrorManifest(),
    io: diffIo({}, local),
    mergeOnly: false,
    driveWins: false,
    ...overrides,
  })
}

function actions(p: SyncPlan): SyncAction[] {
  return p.steps.map((s) => s.action).filter((a): a is SyncAction => a !== null)
}

function kinds(p: SyncPlan): string[] {
  return actions(p).map((a) => a.kind)
}

describe('diffMirror — group C (never synced)', () => {
  it('downloads a Drive-only file (C1)', async () => {
    const p = await plan({
      drive: driveTree([{ id: 'D1', name: 'scene.psd', parentPath: 'renders' }]),
    })

    expect(kinds(p)).toEqual(['download'])
    const action = actions(p)[0]!
    expect(action.kind).toBe('download')
    if (action.kind === 'download') {
      expect(action.relPath).toBe('renders/scene.psd')
      expect(action.localPath).toBe('renders/scene.psd')
      expect(action.driveFileId).toBe('D1')
    }

    const op = p.steps[0]!.ops.find((o) => o.op === 'set-file')
    expect(op).toBeDefined()
    if (op && op.op === 'set-file') {
      expect(op.path).toBe('renders/scene.psd')
      expect(op.entry.driveFileId).toBe('D1')
    }
  })

  it('adopts an identical file with no transfer (C2)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'same' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'same' }]),
    })

    expect(kinds(p)).toEqual([])
    // The file is recorded so the next run knows about it, but nothing moves.
    const op = p.steps[0]?.ops.find((o) => o.op === 'set-file')
    expect(op).toBeDefined()
  })

  it('replaces Drive content with the local copy when they differ (C3)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'local' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'drive' }]),
    })

    expect(kinds(p)).toEqual(['replace-content'])
    const action = actions(p)[0]!
    if (action.kind === 'replace-content') {
      expect(action.driveFileId).toBe('D1')
      expect(action.md5).toBe('local')
    }
  })

  it('never trashes anything in group C', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd' }]),
    })
    expect(kinds(p)).not.toContain('trash')
  })
})

describe('diffMirror — group E (local-only)', () => {
  it('uploads a local-only file (E1)', async () => {
    const p = await plan({
      local: localTree({ 'new.psd': { md5: 'm1', size: 10 } }),
    })

    expect(kinds(p)).toEqual(['upload'])
    const action = actions(p)[0]!
    if (action.kind === 'upload') {
      expect(action.relPath).toBe('new.psd')
      expect(action.localPath).toBe('new.psd')
      expect(action.md5).toBe('m1')
      expect(action.size).toBe(10)
    }
  })

  it('records a live entry for the uploaded file', async () => {
    const p = await plan({ local: localTree({ 'new.psd': { md5: 'm1' } }) })
    const op = p.steps[0]!.ops.find((o) => o.op === 'set-file')
    expect(op).toBeDefined()
    if (op && op.op === 'set-file') {
      expect(op.path).toBe('new.psd')
      expect(op.entry.driveMd5).toBeNull()
      expect(op.entry.localMd5).toBe('m1')
    }
  })

  it('uploads a local-only file even when another path has a retired record', async () => {
    const p = await plan({
      local: localTree({ 'new.psd': { md5: 'm1' } }),
      manifest: mirrorManifest(
        {},
        {
          'DOLD': {
            path: 'other.psd',
            state: 'trashed',
            at: '2026-10-20T00:00:00.000Z',
            md5: 'm0',
            driveMimeType: 'application/octet-stream',
            localPath: null,
          },
        },
      ),
    })

    expect(kinds(p)).toEqual(['upload'])
  })
})

describe('diffMirror — dispatch pre-gates', () => {
  it('reports and skips an ambiguous Drive path', async () => {
    const p = await plan({
      drive: driveTree([
        { id: 'A', name: 'a.psd' },
        { id: 'B', name: 'a.psd' },
      ]),
    })

    expect(kinds(p)).toEqual([])
    expect(p.reports.map((r) => r.code)).toContain('ambiguous')
  })

  it('reports and skips an unrepresentable Drive path', async () => {
    const p = await plan({
      drive: driveTree([{ id: 'D1', name: 'a:b.psd' }]),
    })

    expect(kinds(p)).toEqual([])
    expect(p.reports.map((r) => r.code)).toContain('unrepresentable')
  })

  it('skips an unreadable local path entirely', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'unknown' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd' }]),
    })

    expect(kinds(p)).toEqual([])
  })

  it('does not upload a local file that is a stale export of a retired native file', async () => {
    // A stale export is a derived artifact of a document the app no longer
    // tracks, not user content. It is never uploaded.
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'm1' } }),
      manifest: mirrorManifest(
        {},
        {
          D1: {
            path: 'budget',
            state: 'gone',
            at: '2026-10-20T00:00:00.000Z',
            md5: 'm0',
            driveMimeType: 'application/vnd.google-apps.spreadsheet',
            localPath: 'budget.csv',
          },
        },
      ),
    })

    expect(kinds(p)).not.toContain('upload')
  })
})
