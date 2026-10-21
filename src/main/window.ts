/**
 * The app's window.
 *
 * The window is deliberately plain: a fixed size, a dark background that
 * matches the app's own theme, and no node integration. The interface has
 * no business reading files or reaching the network; everything it can do
 * is in the preload script.
 */

import { BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'

/** Where the preload script lives, in development and in a build. */
function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

/** The page the window shows. */
function indexPath(): string {
  return join(__dirname, '../renderer/index.html')
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
