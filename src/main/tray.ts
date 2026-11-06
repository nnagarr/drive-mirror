import { Menu, Tray } from 'electron'

/**
 * The dependencies required to manage the system tray.
 */
export interface TrayDeps {
  /** Path to the icon image file. */
  iconPath: string
  /** Invoked when the user wants to open/restore the window. */
  onOpen: () => void
  /** Invoked when the user triggers an immediate sync from the tray. */
  onSyncNow: () => void
  /** Invoked when the user clicks quit. */
  onQuit: () => void
}

/** Structural type for a menu item template entry. */
export interface MenuItemLike {
  label?: string
  type?: string
  click?: () => void
}

/** Structural type for an Electron Tray instance. */
export interface TrayLike {
  setToolTip(toolTip: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click' | 'double-click', listener: () => void): this
  destroy(): void
}

/**
 * Create and configure the system tray icon and context menu.
 */
export function createAppTray(
  deps: TrayDeps,
  trayFactory?: (icon: string) => TrayLike,
  menuBuilder?: (template: MenuItemLike[]) => unknown,
): TrayLike {
  const factory = trayFactory ?? ((icon: string) => new Tray(icon))
  const builder =
    menuBuilder ??
    ((template: MenuItemLike[]) =>
      Menu.buildFromTemplate(
        template.map((item) => ({
          label: item.label,
          type: item.type as any,
          click: item.click,
        })),
      ))

  const tray = factory(deps.iconPath)
  tray.setToolTip('Drive Mirror')

  const contextMenu = builder([
    {
      label: 'Open Drive Mirror',
      click: deps.onOpen,
    },
    {
      label: 'Sync now',
      click: deps.onSyncNow,
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit Drive Mirror',
      click: deps.onQuit,
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', deps.onOpen)
  tray.on('double-click', deps.onOpen)

  return tray
}
