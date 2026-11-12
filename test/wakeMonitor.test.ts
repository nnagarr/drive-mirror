import { describe, expect, it, vi } from 'vitest'
import { createWakeMonitor } from '../src/main/wakeMonitor'
import type { WakeMonitorPowerEvents } from '../src/main/wakeMonitor'

class FakePowerMonitor implements WakeMonitorPowerEvents {
  listeners: Record<string, Array<() => void>> = {}

  on(event: 'resume' | 'suspend' | 'lock-screen' | 'unlock-screen', listener: () => void): void {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(listener)
  }

  off(event: 'resume' | 'suspend' | 'lock-screen' | 'unlock-screen', listener: () => void): void {
    if (!this.listeners[event]) return
    this.listeners[event] = this.listeners[event].filter((l) => l !== listener)
  }

  emit(event: 'resume' | 'suspend' | 'lock-screen' | 'unlock-screen'): void {
    for (const l of this.listeners[event] ?? []) {
      l()
    }
  }
}

describe('createWakeMonitor', () => {
  it('does not fire onResume when waking while screen is locked', async () => {
    const power = new FakePowerMonitor()
    const isScreenLocked = vi.fn().mockResolvedValue(true)
    const monitor = createWakeMonitor({ powerMonitor: power, isScreenLocked, debounceMs: 10 })

    const callback = vi.fn()
    monitor.onResume(callback)

    power.emit('resume')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(isScreenLocked).toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()

    monitor.dispose()
  })

  it('fires onResume after unlock-screen when resuming from lock', async () => {
    const power = new FakePowerMonitor()
    const isScreenLocked = vi.fn().mockResolvedValue(true)
    const monitor = createWakeMonitor({ powerMonitor: power, isScreenLocked, debounceMs: 10 })

    const callback = vi.fn()
    monitor.onResume(callback)

    // Wake while locked
    power.emit('resume')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(callback).not.toHaveBeenCalled()

    // Now unlock
    power.emit('unlock-screen')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(callback).toHaveBeenCalledTimes(1)

    monitor.dispose()
  })

  it('fires onResume immediately when waking if screen is not locked', async () => {
    const power = new FakePowerMonitor()
    const isScreenLocked = vi.fn().mockResolvedValue(false)
    const monitor = createWakeMonitor({ powerMonitor: power, isScreenLocked, debounceMs: 10 })

    const callback = vi.fn()
    monitor.onResume(callback)

    power.emit('resume')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(isScreenLocked).toHaveBeenCalled()
    expect(callback).toHaveBeenCalledTimes(1)

    monitor.dispose()
  })

  it('debounces multiple rapid unlock events to fire only once', async () => {
    const power = new FakePowerMonitor()
    const monitor = createWakeMonitor({ powerMonitor: power, debounceMs: 20 })

    const callback = vi.fn()
    monitor.onResume(callback)

    power.emit('unlock-screen')
    power.emit('unlock-screen')
    power.emit('unlock-screen')

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(callback).toHaveBeenCalledTimes(1)

    monitor.dispose()
  })

  it('treats suspend as locking the screen', async () => {
    const power = new FakePowerMonitor()
    const isScreenLocked = vi.fn().mockResolvedValue(false)
    const monitor = createWakeMonitor({ powerMonitor: power, isScreenLocked, debounceMs: 10 })

    const callback = vi.fn()
    monitor.onResume(callback)

    // System suspends
    power.emit('suspend')
    // System resumes but is locked (e.g. suspend marked it locked)
    power.emit('resume')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(callback).not.toHaveBeenCalled()

    // Unlock
    power.emit('unlock-screen')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(callback).toHaveBeenCalledTimes(1)

    monitor.dispose()
  })
})
