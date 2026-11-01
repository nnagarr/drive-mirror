import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('the app icon', () => {
  it('is a valid ico with the sizes Windows asks for', async () => {
    const b = await readFile(join(process.cwd(), 'build', 'icon.ico'))
    expect(b.readUInt16LE(0)).toBe(0)
    expect(b.readUInt16LE(2)).toBe(1)
    const count = b.readUInt16LE(4)
    expect(count).toBe(6)
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 16
      sizes.push(b.readUInt8(o) || 256)
      const off = b.readUInt32LE(o + 12)
      // Every entry holds a PNG, which Windows has read since Vista.
      expect(b.slice(off, off + 8).toString('hex')).toBe('89504e470d0a1a0a')
    }
    expect(sizes.sort((a, b2) => a - b2)).toEqual([16, 32, 48, 64, 128, 256])
  })

  it('has a 512 pixel png as the source', async () => {
    const b = await readFile(join(process.cwd(), 'build', 'icon.png'))
    expect(b.slice(1, 4).toString('ascii')).toBe('PNG')
    expect(b.readUInt32BE(16)).toBe(512)
    expect(b.readUInt32BE(20)).toBe(512)
  })

  it('is the icon the installer and the window use', async () => {
    const config = await readFile(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(config).toContain('build/icon.ico')
    expect(config).toContain('build/icon.png')
  })
})
