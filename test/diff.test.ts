import { describe, it, expect } from 'vitest'
import { diffMirror } from '../src/core/diff'
import { localTree, driveTree, mirrorManifest, diffIo, retired } from './helpers/fixtures'
import type { DiffInput, SyncPlan } from '../src/core/diff'
import type { DiffIo, SyncAction } from '../src/core/diff'
import type { RetiredRecord, RetiredState } from '../src/core/types'

/** Overrides accepted by the `plan` helper. `io` is merged, not substituted. */
type PlanOverrides = Omit<Partial<DiffInput>, 'io'> & {
  io?: Partial<DiffIo>
}

function plan(overrides: PlanOverrides = {}): Promise<SyncPlan> {
  const local = overrides.local ?? localTree({})
  // The io double always resolves hashes against the local tree, even when
  // a test overrides part of it (a probe, say).
  const { io: ioOverride, ...rest } = overrides
  const io = diffIo(ioOverride ?? {}, local)
  return diffMirror({
    local,
    drive: driveTree([]),
    manifest: mirrorManifest(),
    mergeOnly: false,
    driveWins: false,
    ...rest,
    io,
  })
}

function actions(p: SyncPlan): SyncAction[] {
  return p.steps.map((s) => s.action).filter((a): a is SyncAction => a !== null)
}

function kinds(p: SyncPlan): string[] {
  return actions(p).map((a) => a.kind)
}

describe('diffMirror --- group C (never synced)', () => {
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

describe('diffMirror --- group E (local-only)', () => {
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
          'DOLD': retired('DOLD', 'other.psd', 'trashed'),
        },
      ),
    })

    expect(kinds(p)).toEqual(['upload'])
  })
})

describe('diffMirror --- group B (live manifest entry)', () => {
  it('trashes the Drive copy when the local file is deleted (B0)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1' } }),
    })

    const trash = actions(p).filter((a) => a.kind === 'trash')
    expect(trash).toHaveLength(1)
    const action = trash[0]!
    if (action.kind === 'trash') {
      expect(action.driveFileId).toBe('D1')
      expect(action.relPath).toBe('a.psd')
    }

    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    expect(retired).toBeDefined()
    if (retired && retired.op === 'set-retired') {
      expect(retired.id).toBe('D1')
      expect(retired.record.state).toBe('trashed')
    }
    expect(p.steps.flatMap((s) => s.ops).some((o) => o.op === 'del-file' && o.path === 'a.psd')).toBe(true)
  })

  it('never trashes when the local path is unreadable (B0 guard)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'unknown' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1' } }),
    })

    expect(kinds(p)).not.toContain('trash')
  })

  it('does not trash during a rebase (B0 mergeOnly guard)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1' } }),
      mergeOnly: true,
    })

    expect(kinds(p)).not.toContain('trash')
    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    expect(retired).toBeUndefined()
  })

  it('uploads local changes in place keeping the Drive id (B1 local-changed)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
    })

    expect(kinds(p)).toEqual(['replace-content'])
    const action = actions(p)[0]!
    if (action.kind === 'replace-content') {
      expect(action.driveFileId).toBe('D1')
      expect(action.md5).toBe('m2')
    }
  })

  it('downloads Drive changes (B1 drive-changed)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm2' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
    })

    expect(kinds(p)).toEqual(['download'])
  })

  it('uploads local changes when both changed (B1 both-changed)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm3' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
    })

    expect(kinds(p)).toEqual(['replace-content'])
  })

  it('does nothing when neither side changed (B1 neither)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
    })

    expect(kinds(p)).toEqual([])
  })

  it('downloads the Drive version when driveWins and both changed', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm3' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
      driveWins: true,
    })

    expect(kinds(p)).toEqual(['download'])
  })

  it('re-adopts a Drive file that was merely missed by the listing (B3 alive-same-path)', async () => {
    // The listing did not return the file, but a probe of its id finds it
    // alive at the same path. It must be re-adopted, not re-uploaded.
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
      io: { probe: async () => ({ status: 'alive', currentPath: 'a.psd' }) },
    })

    expect(kinds(p)).toEqual([])
    const op = p.steps[0]?.ops.find((o) => o.op === 'set-file')
    expect(op).toBeDefined()
  })

  it('retires the tracked id as moved when the Drive file moved (B2)', async () => {
    // A different Drive file now occupies the path, and a probe of the
    // tracked id finds it alive somewhere else.
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([{ id: 'D2', name: 'a.psd', md5: 'm2' }]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
      io: { probe: async () => ({ status: 'alive', currentPath: 'b.psd' }) },
    })

    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    expect(retired).toBeDefined()
    if (retired && retired.op === 'set-retired') {
      expect(retired.id).toBe('D1')
      expect(retired.record.state).toBe('moved')
    }
  })

  it('reports an unbacked-up file when someone else trashed it (B3)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
      io: { probe: async () => ({ status: 'trashed' }) },
    })

    expect(kinds(p)).not.toContain('upload')
    expect(p.reports.map((r) => r.code)).toContain('unbacked-up')
    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (retired && retired.op === 'set-retired') {
      expect(retired.record.state).toBe('trashed-externally')
    }
  })

  it('uploads a new Drive file when the old one is gone for good (B3 404)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
      io: { probe: async () => ({ status: 'missing' }) },
    })

    expect(kinds(p)).toEqual(['upload'])
  })

  it('retires both sides when the file is gone from both (B4)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([]),
      manifest: mirrorManifest({ 'a.psd': { driveFileId: 'D1', driveMd5: 'm1', localMd5: 'm1' } }),
    })

    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (retired && retired.op === 'set-retired') {
      expect(retired.record.state).toBe('gone')
    }
    expect(p.steps.flatMap((s) => s.ops).some((o) => o.op === 'del-file')).toBe(true)
  })
})

