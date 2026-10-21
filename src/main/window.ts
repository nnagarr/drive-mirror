/**
 * The app's window.
 *
 * The window is deliberately plain: a fixed size, a dark background that
 * matches the app's own theme, and no node integration. The interface has
 * no business reading files or reaching the network; everything it can do
 * is in the preload script.
 */

import { app, BrowserWindow, nativeTheme } from 'electron'
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

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Drive Mirror',
    titleBarStyle: 'default',
    backgroundColor: '#1b1b1f',
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => window.show())

  // The interface never navigates anywhere of its own.
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(indexPath())
  }

  return window
}
