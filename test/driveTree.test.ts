import { describe, it, expect } from 'vitest'
import { buildDriveTree, isGoogleNativeMime } from '../src/core/driveTree'
import type { DriveNode } from '../src/core/types'

function node(
  name: string,
  parentPath: string,
  overrides: Partial<DriveNode['entry']> = {},
): DriveNode {
  return {
    entry: {
      id: `id-${name}-${parentPath}`,
      name,
      mimeType: 'application/octet-stream',
      size: '1024',
      md5Checksum: 'abc123',
      modifiedTime: '2026-10-20T18:00:00.000Z',
      trashed: false,
      parents: ['parent-id'],
      ...overrides,
    },
    parentPath,
  }
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

describe('buildDriveTree', () => {
  it('groups files by canonical path', () => {
    const tree = buildDriveTree([node('Scene.PSD', '')])
    const entries = tree.files.get('scene.psd')
    expect(entries).toHaveLength(1)
    expect(entries?.[0]?.name).toBe('Scene.PSD')
    expect(entries?.[0]?.md5).toBe('abc123')
    expect(entries?.[0]?.size).toBe(1024)
    expect(entries?.[0]?.driveModifiedTime).toBe('2026-10-20T18:00:00.000Z')
  })

  it('resolves a node path from its parent path and name', () => {
    const tree = buildDriveTree([node('Scene.PSD', 'renders/final')])
    expect(tree.files.get('renders/final/scene.psd')).toHaveLength(1)
  })

  it('marks two files with the same name in one folder ambiguous', () => {
    const a = node('a.psd', '', { id: 'A' })
    const b = node('a.psd', '', { id: 'B' })
    const tree = buildDriveTree([a, b])

    const entries = tree.files.get('a.psd')!
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.ambiguous).toBe(true)
    }
  })

  it('marks a case collision ambiguous', () => {
    const tree = buildDriveTree([
      node('A.psd', '', { id: 'A' }),
      node('a.psd', '', { id: 'B' }),
    ])
    const entries = tree.files.get('a.psd')!
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.ambiguous).toBe(true)
    }
  })

  it('does not mark a lone file ambiguous', () => {
    const tree = buildDriveTree([node('a.psd', '', { id: 'A' })])
    expect(tree.files.get('a.psd')?.[0]?.ambiguous).toBe(false)
  })

  it('flags a name that Windows cannot represent', () => {
    const tree = buildDriveTree([node('a:b.psd', '')])
    expect(tree.files.get('a:b.psd')?.[0]?.unrepresentable).toBe(true)
  })

  it('does not flag a representable name', () => {
    const tree = buildDriveTree([node('a-b.psd', '')])
    expect(tree.files.get('a-b.psd')?.[0]?.unrepresentable).toBe(false)
  })

  it('maps folder ids to their canonical paths', () => {
    const tree = buildDriveTree([
      node('renders', '', { id: 'DIR1', mimeType: FOLDER_MIME }),
    ])
    expect(tree.dirs.get('renders')).toBe('DIR1')
    expect(tree.dirById.get('DIR1')).toBe('renders')
  })

  it('keeps folders out of the file map', () => {
    const tree = buildDriveTree([
      node('renders', '', { id: 'DIR1', mimeType: FOLDER_MIME }),
    ])
    expect(tree.files.has('renders')).toBe(false)
  })

  it('records a missing md5 as null rather than undefined', () => {
    const tree = buildDriveTree([node('a.psd', '', { md5Checksum: undefined })])
    expect(tree.files.get('a.psd')?.[0]?.md5).toBeNull()
  })

  it('records a missing size as undefined', () => {
    const tree = buildDriveTree([node('a.psd', '', { size: undefined })])
    expect(tree.files.get('a.psd')?.[0]?.size).toBeUndefined()
  })
})

describe('isGoogleNativeMime', () => {
  it('recognises the Google-native types', () => {
    expect(isGoogleNativeMime('application/vnd.google-apps.document')).toBe(true)
    expect(isGoogleNativeMime('application/vnd.google-apps.spreadsheet')).toBe(true)
    expect(isGoogleNativeMime('application/vnd.google-apps.presentation')).toBe(true)
    expect(isGoogleNativeMime('application/vnd.google-apps.drawing')).toBe(true)
  })

  it('does not treat ordinary files as native', () => {
    expect(isGoogleNativeMime('application/octet-stream')).toBe(false)
    expect(isGoogleNativeMime('image/png')).toBe(false)
    expect(isGoogleNativeMime('application/vnd.google-apps.folder')).toBe(false)
  })
})