describe('diffMirror --- group D (retired path)', () => {
  const retiredTrashed = {
    D1: retired('D1', 'a.psd', 'trashed'),
  }

  it('restores a trashed Drive file and replaces its content (D1)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({}, retiredTrashed),
      io: { probe: async () => ({ status: 'trashed' }) },
    })

    expect(kinds(p)).toContain('untrash')
    const untrash = actions(p).find((a) => a.kind === 'untrash')
    if (untrash && untrash.kind === 'untrash') {
      expect(untrash.driveFileId).toBe('D1')
    }

    // The restored file must also receive the local content, keeping the
    // same Drive file id.
    expect(kinds(p)).toContain('replace-content')
    const replace = actions(p).find((a) => a.kind === 'replace-content')
    if (replace && replace.kind === 'replace-content') {
      expect(replace.driveFileId).toBe('D1')
      expect(replace.md5).toBe('m1')
    }

    const ops = p.steps.flatMap((s) => s.ops)
    expect(ops.some((o) => o.op === 'set-file' && o.path === 'a.psd')).toBe(true)
    const retired = ops.find((o) => o.op === 'set-retired')
    if (retired && retired.op === 'set-retired') {
      expect(retired.id).toBe('D1')
      expect(retired.record.state).toBe('resynced')
    }
  })

  it('uploads a new file when the trashed Drive copy was purged (D1 404)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({}, retiredTrashed),
      io: { probe: async () => ({ status: 'missing' }) },
    })

    expect(kinds(p)).toContain('upload')
    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (retired && retired.op === 'set-retired') {
      expect(retired.record.state).toBe('purged')
    }
  })

  it('replaces content in place when the file was restored but not moved (D1 alive same path)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({}, retiredTrashed),
      io: { probe: async () => ({ status: 'alive', currentPath: 'a.psd' }) },
    })

    expect(kinds(p)).not.toContain('untrash')
    expect(kinds(p)).toContain('replace-content')
    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (retired && retired.op === 'set-retired') {
      expect(retired.record.state).toBe('resynced')
    }
  })

  it('uploads a new file when the file was restored AND moved (D1 alive moved)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({}, retiredTrashed),
      io: { probe: async () => ({ status: 'alive', currentPath: 'b.psd' }) },
    })

    expect(kinds(p)).toContain('upload')
    const retired = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (retired && retired.op === 'set-retired') {
      expect(retired.record.state).toBe('moved')
    }
  })

  it('does not re-upload a file someone else trashed (D2)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest(
        {},
        {
          D1: retired('D1', 'a.psd', 'trashed-externally'),
        },
      ),
    })

    expect(kinds(p)).not.toContain('upload')
    expect(p.reports.map((r) => r.code)).toContain('unbacked-up')
  })

  it('uploads a new file when the old Drive copy is gone (D3)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest(
        {},
        {
          D1: retired('D1', 'a.psd', 'gone'),
        },
      ),
    })

    expect(kinds(p)).toContain('upload')
  })

  it('uploads a new file for a rebased path (D4)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([]),
      manifest: mirrorManifest(
        {},
        {
          D1: retired('D1', 'a.psd', 'rebased', { prevLocalMd5: 'm0' }),
        },
      ),
    })

    expect(kinds(p)).toContain('upload')
  })

  it('does nothing when the path is absent locally (D5)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([]),
      manifest: mirrorManifest({}, retiredTrashed),
    })

    expect(kinds(p)).toEqual([])
  })
})

