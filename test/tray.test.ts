import { describe, expect, it, vi } from 'vitest'
import { createAppTray, type MenuItemLike, type TrayLike } from '../src/main/tray'

describe('the system tray', () => {
  it('initializes with the icon path and sets the tooltip', () => {
    let passedIcon = ''
    let tooltip = ''
    const mockTray: TrayLike = {
      setToolTip: vi.fn((tip: string) => {
        tooltip = tip
      }),
      setContextMenu: vi.fn(),
      on: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
    }

    createAppTray(
      {
        iconPath: '/path/to/icon.png',
        onOpen: vi.fn(),
        onSyncNow: vi.fn(),
        onQuit: vi.fn(),
      },
      (icon) => {
        passedIcon = icon
        return mockTray
      },
      (items) => items,
    )

    expect(passedIcon).toBe('/path/to/icon.png')
    expect(tooltip).toBe('Drive Mirror')
  })

  it('builds context menu items with working click handlers', () => {
    let menuTemplate: MenuItemLike[] = []
    const onOpen = vi.fn()
    const onSyncNow = vi.fn()
    const onQuit = vi.fn()

    const mockTray: TrayLike = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
    }

    createAppTray(
      {
        iconPath: '/path/to/icon.png',
        onOpen,
        onSyncNow,
        onQuit,
      },
      () => mockTray,
      (template) => {
        menuTemplate = template
        return template
      },
    )

    expect(menuTemplate).toHaveLength(4)
    expect(menuTemplate[0].label).toBe('Open Drive Mirror')
    expect(menuTemplate[1].label).toBe('Sync now')
    expect(menuTemplate[2].type).toBe('separator')
    expect(menuTemplate[3].label).toBe('Quit Drive Mirror')

    menuTemplate[0].click?.()
    expect(onOpen).toHaveBeenCalledOnce()

    menuTemplate[1].click?.()
    expect(onSyncNow).toHaveBeenCalledOnce()

    menuTemplate[3].click?.()
    expect(onQuit).toHaveBeenCalledOnce()
  })

  it('registers click and double-click listeners on the tray to open the app', () => {
    const onOpen = vi.fn()
    const listeners: Record<string, () => void> = {}

    const mockTray: TrayLike = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        listeners[event] = listener
        return mockTray
      }),
      destroy: vi.fn(),
    }

    createAppTray(
      {
        iconPath: '/icon.png',
        onOpen,
        onSyncNow: vi.fn(),
        onQuit: vi.fn(),
      },
      () => mockTray,
      (items) => items,
    )

    expect(listeners['click']).toBeDefined()
    expect(listeners['double-click']).toBeDefined()

    listeners['click']()
    expect(onOpen).toHaveBeenCalledTimes(1)

    listeners['double-click']()
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})
