/**
 * The app's entry point.
 *
 * It owns the window, the IPC handlers, and the sign-in flow. The sign-in
 * is the loopback one: a short-lived HTTP server on an ephemeral port of
 * localhost receives Google's redirect, takes the code out of it, and
 * closes again. Nothing is exposed to the network.
 */

import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDriveClient } from '../drive/httpClient'
import { buildAuthUrl, exchangeCode, refreshAccessToken } from '../drive/oauth'
import { createLogger } from '../core/logger'
import { createManifestStore } from '../core/manifest'
import { appDataDir, createCredentialStore, createSettingsStore } from './settings'
import type { Settings } from './settings'
import { registerIpc } from './ipc'
import { createMainWindow } from './window'
import { createRunner } from './runner'
import type { AppEvent } from './ipc'
import type { OAuthTokens } from '../drive/oauth'

/** The channel the renderer listens on. */
const EVENT_CHANNEL = 'drive-mirror:event'

let mainWindow: BrowserWindow | null = null
const logger = createLogger(join(appDataDir(), 'logs'))

/** Send an event to the interface. */
function emit(event: AppEvent): void {
  logger.log({
    level: event.type === 'error' ? 'error' : 'info',
    message:
      event.type === 'error'
        ? event.message
        : event.type === 'guard'
          ? `guard: ${event.mirror}: ${event.reason}: ${event.message}`
          : `${event.type}${'mirror' in event ? `: ${event.mirror}` : ''}`,
    relPath: 'relPath' in event ? event.relPath : undefined,
  })
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENT_CHANNEL, event)
  }
}

/* ------------------------------------------------------------------ */
/* The stored tokens                                                    */
/* ------------------------------------------------------------------ */

const tokenFile = () => join(appDataDir(), 'tokens.json')

/** Read the stored tokens, if there are any. */
async function loadTokens(): Promise<OAuthTokens | null> {
  try {
    const raw = await readFile(tokenFile(), 'utf8')
    const stored = JSON.parse(raw) as { payload?: string }
    if (!stored.payload) return null
    const plain = safeStorage.decryptString(Buffer.from(stored.payload, 'base64'))
    return JSON.parse(plain) as OAuthTokens
  } catch {
    return null
  }
}

/** Store the tokens, encrypted. */
async function saveTokens(tokens: OAuthTokens): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('the operating system cannot encrypt the sign-in token')
  }
  await mkdir(appDataDir(), { recursive: true })
  const payload = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
  await writeFile(tokenFile(), JSON.stringify({ payload }), 'utf8')
}

/* ------------------------------------------------------------------ */
/* The Drive client                                                     */
/* ------------------------------------------------------------------ */

const credentialStore = createCredentialStore(
  join(appDataDir(), 'credentials.json'),
  safeStorage,
)

const settingsStore = createSettingsStore(join(appDataDir(), 'settings.json'))

/** A valid access token, refreshed when it is about to expire. */
async function accessToken(): Promise<string> {
  const tokens = await loadTokens()
  if (!tokens) throw new Error('the app is not signed in')
  if (tokens.expiry_date - Date.now() > 60_000) return tokens.access_token

  const clientId = credentialStore.getClientId()
  const clientSecret = credentialStore.getClientSecret()
  if (!clientId || !clientSecret) {
    throw new Error('the OAuth client id or secret is missing')
  }
  const refreshed = await refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken: tokens.refresh_token,
  })
  const next: OAuthTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_date: refreshed.expiry_date,
  }
  await saveTokens(next)
  return next.access_token
}

const client = createDriveClient(accessToken)

/**
 * The settings as the user should see them.
 *
 * The client id is not a secret - it appears in the browser's address bar
 * during sign-in - so it is shown. The secret is never read back into the
 * interface; the settings only say whether one is stored.
 */
async function currentSettings(): Promise<Settings> {
  const settings = await settingsStore.read()
  return {
    ...settings,
    clientId: credentialStore.getClientId() ?? settings.clientId,
    clientSecretSet: credentialStore.getClientSecret() !== null,
  }
}

/* ------------------------------------------------------------------ */
/* The sign-in flow                                                     */
/* ------------------------------------------------------------------ */

/**
 * Sign in, by opening the browser and waiting for the redirect.
 *
 * The server is opened first, so the address the browser is sent to is
 * the address that is actually listening. It is closed as soon as the code
 * arrives.
 */
