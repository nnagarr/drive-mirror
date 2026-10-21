import { describe, it, expect } from 'vitest'
import { planExportPaths, buildClaimIndex } from '../src/core/claims'
import { retired } from './helpers/fixtures'
import { canon } from '../src/core/paths'
import { emptyManifest, emptyMirror } from '../src/core/manifest'
import type {
  DriveFile,
  DriveNode,
  DriveTree,
  LocalTree,
  MirrorManifest,
} from '../src/core/types'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const DOC_MIME = 'application/vnd.google-apps.document'

function driveNode(
  id: string,
  name: string,
  parentPath: string,
  mimeType: string,
): DriveNode {
  return {
    entry: {
      id,
      name,
      mimeType,
      size: '10',
      md5Checksum: 'm1',
      modifiedTime: '2026-10-20T18:00:00.000Z',
      trashed: false,
      parents: ['p'],
    },
    parentPath,
  }
}

function driveTreeWith(nodes: DriveNode[]): DriveTree {
  const files = new Map<string, DriveFile[]>()
  const dirs = new Map<string, string>()
  const dirById = new Map<string, string>()

  for (const node of nodes) {
    // Mirror buildDriveTree: keys are canonical paths.
    const raw =
      node.parentPath === '' ? node.entry.name : `${node.parentPath}/${node.entry.name}`
    const path = canon(raw)
    if (node.entry.mimeType === FOLDER_MIME) {
      dirs.set(path, node.entry.id)
      dirById.set(node.entry.id, path)
      continue
    }
    const file: DriveFile = {
      id: node.entry.id,
      name: node.entry.name,
      mimeType: node.entry.mimeType,
      size: 10,
      md5: 'm1',
      driveModifiedTime: node.entry.modifiedTime,
      ambiguous: false,
      unrepresentable: false,
    }
    const bucket = files.get(path)
    if (bucket) bucket.push(file)
    else files.set(path, [file])
  }

  return { files, dirs, dirById }
}

function localTreeWith(paths: string[]): LocalTree {
  const files = new Map()
  for (const p of paths) {
    files.set(p, { state: 'present' as const, size: 1, mtimeMs: 1 })
  }
  return { files, dirs: new Set(), unreadableDirs: new Map(), recursiveCounts: {} }
}

function mirrorWith(
  files: MirrorManifest['files'] = {},
  retired: MirrorManifest['retired'] = {},
): MirrorManifest {
  const m = emptyMirror('E:\\Medicine')
  m.files = files
  m.retired = retired
  return m
}

