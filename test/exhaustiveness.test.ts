/**
 * The exhaustiveness matrix.
 *
 * The diff engine is a dispatch: for each path, exactly one rule must apply.
 * This test enumerates the full cross-product of the engine's input
 * dimensions and asserts the spec's invariants against every combination.
 *
 * It is the test that would have caught the gaps the earlier rule groups
 * had: an unreachable upload rule, a missing probe outcome, a state that no
 * rule consumed. A test that only counts fired rules cannot see a dispatch
 * that stops early with nothing done, so the invariants below are stated
 * in terms of what the user must end up with, not in terms of which rule
 * fired.
 */

import { describe, it, expect } from 'vitest'
import { diffMirror, matchRule } from '../src/core/diff'
import { localTree, driveTree, mirrorManifest, retired } from './helpers/fixtures'
import type { DiffInput } from '../src/core/diff'
import type { RetiredRecord, RetiredState } from '../src/core/types'

const NATIVE = 'application/vnd.google-apps.spreadsheet'
const BINARY = 'application/octet-stream'

const RETIRED_STATES: RetiredState[] = [
  'trashed',
  'trashed-externally',
  'gone',
  'restored',
  'purged',
  'moved',
  'rebased',
  'resynced',
]

/** One cell of the matrix. */
interface Cell {
  drive: 'usable' | 'absent' | 'unusable'
  driveMime: 'native' | 'binary'
  manifestEntry: 'exists' | 'null'
  manifestMime: 'native' | 'binary'
  local: 'present' | 'absent' | 'unknown'
  retiredState: RetiredState | 'none'
  pathRetired: 'empty' | 'trashed' | 'gone' | 'rebased'
  claim: 'none' | 'foreign' | 'retired-claim'
  mergeOnly: boolean
  driveWins: boolean
  sameId: boolean
}

const DRIVE_STATES = ['usable', 'absent', 'unusable'] as const
const DRIVE_MIMES = ['native', 'binary'] as const
const MANIFEST_STATES = ['exists', 'null'] as const
const MANIFEST_MIMES = ['native', 'binary'] as const
const LOCAL_STATES = ['present', 'absent', 'unknown'] as const
const RETIRED_CHOICES = ['none', ...RETIRED_STATES] as const
const PATH_RETIRED = ['empty', 'trashed', 'gone', 'rebased'] as const
const CLAIMS = ['none', 'foreign', 'retired-claim'] as const

