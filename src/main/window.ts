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
 * Create the app's window.
 */
export function createMainWindow(): BrowserWindow {
  nativeTheme.themeSource = 'system'

  // The titlebar overlay colours live here because this is the only place
  // the main process knows the palette; they match styles/tokens.css.
  const overlayColour = (dark: boolean) => (dark ? '#18181B' : '#E4E4E7')
  const overlaySymbols = (dark: boolean) => (dark ? '#F4F4F5' : '#09090B')
  const backgroundColour = (dark: boolean) => (dark ? '#09090B' : '#F4F4F5')

    const initialDark = nativeTheme.shouldUseDarkColors

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
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
    window.show()
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(indexPath())
  }

  return window
}
