import { describe, expect, it } from 'vitest'
import { validateWindowState } from '../src/main/windowState'
import type { DisplayLike, WindowState } from '../src/main/windowState'

describe('validateWindowState', () => {
  const primaryDisplay: DisplayLike = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  }

  const secondaryDisplay: DisplayLike = {
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
  }

  const leftDisplay: DisplayLike = {
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
  }

  it('returns default dimensions centered on primary display when saved state is null or undefined', () => {
    const result = validateWindowState(null, [primaryDisplay], primaryDisplay)

    expect(result.width).toBe(1180)
    expect(result.height).toBe(760)
    expect(result.isMaximized).toBe(false)
    // Centered on 1920x1040 primary work area: x = (1920 - 1180) / 2 = 370, y = (1040 - 760) / 2 = 140
    expect(result.x).toBe(370)
    expect(result.y).toBe(140)
  })

  it('preserves valid coordinates and dimensions on primary display', () => {
    const saved: WindowState = {
      x: 100,
      y: 100,
      width: 1200,
      height: 800,
      isMaximized: false,
    }

    const result = validateWindowState(saved, [primaryDisplay], primaryDisplay)
    expect(result).toEqual({
      x: 100,
      y: 100,
      width: 1200,
      height: 800,
      isMaximized: false,
    })
  })

  it('preserves valid coordinates on a secondary display to the right', () => {
    const saved: WindowState = {
      x: 2100,
      y: 150,
      width: 1280,
      height: 720,
      isMaximized: false,
    }

    const result = validateWindowState(saved, [primaryDisplay, secondaryDisplay], primaryDisplay)
    expect(result).toEqual({
      x: 2100,
      y: 150,
      width: 1280,
      height: 720,
      isMaximized: false,
    })
  })

  it('preserves valid negative coordinates on a secondary display to the left', () => {
    const saved: WindowState = {
      x: -1200,
      y: 100,
      width: 1000,
      height: 700,
      isMaximized: false,
    }

    const result = validateWindowState(saved, [leftDisplay, primaryDisplay], primaryDisplay)
    expect(result).toEqual({
      x: -1200,
      y: 100,
      width: 1000,
      height: 700,
      isMaximized: false,
    })
  })

  it('falls back to primary display if saved on a secondary display that is now disconnected', () => {
    const saved: WindowState = {
      x: 2100,
      y: 150,
      width: 1200,
      height: 800,
      isMaximized: false,
    }

    // Only primaryDisplay is connected now
    const result = validateWindowState(saved, [primaryDisplay], primaryDisplay)
    expect(result.width).toBe(1200)
    expect(result.height).toBe(800)
    expect(result.isMaximized).toBe(false)
    // Centered on primary work area: x = (1920 - 1200) / 2 = 360, y = (1040 - 800) / 2 = 120
    expect(result.x).toBe(360)
    expect(result.y).toBe(120)
  })

  it('enforces minimum dimensions (960x640)', () => {
    const saved: WindowState = {
      x: 100,
      y: 100,
      width: 800,
      height: 500,
      isMaximized: false,
    }

    const result = validateWindowState(saved, [primaryDisplay], primaryDisplay)
    expect(result.width).toBe(960)
    expect(result.height).toBe(640)
  })

  it('preserves isMaximized flag', () => {
    const saved: WindowState = {
      x: 100,
      y: 100,
      width: 1180,
      height: 760,
      isMaximized: true,
    }

    const result = validateWindowState(saved, [primaryDisplay], primaryDisplay)
    expect(result.isMaximized).toBe(true)
  })
})

