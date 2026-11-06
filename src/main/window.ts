/**
 * The app's window.
 *
 * The window is deliberately plain: a fixed size, a dark background that
 * matches the app's own theme, and no node integration. The interface has
 * no business reading files or reaching the network; everything it can do
 * is in the preload script.
 */

import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import type { WindowState } from './windowState'

/** Options when initializing the main window. */
export interface MainWindowOptions {
  /** Whether the window should remain hidden until explicitly shown. */
  startHidden?: boolean
}

/** Where the preload script lives, in development and in a build. */
function preloadPath(): string {
  // The preload script is CommonJS, because a sandboxed preload cannot be
  // an ES module.
  return join(__dirname, '../preload/index.cjs')
}

/** The page the window shows. */
function indexPath(): string {
  return join(__dirname, '../renderer/index.html')
}

/**
 * The app's icon.
 *
 * In a build it is a resource next to the app. In development it is read
 * from the repository, because the build has not been made yet.
 */
export function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

/**
 * Show and focus the main window, restoring or maximizing as needed.
 */
export function showMainWindow(window: BrowserWindow, initialState?: WindowState): void {
  if (window.isMinimized()) {
    window.restore()
  }
  if (initialState?.isMaximized && !window.isMaximized()) {
    window.maximize()
  }
  window.show()
  window.focus()
}

/**
 * Create the app's window.
 */
export function createMainWindow(
  initialState?: WindowState,
  onSaveState?: (state: WindowState) => void,
  options?: MainWindowOptions,
): BrowserWindow {
  nativeTheme.themeSource = 'system'

  // The titlebar overlay colours live here because this is the only place
  // the main process knows the palette; they match styles/tokens.css.
  const overlayColour = (dark: boolean) => (dark ? '#18181B' : '#E4E4E7')
  const overlaySymbols = (dark: boolean) => (dark ? '#F4F4F5' : '#09090B')
  const backgroundColour = (dark: boolean) => (dark ? '#09090B' : '#F4F4F5')

  const initialDark = nativeTheme.shouldUseDarkColors

  const window = new BrowserWindow({
    x: initialState?.x,
    y: initialState?.y,
    width: initialState?.width ?? 1180,
    height: initialState?.height ?? 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Drive Mirror',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: overlayColour(initialDark),
      symbolColor: overlaySymbols(initialDark),
      height: 38,
    },
    backgroundColor: backgroundColour(initialDark),
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // State tracking: keep track of normal (non-maximized) bounds and isMaximized
  let normalBounds = {
    x: initialState?.x,
    y: initialState?.y,
    width: initialState?.width ?? 1180,
    height: initialState?.height ?? 760,
  }
  let isMaximized = Boolean(initialState?.isMaximized)
  let saveTimer: NodeJS.Timeout | null = null

  const triggerSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      onSaveState?.({
        ...normalBounds,
        isMaximized,
      })
    }, 300)
  }

  const flushSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    onSaveState?.({
      ...normalBounds,
      isMaximized,
    })
  }

  const updateBounds = (): void => {
    if (!window.isDestroyed() && !window.isMaximized() && !window.isMinimized()) {
      const bounds = window.getBounds()
      normalBounds = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }
      isMaximized = false
      triggerSave()
    }
  }

  window.on('resize', updateBounds)
  window.on('move', updateBounds)
  window.on('maximize', () => {
    isMaximized = true
    triggerSave()
  })
  window.on('unmaximize', () => {
    isMaximized = false
    updateBounds()
  })
  window.on('close', flushSave)

  const applyTheme = (): void => {
    const dark = nativeTheme.shouldUseDarkColors
    window.setTitleBarOverlay({
      color: overlayColour(dark),
      symbolColor: overlaySymbols(dark),
      height: 38,
    })
    window.setBackgroundColor(backgroundColour(dark))
  }
  nativeTheme.on('updated', applyTheme)

  window.once('ready-to-show', () => {
    applyTheme()
    if (!options?.startHidden) {
      if (initialState?.isMaximized) {
        window.maximize()
      }
      window.show()
    }
  })
  window.on('closed', () => nativeTheme.removeListener('updated', applyTheme))

  // The interface never navigates anywhere of its own. External links open in the system default browser.
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
  })

  // Deny new Electron window creation (e.g. window.open or target="_blank") and open externally instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // In development, load from Vite's dev server if available, otherwise from built files.
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(indexPath())
  }

  return window
}