describe('planExportPaths', () => {
  it('plans the natural export path when it is free', () => {
    const drive = driveTreeWith([driveNode('D1', 'Budget', '', SHEET_MIME)])
    const plan = planExportPaths(drive, mirrorWith(), localTreeWith([]))
    expect(plan.get('D1')).toBe('budget.csv')
  })

  it('falls back to "(export N)" when the natural path is taken on disk', () => {
    const drive = driveTreeWith([driveNode('D1', 'Budget', '', SHEET_MIME)])
    const plan = planExportPaths(drive, mirrorWith(), localTreeWith(['budget.csv']))
    expect(plan.get('D1')).toBe('budget (export 1).csv')
  })

  it('increments the export suffix until it is free', () => {
    const drive = driveTreeWith([driveNode('D1', 'Budget', '', SHEET_MIME)])
    const plan = planExportPaths(
      drive,
      mirrorWith(),
      localTreeWith(['budget.csv', 'budget (export 1).csv']),
    )
    expect(plan.get('D1')).toBe('budget (export 2).csv')
  })

  it('avoids a path occupied by another Drive file', () => {
    const drive = driveTreeWith([
      driveNode('D1', 'Budget', '', SHEET_MIME),
      driveNode('D2', 'Budget.csv', '', 'application/octet-stream'),
    ])
    const plan = planExportPaths(drive, mirrorWith(), localTreeWith([]))
    expect(plan.get('D1')).not.toBe('budget.csv')
  })

  it('avoids a path claimed by another native file', () => {
    // Two native files whose natural export paths collide: 'A' -> 'a.csv'
    // and 'A.csv' -> 'a.csv.csv' would not collide, so use two natives
    // whose natural paths are identical.
    const drive = driveTreeWith([
      driveNode('D1', 'Budget', '', SHEET_MIME),
      driveNode('D2', 'Budget', 'other', SHEET_MIME),
    ])
    const plan = planExportPaths(drive, mirrorWith(), localTreeWith([]))
    const paths = [...plan.values()]
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('reuses the recorded localPath of an existing native entry', () => {
    const drive = driveTreeWith([driveNode('D1', 'Budget', '', SHEET_MIME)])
    const mirror = mirrorWith({
      budget: {
        displayPath: 'budget',
        driveFileId: 'D1',
        driveMd5: 'm1',
        driveModifiedTime: '2026-10-20T18:00:00.000Z',
        driveMimeType: SHEET_MIME,
        exportMime: 'text/csv',
        localPath: 'budget (export 1).csv',
        localMd5: 'm2',
        localSize: 10,
        localMtimeMs: 1,
      },
    })
    const plan = planExportPaths(drive, mirror, localTreeWith([]))
    expect(plan.get('D1')).toBe('budget (export 1).csv')
  })

  it('plans nothing for files that are not Google-native', () => {
    const drive = driveTreeWith([driveNode('D1', 'scene.psd', '', 'application/octet-stream')])
    const plan = planExportPaths(drive, mirrorWith(), localTreeWith([]))
    expect(plan.size).toBe(0)
  })

  it('plans nothing for a native type with no export', () => {
    const drive = driveTreeWith([
      driveNode('D1', 'Form', '', 'application/vnd.google-apps.form'),
    ])
    const plan = planExportPaths(drive, mirrorWith(), localTreeWith([]))
    expect(plan.size).toBe(0)
  })

  it('is deterministic regardless of node order', () => {
    const nodes = [
      driveNode('D1', 'Budget', '', SHEET_MIME),
      driveNode('D2', 'Alpha', '', DOC_MIME),
    ]
    const a = planExportPaths(driveTreeWith(nodes), mirrorWith(), localTreeWith([]))
    const b = planExportPaths(driveTreeWith([...nodes].reverse()), mirrorWith(), localTreeWith([]))
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort())
  })
})

describe('buildClaimIndex', () => {
  it('claims a live entry localPath', () => {
    const mirror = mirrorWith({
      'renders/scene.psd': {
        displayPath: 'renders/scene.psd',
        driveFileId: 'D1',
        driveMd5: 'm1',
        driveModifiedTime: '2026-10-20T18:00:00.000Z',
        driveMimeType: 'application/octet-stream',
        exportMime: null,
        localPath: 'renders/scene.psd',
        localMd5: 'm1',
        localSize: 1,
        localMtimeMs: 1,
      },
    })
    const { claimedBy } = buildClaimIndex(mirror, new Map())
    // An ordinary mirrored file is not a claim on its own path Ã¢â‚¬â€ the engine
    // would otherwise skip every file it tracks.
    expect(claimedBy.has('renders/scene.psd')).toBe(false)
  })

  it('claims a live entry whose local representation lives elsewhere', () => {
    // A Google-native export: the entry is keyed by the Drive path and its
    // local file lives at the export path.
    const mirror = mirrorWith({
      budget: {
        displayPath: 'budget',
        driveFileId: 'D1',
        driveMd5: 'm1',
        driveModifiedTime: '2026-10-20T18:00:00.000Z',
        driveMimeType: SHEET_MIME,
        exportMime: 'text/csv',
        localPath: 'budget.csv',
        localMd5: 'm2',
        localSize: 10,
        localMtimeMs: 1,
      },
    })
    const { claimedBy } = buildClaimIndex(mirror, new Map())
    expect(claimedBy.get('budget.csv')?.has('budget')).toBe(true)
    expect(claimedBy.has('budget')).toBe(false)
  })

  it('claims a planned export path under the native file key', () => {
    const mirror = mirrorWith()
    const drive = driveTreeWith([driveNode('D1', 'Budget', '', SHEET_MIME)])
    const plan = planExportPaths(drive, mirror, localTreeWith([]))
    const { claimedBy } = buildClaimIndex(mirror, plan, drive)
    expect(claimedBy.get('budget.csv')?.has('budget')).toBe(true)
  })

  it('claims the export path of a retired native file', () => {
    const mirror = mirrorWith(
      {},
      {
        '1XyZ': retired('1XyZ', 'budget', 'gone', { md5: 'm1', driveMimeType: SHEET_MIME, localPath: 'budget.csv' }),
      },
    )
    const { retiredClaims } = buildClaimIndex(mirror, new Map())
    expect(retiredClaims.has('budget.csv')).toBe(true)
  })

  it('does not claim the local path of a retired ordinary file', () => {
    // An ordinary file's retired record carries the file's OWN path. If
    // that path were claimed, a file restored from the Drive trash would
    // be invisible for ever: the app would never notice it, and would
    // never report the restore.
    const mirror = mirrorWith(
      {},
      {
        '1XyZ': retired('1XyZ', 'scene.psd', 'trashed', {
          md5: 'm1',
          driveMimeType: 'application/octet-stream',
          localPath: 'scene.psd',
        }),
      },
    )
    const { retiredClaims } = buildClaimIndex(mirror, new Map())
    expect(retiredClaims.has('scene.psd')).toBe(false)
    expect(retiredClaims.size).toBe(0)
  })

  it('does not claim the export path of a retired non-native file', () => {
    const mirror = mirrorWith(
      {},
      {
        '1XyZ': retired('1XyZ', 'scene.psd', 'gone', { md5: 'm1' }),
      },
    )
    const { retiredClaims } = buildClaimIndex(mirror, new Map())
    expect(retiredClaims.size).toBe(0)
  })
})
