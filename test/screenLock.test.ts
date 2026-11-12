import { describe, expect, it } from 'vitest'
import { isWindowsScreenLocked } from '../src/main/screenLock'

describe('isWindowsScreenLocked', () => {
  it('runs and returns boolean', async () => {
    const locked = await isWindowsScreenLocked()
    expect(typeof locked).toBe('boolean')
    // During local test execution on Windows, desktop is unlocked
    if (process.platform === 'win32') {
      expect(locked).toBe(false)
    }
  })
})