async function authenticate(): Promise<{ ok: boolean; email?: string }> {
  const clientId = credentialStore.getClientId()
  const clientSecret = credentialStore.getClientSecret()
  if (!clientId || !clientSecret) {
    return { ok: false }
  }

  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    return { ok: false }
  }
  const redirectUri = `http://localhost:${address.port}`

  try {
    const state = randomBytes(16).toString('hex')
    // The listener is attached BEFORE the browser is sent anywhere, so a
    // fast redirect cannot arrive with nobody listening.
    const codePromise = waitForCode(server, redirectUri, state)
    await shell.openExternal(buildAuthUrl(clientId, redirectUri, state))
    const code = await codePromise
    const tokens = await exchangeCode({
      clientId,
      clientSecret,
      code,
      redirectUri,
    })
    await saveTokens(tokens)
    return { ok: true }
  } catch (err) {
    emit({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
    return { ok: false }
  } finally {
    server.close()
  }
}

/**
 * Wait for Google's redirect to arrive.
 */
function waitForCode(
  server: import('node:http').Server,
  redirectUri: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the sign-in was not completed in time'))
    }, timeoutMs)

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      const state = url.searchParams.get('state')
      const received = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('This sign-in request did not come from Drive Mirror.')
        clearTimeout(timer)
        reject(new Error('the sign-in response did not match the request'))
        return
      }
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('The sign-in was declined.')
        clearTimeout(timer)
        reject(new Error(`the sign-in was declined: ${error}`))
        return
      }
      if (!received) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('No authorisation code was received.')
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><body style="font-family:system-ui;background:#1b1b1f;color:#e6e6e6;padding:3rem">' +
          '<h1>Drive Mirror is signed in</h1><p>You can close this tab.</p></body></html>',
      )
      clearTimeout(timer)
      resolve(received)
    })
  })
}

/* ------------------------------------------------------------------ */
/* The app                                                              */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    // The credentials can come from the environment, which is how the
    // smoke test signs in without anyone typing a secret into a window.
    if (!credentialStore.getClientId()) {
      const envId = process.env.DRIVE_MIRROR_CLIENT_ID
      const envSecret = process.env.DRIVE_MIRROR_CLIENT_SECRET
      if (envId && envSecret) {
        try {
          await credentialStore.setCredentials(envId, envSecret)
        } catch {
          // The user can still enter them in Settings.
        }
      }
    }

    const settings = await currentSettings()
    // The store keeps the manifest in the directory that holds it, which
    // is the one the settings show the user.
    const store = createManifestStore(appDataDir())
    const runner = createRunner({
      client,
      store,
      settings,
      emit,
      log: (message: string) => logger.log({ level: 'warn', message }),
      hasCredentials: async () =>
        Boolean(credentialStore.getClientId()) && (await loadTokens()) !== null,
      accountEmail: () => null,
    })

    registerIpc({
      runner,
      getSettings: () => currentSettings(),
      async saveSettings(patch) {
        const current = await currentSettings()
        const next = { ...current, ...patch }
        await settingsStore.write(next)
        return next
      },
      async setCredentials(clientId, clientSecret) {
        try {
          await credentialStore.setCredentials(clientId, clientSecret)
          return { ok: true }
        } catch {
          return { ok: false }
        }
      },
      authenticate,
      async signOut() {
        await rm(tokenFile(), { force: true })
      },
      async openLogFolder() {
        await shell.openPath(join(appDataDir(), 'logs'))
      },
      async showManifest() {
        await shell.openPath(settings.manifestPath)
      },
      async revealSuperseded() {
        await shell.openPath(settings.supersededPath)
      },
      async pruneSuperseded() {
        return pruneSuperseded(settings.supersededPath)
      },
      onError: (message: string) => {
        emit({ type: 'error', message })
      },
    })

    mainWindow = createMainWindow()

    // Fill in the file counts so the window shows the real trees before
    // the first run.
    await runner.prime()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

/** Delete the superseded copies and report how much was freed. */
async function pruneSuperseded(dir: string): Promise<{ freedBytes: number }> {
  let freedBytes = 0
  const { readdir } = await import('node:fs/promises')
  async function walk(current: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(current, entry)
      const info = await stat(abs).catch(() => null)
      if (!info) continue
      if (info.isDirectory()) {
        await walk(abs)
      } else {
        await rm(abs, { force: true })
        freedBytes += info.size
      }
    }
  }
  await walk(dir)
  return { freedBytes }
}
