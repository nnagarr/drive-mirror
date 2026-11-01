import { describe, expect, it } from 'vitest'
import {
  isValidDrivePath,
  isValidMirrorName,
  mirrorConfigsFromManifest,
  overlaps,
  suggestDrivePath,
  validateMirror,
} from '../src/core/mirrorConfig'
import { emptyManifest } from '../src/core/manifest'

describe('mirror configuration', () => {
  it('turns the mirrors in a manifest into configurations', () => {
    const manifest = emptyManifest()
    manifest.mirrors.Medicine = { root: 'E:\\Medicine', lastCounts: {}, rebase: null, dirs: {}, files: {}, retired: {} }
    const mirrors = mirrorConfigsFromManifest(manifest)
    expect(mirrors).toHaveLength(1)
    expect(mirrors[0]).toEqual({ name: 'Medicine', root: 'E:\\Medicine', drivePath: 'Medicine', enabled: true })
  })

  it('produces nothing from an empty manifest', () => {
    expect(mirrorConfigsFromManifest(emptyManifest())).toEqual([])
  })

  it('refuses a name that differs only by case from an existing one', () => {
    const existing = [{ name: 'Docs', root: 'D:\\Docs', drivePath: 'Docs', enabled: true }]
    const problems = validateMirror({ name: 'docs', root: 'E:\\Other', drivePath: 'docs' }, existing)
    expect(problems.map((p) => p.field)).toContain('name')
  })

  it('refuses a root that sits inside another mirror', () => {
    const existing = [{ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs', enabled: true }]
    const problems = validateMirror({ name: 'Notes', root: 'E:\\Docs\\Notes', drivePath: 'Notes' }, existing)
    expect(problems.map((p) => p.field)).toContain('root')
  })

  it('refuses a root that contains another mirror', () => {
    const existing = [{ name: 'Notes', root: 'E:\\Docs\\Notes', drivePath: 'Notes', enabled: true }]
    const problems = validateMirror({ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs' }, existing)
    expect(problems.map((p) => p.field)).toContain('root')
  })

  it('does not treat a sibling folder as an overlap', () => {
    expect(overlaps('E:\\Docs', 'E:\\Docs2')).toBe(false)
    expect(overlaps('E:\\Docs', 'E:\\Docs\\Notes')).toBe(true)
    expect(overlaps('E:\\Docs\\Notes', 'E:\\Docs')).toBe(true)
  })

  it('refuses a Drive path with an empty segment or a dot dot', () => {
    expect(isValidDrivePath('Photos')).toBe(true)
    expect(isValidDrivePath('Archive/2026/Photos')).toBe(true)
    expect(isValidDrivePath('')).toBe(false)
    expect(isValidDrivePath('/Photos')).toBe(false)
    expect(isValidDrivePath('Photos/')).toBe(false)
    expect(isValidDrivePath('Photos//Archive')).toBe(false)
    expect(isValidDrivePath('../Photos')).toBe(false)
  })

  it('refuses a Drive path segment that is too long for Drive', () => {
    expect(isValidDrivePath('a'.repeat(255))).toBe(true)
    expect(isValidDrivePath('a'.repeat(256))).toBe(false)
    expect(isValidDrivePath(`Archive/${'a'.repeat(256)}`)).toBe(false)
  })

  it('counts a Drive path segment in characters, not in code units', () => {
    // An emoji is one character, even though it is two code units.
    expect(isValidDrivePath('\u{1f600}'.repeat(255))).toBe(true)
    expect(isValidDrivePath('\u{1f600}'.repeat(256))).toBe(false)
  })

  it('refuses a Drive path segment that ends in a space or a dot', () => {
    expect(isValidDrivePath('Photos ')).toBe(false)
    expect(isValidDrivePath('Photos.')).toBe(false)
    expect(isValidDrivePath('Archive/Photos.')).toBe(false)
    expect(isValidDrivePath('Docs.2026')).toBe(true)
  })

  it('refuses a name with a character Windows cannot use in a folder name', () => {
    expect(isValidMirrorName('My Photos')).toBe(true)
    expect(isValidMirrorName('a/b')).toBe(false)
    expect(isValidMirrorName('a:b')).toBe(false)
    expect(isValidMirrorName('')).toBe(false)
  })

  it('refuses a name that ends in a space or a dot', () => {
    // Windows strips a trailing space and a trailing dot, so the folder on
    // disk would not carry the name the manifest knows it by.
    expect(isValidMirrorName('Docs ')).toBe(false)
    expect(isValidMirrorName('Docs.')).toBe(false)
    expect(isValidMirrorName('Docs.2026')).toBe(true)
  })

  it('suggests a Drive path from the name', () => {
    expect(suggestDrivePath('Photos')).toBe('Photos')
    expect(suggestDrivePath('Archive/Photos')).toBe('Archive/Photos')
  })

  it('suggests a Drive path its own validator accepts', () => {
    expect(suggestDrivePath('a\\b')).toBe('a-b')
    expect(isValidDrivePath(suggestDrivePath('a\\b'))).toBe(true)
    expect(isValidDrivePath(suggestDrivePath('Docs: Photos'))).toBe(true)
    expect(isValidDrivePath(suggestDrivePath('Photos '))).toBe(true)
    expect(isValidDrivePath(suggestDrivePath('Photos.'))).toBe(true)
    expect(isValidDrivePath(suggestDrivePath('a'.repeat(300)))).toBe(true)
  })

  it('cuts a long name on a character boundary', () => {
    const suggestion = suggestDrivePath('\u{1f600}'.repeat(300))
    // The suggestion has to survive a trip through UTF-8, so the cut may
    // not land in the middle of a character.
    expect(Buffer.from(suggestion, 'utf8').toString('utf8')).toBe(suggestion)
    expect(Array.from(suggestion).length).toBe(255)
    expect(isValidDrivePath(suggestion)).toBe(true)
  })

  it('suggests a Drive path for a name that is only a non-breaking space', () => {
    expect(isValidMirrorName('\u00a0')).toBe(true)
    expect(isValidDrivePath(suggestDrivePath('\u00a0'))).toBe(true)
    expect(isValidDrivePath(suggestDrivePath('\ufeff'))).toBe(true)
  })

  it('refuses a candidate whose root is not a folder on this computer', () => {
    expect(validateMirror({ name: 'Docs', root: '', drivePath: 'Docs' }, []).map((p) => p.field)).toContain('root')
    expect(validateMirror({ name: 'Docs', root: 'Docs', drivePath: 'Docs' }, []).map((p) => p.field)).toContain('root')
  })

  it('refuses a candidate whose name or Drive path is malformed', () => {
    expect(validateMirror({ name: 'a/b', root: 'E:\\Docs', drivePath: 'Docs' }, []).map((p) => p.field)).toContain('name')
    expect(validateMirror({ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs//x' }, []).map((p) => p.field)).toContain('drivePath')
  })

  it('accepts a candidate that breaks no rule', () => {
    const existing = [{ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs', enabled: true }]
    expect(validateMirror({ name: 'Notes', root: 'F:\\Notes', drivePath: 'Notes' }, existing)).toEqual([])
  })

  it('reports the name problem for a name that is taken', () => {
    const existing = [{ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs', enabled: true }]
    const problems = validateMirror({ name: 'Docs', root: 'E:\\Docs\\Notes', drivePath: 'Docs' }, existing)
    expect(problems.map((p) => p.field)).toEqual(['name'])
  })

  it('refuses a second mirror on a root that is already mirrored', () => {
    const existing = [{ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs', enabled: true }]
    const problems = validateMirror({ name: 'Archive', root: 'E:\\Docs', drivePath: 'Archive' }, existing)
    expect(problems.map((p) => p.field)).toEqual(['root'])
    expect(problems[0]?.message).toContain('E:\\Docs')
  })

  it('reports every problem it finds', () => {
    const existing = [{ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs', enabled: true }]
    const problems = validateMirror({ name: 'Fresh', root: 'E:\\Docs\\Sub', drivePath: 'Bad//Path' }, existing)
    expect(problems.map((p) => p.field)).toEqual(['drivePath', 'root'])
  })

  it('lets a removed mirror be added again under the same root', () => {
    const existing = [{ name: 'Docs', root: 'E:\\OldDocs', drivePath: 'Docs', enabled: false, removedAt: '2026-10-01T00:00:00.000Z' }]
    expect(validateMirror({ name: 'Docs', root: 'E:\\OldDocs', drivePath: 'Docs' }, existing)).toEqual([])
  })

  it('refuses a removed mirror under a different root', () => {
    const existing = [{ name: 'Docs', root: 'E:\\OldDocs', drivePath: 'Docs', enabled: false, removedAt: '2026-10-01T00:00:00.000Z' }]
    const problems = validateMirror({ name: 'Docs', root: 'E:\\NewDocs', drivePath: 'Docs' }, existing)
    expect(problems.map((p) => p.field)).toContain('root')
    // The message has to name both roots: the one the mirror had and the
    // one the user is asking for.
    expect(problems[0]?.message).toContain('E:\\OldDocs')
    expect(problems[0]?.message).toContain('E:\\NewDocs')
  })

  it('keeps the root of a removed mirror reserved', () => {
    const existing = [{ name: 'Old', root: 'E:\\Old', drivePath: 'Old', enabled: false, removedAt: '2026-10-01T00:00:00.000Z' }]
    const problems = validateMirror({ name: 'Fresh', root: 'E:\\Old', drivePath: 'Fresh' }, existing)
    expect(problems.map((p) => p.field)).toEqual(['root'])
    // The message has to say the mirror is gone, not that it is running.
    expect(problems[0]?.message).toContain('removed')
  })

  it('keeps a folder inside the root of a removed mirror reserved', () => {
    const existing = [{ name: 'Old', root: 'E:\\Old', drivePath: 'Old', enabled: false, removedAt: '2026-10-01T00:00:00.000Z' }]
    const problems = validateMirror({ name: 'Fresh', root: 'E:\\Old\\Sub', drivePath: 'Fresh' }, existing)
    expect(problems.map((p) => p.field)).toEqual(['root'])
    expect(problems[0]?.message).toContain('removed')
  })

  it('takes the Drive folder the manifest recorded', () => {
    const manifest = emptyManifest()
    manifest.mirrors.Photos = { root: 'E:\\Photos', driveFolderName: 'Archive/2026/Photos', lastCounts: {}, rebase: null, dirs: {}, files: {}, retired: {} }
    expect(mirrorConfigsFromManifest(manifest)[0]?.drivePath).toBe('Archive/2026/Photos')
  })

  it('skips a manifest mirror that has no root', () => {
    const manifest = emptyManifest()
    manifest.mirrors.Broken = { root: '', lastCounts: {}, rebase: null, dirs: {}, files: {}, retired: {} }
    expect(mirrorConfigsFromManifest(manifest)).toEqual([])
  })
})
