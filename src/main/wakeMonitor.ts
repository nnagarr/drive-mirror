import { isWindowsScreenLocked } from './screenLock'

export interface WakeMonitorPowerEvents {
  on(event: 'resume' | 'suspend' | 'lock-screen' | 'unlock-screen', listener: () => void): void
  off(event: 'resume' | 'suspend' | 'lock-screen' | 'unlock-screen', listener: () => void): void
}

export interface WakeMonitorOptions {
  powerMonitor: WakeMonitorPowerEvents
  isScreenLocked?: () => Promise<boolean>
  debounceMs?: number
}

export interface WakeMonitor {
  onResume(fn: () => void): () => void
  dispose(): void
}

/**
 * Manages system wake and unlock events, ensuring scheduled sync catch-ups
 * only occur after the user has logged in and unlocked their screen, and
 * prevents rapid duplicate wake triggers.
 */
export function createWakeMonitor(options: WakeMonitorOptions): WakeMonitor {
  const { powerMonitor } = options
  const isScreenLocked = options.isScreenLocked ?? isWindowsScreenLocked
  const debounceMs = options.debounceMs ?? 250

  const listeners = new Set<() => void>()
  let isLocked = false
  let debounceTimer: NodeJS.Timeout | null = null

  function fireResume(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      for (const listener of listeners) {
        listener()
      }
    }, debounceMs)
  }

  const onLock = (): void => {
    isLocked = true
  }

  const onSuspend = (): void => {
    isLocked = true
  }

  const onUnlock = (): void => {
    isLocked = false
    fireResume()
  }

  const onResume = (): void => {
    void (async () => {
      if (isLocked) {
        return
      }
      const locked = await isScreenLocked()
      if (locked) {
        isLocked = true
        return
      }
      fireResume()
    })()
  }

  powerMonitor.on('lock-screen', onLock)
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('unlock-screen', onUnlock)
  powerMonitor.on('resume', onResume)

  return {
    onResume(fn: () => void): () => void {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    dispose(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      listeners.clear()
      powerMonitor.off('lock-screen', onLock)
      powerMonitor.off('suspend', onSuspend)
      powerMonitor.off('unlock-screen', onUnlock)
      powerMonitor.off('resume', onResume)
    },
  }
}