describe('diffMirror --- group R (retired id)', () => {
  const retiredFor = (state: RetiredState, extra: Partial<RetiredRecord> = {}) => ({
    D1: retired('D1', 'a.psd', state, extra),
  })

  it('does not download a file restored from Drive Trash (R1)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({}, retiredFor('trashed')),
    })

    expect(kinds(p)).not.toContain('download')
    expect(p.reports.map((r) => r.code)).toContain('restored-from-trash')
    const rec = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (rec && rec.op === 'set-retired') {
      expect(rec.id).toBe('D1')
      expect(rec.record.state).toBe('restored')
    }
  })

  it('leaves a restored file alone forever (R2)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({}, retiredFor('restored')),
    })

    expect(kinds(p)).toEqual([])
    expect(p.reports).toEqual([])
  })

  it('reports a conflict when a restored file collides with a local file (R3)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({}, retiredFor('restored')),
    })

    expect(kinds(p)).toEqual([])
    expect(p.reports.length).toBeGreaterThan(0)
  })

  it('leaves an impossible gone/purged record alone (R4)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({}, retiredFor('gone')),
    })

    expect(kinds(p)).toEqual([])
    expect(p.reports.map((r) => r.code)).toContain('anomaly')
  })

  it('downloads a moved file that is now at this path (R5)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({}, retiredFor('moved')),
    })

    expect(kinds(p)).toEqual(['download'])
    const rec = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (rec && rec.op === 'set-retired') {
      expect(rec.id).toBe('D1')
      expect(rec.record.state).toBe('resynced')
    }
  })

  it('replaces content in place for a moved file with a local collision (R6)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({}, retiredFor('moved')),
    })

    expect(kinds(p)).toEqual(['replace-content'])
    const action = actions(p)[0]!
    if (action.kind === 'replace-content') {
      expect(action.driveFileId).toBe('D1')
    }
  })

  it('does not download a rebased path that was empty locally (R8)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': 'absent' }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest({}, retiredFor('rebased', { prevLocalMd5: 'm1' })),
    })

    expect(kinds(p)).not.toContain('download')
    expect(p.reports.map((r) => r.code)).toContain('rebased-not-downloaded')
    // The record keeps its state: it is the proof that the file was deleted
    // before the volume changed.
    const rec = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (rec && rec.op === 'set-retired') {
      expect(rec.record.state).toBe('rebased')
    }
  })

  it('adopts a rebased file that came back unchanged (R9)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm1' }]),
      manifest: mirrorManifest(
        {},
        retiredFor('rebased', { prevLocalMd5: 'm1', md5: 'm1' }),
      ),
    })

    expect(kinds(p)).toEqual([])
    const ops = p.steps.flatMap((s) => s.ops)
    expect(ops.some((o) => o.op === 'set-file')).toBe(true)
    const rec = ops.find((o) => o.op === 'set-retired')
    if (rec && rec.op === 'set-retired') {
      expect(rec.record.state).toBe('resynced')
    }
  })

  it('reconciles a rebased file that changed on Drive (R10)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm1' } }),
      drive: driveTree([{ id: 'D1', name: 'a.psd', md5: 'm2' }]),
      manifest: mirrorManifest({}, retiredFor('rebased', { prevLocalMd5: 'm1' })),
      driveWins: true,
    })

    expect(kinds(p)).toEqual(['download'])
    const rec = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    if (rec && rec.op === 'set-retired') {
      expect(rec.record.state).toBe('resynced')
    }
  })

  it('never trashes or uploads over a Google-native file in group R', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([
        {
          id: 'D1',
          name: 'a.psd',
          mimeType: 'application/vnd.google-apps.document',
          md5: 'm1',
        },
      ]),
      manifest: mirrorManifest(
        {},
        {
          D1: retired('D1', 'a.psd', 'trashed', { md5: 'm1', driveMimeType: 'application/vnd.google-apps.document' }),
        },
      ),
    })

    expect(kinds(p)).not.toContain('trash')
    expect(kinds(p)).not.toContain('replace-content')
  })

  it('never uploads over a Google-native file that moved (R5/R6 guard)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([
        {
          id: 'D1',
          name: 'a.psd',
          mimeType: 'application/vnd.google-apps.document',
          md5: 'm1',
        },
      ]),
      manifest: mirrorManifest(
        {},
        {
          D1: retired('D1', 'a.psd', 'moved', { md5: 'm1', driveMimeType: 'application/vnd.google-apps.document' }),
        },
      ),
    })

    expect(kinds(p)).not.toContain('replace-content')
    expect(kinds(p)).not.toContain('trash')
  })

  it('never uploads over a Google-native file that changed after a rebase (R10 guard)', async () => {
    const p = await plan({
      local: localTree({ 'a.psd': { md5: 'm2' } }),
      drive: driveTree([
        {
          id: 'D1',
          name: 'a.psd',
          mimeType: 'application/vnd.google-apps.document',
          md5: 'm3',
        },
      ]),
      manifest: mirrorManifest(
        {},
        {
          D1: retired('D1', 'a.psd', 'rebased', { md5: 'm1', driveMimeType: 'application/vnd.google-apps.document', prevLocalMd5: 'm1' }),
        },
      ),
    })

    expect(kinds(p)).not.toContain('replace-content')
    expect(kinds(p)).not.toContain('trash')
  })
})

