import { describe, it, expect } from 'vitest'
import {
  canon,
  isWindowsReservedName,
  isRepresentableOnWindows,
  parentPath,
  baseName,
  sanitizePathSegment,
  joinPath,
} from '../src/core/paths'

describe('canon', () => {
  it('normalizes separators to forward slashes', () => {
    expect(canon('renders\\final\\scene.psd')).toBe('renders/final/scene.psd')
  })

  it('lowercases for case-insensitive matching', () => {
    expect(canon('Renders/Final/Scene.PSD')).toBe('renders/final/scene.psd')
  })

  it('normalizes to NFC', () => {
    // NFD (e + U+0301) must collapse to the same key as NFC (U+00E9)
    expect(canon('cafe\u0301/x.psd')).toBe(canon('caf\u00e9/x.psd'))
  })

  it('treats a and A as the same key', () => {
    expect(canon('A.psd')).toBe(canon('a.psd'))
  })
})

describe('isWindowsReservedName', () => {
  it('rejects reserved device names', () => {
    for (const n of [
      'CON',
      'con',
      'PRN',
      'AUX',
      'NUL',
      'COM1',
      'com9',
      'LPT1',
      'lpt9',
    ]) {
      expect(isWindowsReservedName(n)).toBe(true)
    }
  })

  it('rejects reserved names with an extension', () => {
    expect(isWindowsReservedName('CON.txt')).toBe(true)
  })

  it('accepts ordinary names', () => {
    expect(isWindowsReservedName('scene.psd')).toBe(false)
    expect(isWindowsReservedName('CONSOLE')).toBe(false)
  })
})

describe('isRepresentableOnWindows', () => {
  it('rejects names with illegal characters', () => {
    for (const n of ['a:b.psd', 'a*b.psd', 'a?b.psd', 'a"b.psd', 'a<b.psd', 'a>b.psd', 'a|b.psd']) {
      expect(isRepresentableOnWindows(n)).toBe(false)
    }
  })

  it('rejects names ending in a dot or space', () => {
    expect(isRepresentableOnWindows('scene.')).toBe(false)
    expect(isRepresentableOnWindows('scene ')).toBe(false)
  })

  it('rejects reserved device names', () => {
    expect(isRepresentableOnWindows('NUL')).toBe(false)
  })

  it('accepts ordinary names', () => {
    expect(isRepresentableOnWindows('scene.psd')).toBe(true)
    expect(isRepresentableOnWindows('render final v3.psd')).toBe(true)
  })
})

describe('path helpers', () => {
  it('returns the parent of a nested path', () => {
    expect(parentPath('renders/final/scene.psd')).toBe('renders/final')
  })

  it('returns an empty parent for a top-level path', () => {
    expect(parentPath('scene.psd')).toBe('')
  })

  it('returns the final segment', () => {
    expect(baseName('renders/final/scene.psd')).toBe('scene.psd')
  })

  it('joins and canonicalises segments', () => {
    expect(joinPath('renders', 'Final', 'Scene.PSD')).toBe('renders/final/scene.psd')
  })
})

describe('sanitizePathSegment', () => {
  it('replaces illegal characters with underscores', () => {
    expect(sanitizePathSegment('a:b*c?d')).toBe('a_b_c_d')
  })

  it('replaces control characters', () => {
    expect(sanitizePathSegment('a\u0001b')).toBe('a_b')
  })

  it('leaves a legal name untouched', () => {
    expect(sanitizePathSegment('scene.psd')).toBe('scene.psd')
  })
})