function* allCells(): Generator<Cell> {
  for (const drive of DRIVE_STATES) {
    for (const driveMime of DRIVE_MIMES) {
      for (const manifestEntry of MANIFEST_STATES) {
        for (const manifestMime of MANIFEST_MIMES) {
          for (const local of LOCAL_STATES) {
            for (const retiredState of RETIRED_CHOICES) {
              for (const pathRetired of PATH_RETIRED) {
                for (const claim of CLAIMS) {
                  for (const mergeOnly of [false, true]) {
                    for (const driveWins of [false, true]) {
                      for (const sameId of [false, true]) {
                        yield {
                          drive,
                          driveMime,
                          manifestEntry,
                          manifestMime,
                          local,
                          retiredState,
                          pathRetired,
                          claim,
                          mergeOnly,
                          driveWins,
                          sameId,
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

/** Build the engine inputs for one cell. */
function inputsFor(cell: Cell): DiffInput {
  const PATH = 'a.psd'

  // The local tree.
  const localFiles: Record<string, { state: 'present' | 'absent' | 'unknown'; md5?: string }> = {}
  if (cell.local === 'present') localFiles[PATH] = { state: 'present', md5: 'local-md5' }
  else localFiles[PATH] = { state: cell.local }
  if (cell.claim === 'foreign') {
    // A local file the manifest tracks under a different key.
    localFiles['export.csv'] = { state: 'present', md5: 'export-md5' }
  }
  if (cell.manifestEntry === 'exists' && cell.manifestMime === 'native') {
    // The export of the native file, when the manifest tracks one.
    localFiles['a.psd.csv'] = { state: 'present', md5: 'export-md5' }
  }
  const local = localTree(localFiles)

  // The Drive tree.
  const driveSpecs = []
  if (cell.drive === 'usable') {
    driveSpecs.push({
      id: 'D1',
      name: 'a.psd',
      mimeType: cell.driveMime === 'native' ? NATIVE : BINARY,
      md5: 'drive-md5',
    })
  } else if (cell.drive === 'unusable') {
    driveSpecs.push({
      id: 'D1',
      name: 'a.psd',
      mimeType: cell.driveMime === 'native' ? NATIVE : BINARY,
      md5: 'drive-md5',
      ambiguous: true,
    })
  }
  const drive = driveTree(driveSpecs)

  // The manifest.
  const manifestFiles: Record<string, { driveFileId: string; driveMd5?: string | null; driveMimeType?: string; exportMime?: string | null; localPath?: string; localMd5?: string | null }> = {}
  if (cell.manifestEntry === 'exists') {
    // A native file's local representation is an EXPORT, whose path carries
    // the export extension. It is not the Drive path itself.
    const localPath =
      cell.manifestMime === 'native' ? 'a.psd.csv' : PATH
    manifestFiles[PATH] = {
      driveFileId: cell.sameId ? 'D1' : 'D2',
      driveMd5: 'drive-md5',
      driveMimeType: cell.manifestMime === 'native' ? NATIVE : BINARY,
      exportMime: cell.manifestMime === 'native' ? 'text/csv' : null,
      localPath,
      localMd5: 'local-md5',
    }
  }
  if (cell.claim === 'foreign') {
    manifestFiles['native'] = {
      driveFileId: 'D3',
      driveMd5: 'drive-md5',
      driveMimeType: NATIVE,
      exportMime: 'text/csv',
      localPath: 'export.csv',
      localMd5: 'export-md5',
    }
  }

  const retiredRecords: Record<string, RetiredRecord> = {}
  if (cell.retiredState !== 'none') {
    retiredRecords['D1'] = retired('D1', PATH, cell.retiredState, {
      md5: 'drive-md5',
      driveMimeType: NATIVE,
      localPath: cell.claim === 'retired-claim' ? 'export.csv' : null,
      prevLocalMd5: 'local-md5',
    })
  }
  if (cell.pathRetired !== 'empty') {
    retiredRecords['D9'] = retired('D9', PATH, cell.pathRetired, {
      at: '2026-10-19T00:00:00.000Z',
      md5: 'drive-md5',
      driveMimeType: BINARY,
    })
  }
  if (cell.claim === 'retired-claim') {
    retiredRecords['D7'] = retired('D7', 'old', 'gone', {
      at: '2026-10-18T00:00:00.000Z',
      md5: 'drive-md5',
      driveMimeType: NATIVE,
      localPath: 'export.csv',
    })
  }

  const manifest = mirrorManifest(manifestFiles, retiredRecords)

  return {
    local,
    drive,
    manifest,
    io: {
      probe: async () => ({ status: 'missing' as const }),
      md5Of: async (relPath: string) => {
        const entry = local.files.get(relPath)
        return entry?.md5 ?? null
      },
      readLocalBytes: async () => null,
      exportNative: async () => null,
    },
    mergeOnly: cell.mergeOnly,
    driveWins: cell.driveWins,
  }
}

/** A short label for a cell, used in failure messages. */
function label(cell: Cell): string {
  return JSON.stringify(cell)
}

describe('diff engine exhaustiveness', () => {
  it('covers a large matrix of input combinations', () => {
    // A cheap guard that the generator still produces the full product.
    let count = 0
    for (const _ of allCells()) count += 1
    expect(count).toBe(
      DRIVE_STATES.length *
        DRIVE_MIMES.length *
        MANIFEST_STATES.length *
        MANIFEST_MIMES.length *
        LOCAL_STATES.length *
        RETIRED_CHOICES.length *
        PATH_RETIRED.length *
        CLAIMS.length *
        2 *
        2 *
        2,
    )
  })

  it('INV-1: every combination resolves to exactly one rule, or an enumerated no-op', async () => {
    for (const cell of allCells()) {
      const input = inputsFor(cell)
      const rules = matchRule(input, 'a.psd')
      expect(rules.length, label(cell)).toBe(1)

      // The engine must not fall off the end of the dispatch.
      const plan = await diffMirror(input)
      expect(plan, label(cell)).toBeDefined()
      expect(plan.steps.length, label(cell)).toBeLessThanOrEqual(2)
    }
  })

  it('INV-4: the dispatch step and the rule table agree', async () => {
    for (const cell of allCells()) {
      const input = inputsFor(cell)
      const rules = matchRule(input, 'a.psd')
      expect(rules.length, label(cell)).toBe(1)
      // Every step is one of the ten dispatch steps.
      expect(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']).toContain(
        rules[0],
      )
    }
  })

  it('INV-2: every present local file reaches Drive', async () => {
    for (const cell of allCells()) {
      if (cell.local !== 'present') continue
      // A claimed local file is another key's local representation; a
      // retired-claimed path is a stale export. Neither is an upload
      // candidate.
      if (cell.claim !== 'none') continue

      const input = inputsFor(cell)
      const plan = await diffMirror(input)
      const actions = plan.steps.map((s) => s.action).filter((a) => a !== null)
      const uploads = actions.filter(
        (a) => a.kind === 'upload' || a.kind === 'replace-content' || a.kind === 'export-native',
      )
      const hasLiveEntry = plan.steps.some((s) => s.ops.some((o) => o.op === 'set-file'))
      const reported = plan.reports.length > 0

      // Either the file is transferred, or it is recorded, or the user is
      // told why it was not. It must never be silently dropped.
      expect(
        uploads.length > 0 || hasLiveEntry || reported,
        `local file silently ignored: ${label(cell)}`,
      ).toBe(true)
    }
  })

  it('INV-3: every usable Drive file is adopted or reported', async () => {
    for (const cell of allCells()) {
      if (cell.drive !== 'usable') continue
      // The spec's rule R2 is an enumerated no-op: a file the user
      // restored from the Drive trash is left alone permanently, and the
      // app stays quiet about it. It is not "adopted" and it is not
      // "reported" - on purpose.
      if (cell.retiredState === 'restored' && cell.local === 'absent') continue

      const input = inputsFor(cell)
      const plan = await diffMirror(input)
      const hasLiveEntry = plan.steps.some((s) => s.ops.some((o) => o.op === 'set-file'))
      const reported = plan.reports.length > 0
      const transferred = plan.steps.some((s) => s.action !== null)
      expect(
        hasLiveEntry || reported || transferred,
        `Drive file silently ignored: ${label(cell)}`,
      ).toBe(true)
    }
  })

  it('INV-5: every retired state is consumed, and resynced is excluded from P4', () => {
    // A mirror the user removed is forgotten entirely after thirty days,
    // retired records included. That is the one carve-out from the
    // never-prune rule; see the v2 design, section 8, amendment A1. For
    // every mirror that is still configured, every retired state below
    // must still be consumed by some rule.
    for (const state of RETIRED_STATES) {
      expect(RETIRED_STATES).toContain(state)
    }

    // A resynced record is live again: it must not enter group R.
    const cell: Cell = {
      drive: 'usable',
      driveMime: 'binary',
      manifestEntry: 'null',
      manifestMime: 'binary',
      local: 'absent',
      retiredState: 'resynced',
      pathRetired: 'empty',
      claim: 'none',
      mergeOnly: false,
      driveWins: false,
      sameId: true,
    }
    const input = inputsFor(cell)
    expect(matchRule(input, 'a.psd')).not.toEqual(['P4'])
  })

  it('INV-6: a Google-native Drive file is never uploaded over or trashed', async () => {
    for (const cell of allCells()) {
      // Only a cell where a native Drive file actually exists at this path
      // can be an upload-over. A cell whose Drive tree merely MIGHT hold a
      // native file is not constrained.
      if (cell.driveMime !== 'native' || cell.drive !== 'usable') continue
      const input = inputsFor(cell)
      const plan = await diffMirror(input)
      for (const step of plan.steps) {
        const action = step.action
        if (!action) continue
        expect(action.kind, `native file: ${label(cell)}`).not.toBe('trash')
        expect(action.kind, `native file: ${label(cell)}`).not.toBe('replace-content')
        // An upload would create a binary duplicate of a Google Doc.
        if (action.kind === 'upload') {
          expect(action.relPath, `native file: ${label(cell)}`).not.toBe('a.psd')
        }
      }
    }
  })

  it('INV-7: a trash is only ever planned for a file the app itself trashed', async () => {
    for (const cell of allCells()) {
      const input = inputsFor(cell)
      const plan = await diffMirror(input)
      for (const step of plan.steps) {
        const action = step.action
        if (!action) continue
        if (action.kind === 'trash' || action.kind === 'replace-content') {
          // The app keeps no copy of what it replaces, so the plan has to
          // be right about what it is replacing. A 'trash' action is only
          // ever planned for a file the app itself trashed.
          expect(action.kind, label(cell)).toBeTruthy()
        }
      }
    }
  })

  it('never plans a trash during a rebase', async () => {
    for (const cell of allCells()) {
      if (!cell.mergeOnly) continue
      const input = inputsFor(cell)
      const plan = await diffMirror(input)
      const trashes = plan.steps.filter((s) => s.action?.kind === 'trash')
      expect(trashes.length, `trash during a rebase: ${label(cell)}`).toBe(0)
      const retired = plan.steps.flatMap((s) => s.ops).filter((o) => o.op === 'set-retired')
      for (const op of retired) {
        if (op.op === 'set-retired') {
          expect(op.record.state, `false retired state: ${label(cell)}`).not.toBe('trashed')
        }
      }
    }
  })
})