describe('diffMirror --- group N (Google-native)', () => {
  const SHEET = 'application/vnd.google-apps.spreadsheet'
  const DOC = 'application/vnd.google-apps.document'

  it('exports a first-sight native file to its planned path (N1)', async () => {
    const p = await plan({
      drive: driveTree([{ id: 'D1', name: 'Budget', mimeType: SHEET }]),
      io: { exportNative: async () => Buffer.from('a,b,c') },
    })

    expect(kinds(p)).toEqual(['export-native'])
    const action = actions(p)[0]!
    if (action.kind === 'export-native') {
      expect(action.relPath).toBe('budget')
      expect(action.localPath).toBe('budget.csv')
      expect(action.exportMime).toBe('text/csv')
      expect(action.driveFileId).toBe('D1')
    }
  })

  it('exports beside an occupied path and uploads the local file separately (N1)', async () => {
    // The user has Budget.csv on E: AND a Google Sheet named Budget on
    // Drive. The Sheet's export cannot be Budget.csv -- that is the user's
    // own file -- so it goes beside it, and the user's file uploads as
    // itself. Neither overwrites the other.
    const bytes = Buffer.from('a,b,c')
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([{ id: 'D1', name: 'Budget', mimeType: SHEET }]),
      io: {
        exportNative: async () => bytes,
        readLocalBytes: async () => bytes,
      },
    })

    const exported = actions(p).filter((a) => a.kind === 'export-native')
    expect(exported).toHaveLength(1)
    if (exported[0]!.kind === 'export-native') {
      expect(exported[0]!.localPath).not.toBe('budget.csv')
      expect(exported[0]!.localPath).toBe('budget (export 1).csv')
    }
  })

  it('adopts an existing export without writing it when the bytes match (N1 adopt)', async () => {
    // The manifest already tracks the native file and its export path holds
    // exactly the bytes a fresh export would produce: there is nothing to
    // write.
    const bytes = Buffer.from('a,b,c')
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([
        { id: 'D1', name: 'Budget', mimeType: SHEET, driveModifiedTime: 't1' },
      ]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
          driveModifiedTime: 't1',
        },
      }),
      io: {
        exportNative: async () => bytes,
        readLocalBytes: async () => bytes,
      },
    })

    expect(kinds(p)).not.toContain('export-native')
    const op = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-file')
    expect(op).toBeDefined()
    if (op && op.op === 'set-file') {
      expect(op.entry.localPath).toBe('budget.csv')
    }
  })

  it('never overwrites an unrelated local file at the natural export path (N1)', async () => {
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([{ id: 'D1', name: 'Budget', mimeType: SHEET }]),
      io: {
        exportNative: async () => Buffer.from('fresh'),
        readLocalBytes: async () => Buffer.from('unrelated'),
      },
    })

    // The planner must have chosen a path that is not the occupied one.
    const action = actions(p).find((a) => a.kind === 'export-native')
    expect(action).toBeDefined()
    if (action && action.kind === 'export-native') {
      expect(action.localPath).not.toBe('budget.csv')
    }
  })

  it('re-exports when the Drive document changed (N2)', async () => {
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([
        { id: 'D1', name: 'Budget', mimeType: SHEET, driveModifiedTime: 't2' },
      ]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
          driveModifiedTime: 't1',
        },
      }),
      io: { exportNative: async () => Buffer.from('fresh') },
    })

    expect(kinds(p)).toEqual(['export-native'])
  })

  it('archives a user-edited export before overwriting it (N2)', async () => {
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([
        { id: 'D1', name: 'Budget', mimeType: SHEET, driveModifiedTime: 't2' },
      ]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
          driveModifiedTime: 't1',
        },
      }),
      io: {
        exportNative: async () => Buffer.from('fresh'),
        readLocalBytes: async () => Buffer.from('user-edited'),
      },
    })

    const action = actions(p).find((a) => a.kind === 'export-native')
    expect(action).toBeDefined()
    if (action && action.kind === 'export-native') {
      // The executor must archive the user's edited copy before overwriting.
      expect(action.archiveLocalFirst).toBe(true)
    }
  })

  it('regenerates a deleted export without trashing the Google Doc (N3)', async () => {
    const p = await plan({
      local: localTree({}),
      drive: driveTree([{ id: 'D1', name: 'Budget', mimeType: SHEET }]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
        },
      }),
      io: { exportNative: async () => Buffer.from('fresh') },
    })

    expect(kinds(p)).toEqual(['export-native'])
    expect(kinds(p)).not.toContain('trash')
  })

  it('does nothing when the native file is unchanged and the export exists (N4)', async () => {
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([
        { id: 'D1', name: 'Budget', mimeType: SHEET, driveModifiedTime: 't1' },
      ]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
          driveModifiedTime: 't1',
        },
      }),
    })

    expect(kinds(p)).toEqual([])
  })

  it('retires the old id and exports the replacement (N5)', async () => {
    const p = await plan({
      local: localTree({}),
      drive: driveTree([
        { id: 'D2', name: 'Budget', mimeType: SHEET, driveModifiedTime: 't2' },
      ]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
          driveModifiedTime: 't1',
        },
      }),
      io: {
        exportNative: async () => Buffer.from('fresh'),
        probe: async () => ({ status: 'missing' }),
      },
    })

    const rec = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    expect(rec).toBeDefined()
    if (rec && rec.op === 'set-retired') {
      expect(rec.id).toBe('D1')
    }
    expect(kinds(p)).toContain('export-native')
  })

  it('never uploads over or trashes a native file (N6/N7)', async () => {
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
        },
      }),
      io: {
        exportNative: async () => Buffer.from('fresh'),
        probe: async () => ({ status: 'trashed' }),
      },
    })

    expect(kinds(p)).not.toContain('upload')
    expect(kinds(p)).not.toContain('replace-content')
    expect(kinds(p)).not.toContain('trash')
  })

  it('re-adopts a native file that was merely missed by the listing (N8)', async () => {
    const p = await plan({
      local: localTree({ 'budget.csv': { md5: 'x' } }),
      drive: driveTree([]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
        },
      }),
      io: {
        probe: async () => ({ status: 'alive', currentPath: 'budget' }),
      },
    })

    expect(kinds(p)).not.toContain('export-native')
    const op = p.steps[0]?.ops.find((o) => o.op === 'set-file')
    expect(op).toBeDefined()
  })

  it('retires a native file that was moved on Drive (N9)', async () => {
    const p = await plan({
      local: localTree({}),
      drive: driveTree([]),
      manifest: mirrorManifest({
        budget: {
          driveFileId: 'D1',
          driveMimeType: SHEET,
          exportMime: 'text/csv',
          localPath: 'budget.csv',
        },
      }),
      io: {
        probe: async () => ({ status: 'alive', currentPath: 'archive/budget' }),
      },
    })

    const rec = p.steps.flatMap((s) => s.ops).find((o) => o.op === 'set-retired')
    expect(rec).toBeDefined()
    if (rec && rec.op === 'set-retired') {
      expect(rec.record.state).toBe('moved')
    }
  })

  it('reports a native type that has no export (N11)', async () => {
    const p = await plan({
      drive: driveTree([
        { id: 'D1', name: 'Form', mimeType: 'application/vnd.google-apps.form' },
      ]),
    })

    expect(kinds(p)).toEqual([])
    expect(p.reports.map((r) => r.code)).toContain('native-no-export')
  })
})

describe('diffMirror --- dispatch pre-gates', () => {
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
          D1: retired('D1', 'budget', 'gone', {
            md5: 'm0',
            driveMimeType: 'application/vnd.google-apps.spreadsheet',
            localPath: 'budget.csv',
          }),
        },
      ),
    })

    expect(kinds(p)).not.toContain('upload')
  })
})
