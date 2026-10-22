/**
 * The app's entry point.
 *
 * It owns the window, the IPC handlers, and the sign-in flow. The sign-in
 * is the loopback one: a short-lived HTTP server on an ephemeral port of
 * localhost receives Google's redirect, takes the code out of it, and
 * closes again. Nothing is exposed to the network.
 */

import { app, BrowserWindow, dialog, Notification, powerMonitor, safeStorage, shell } from 'electron'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDriveClient } from '../drive/httpClient'
import type { DriveClient } from '../drive/client'
import { buildAuthUrl, exchangeCode, refreshAccessToken } from '../drive/oauth'
import { createLogger } from '../core/logger'
import { createManifestStore, emptyManifest } from '../core/manifest'
import { mirrorConfigsFromManifest } from '../core/mirrorConfig'
import { appDataDir, createCredentialStore, createSettingsStore } from './settings'
import type { AppSettings } from './settings'
import { createAccountSettingsStore, defaultAccountSettings } from './accountSettings'
import type { AccountSettings } from './accountSettings'
import { createAccountTokenStore } from './accountTokens'
import { createAccountRegistry } from './accounts'
import { migrateToAccounts } from './migrate'
import { accountDir, accountManifestPath, appBackupDir } from './accountPaths'
import { registerIpc } from './ipc'
import { createMainWindow, appIconPath } from './window'
import { createRunner } from './runner'
import type { AccountRuntime } from './runner'
import { createScheduler } from './scheduler'
import type { Scheduler } from './scheduler'
import { setPendingNotice } from './notice'
import { registerTask, taskExists, unregisterLegacyTask, unregisterTask } from './taskScheduler'
import { parseCli } from './cli'
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
    account: event.accountId ?? undefined,
  })
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENT_CHANNEL, event)
  }
  if (!mainWindow && (event.type === 'notice' || event.type === 'error' || event.type === 'guard')) {
    // There is no window to show this in, so it waits for the next time
    // the app is opened - and the user is told now.
    void rememberNotice(event.message)
    if (Notification.isSupported()) {
      new Notification({ title: 'Drive Mirror', body: event.message }).show()
    }
  }
}

/** Leave a note for the user for something that happened unwatched. */
async function rememberNotice(message: string): Promise<void> {
  const settings = await currentSettings()
  const next = await setPendingNotice(settings, message, new Date())
  await settingsStore.patch({ pendingNotice: next.pendingNotice })
}

/* ------------------------------------------------------------------ */
/* The stored tokens                                                    */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* The Drive client                                                     */
/* ------------------------------------------------------------------ */

const credentialStore = createCredentialStore(
  join(appDataDir(), 'credentials.json'),
  safeStorage,
)

const settingsStore = createSettingsStore(join(appDataDir(), 'settings.json'))

const accountSettingsStore = createAccountSettingsStore(appDataDir())

const accountTokenStore = createAccountTokenStore(appDataDir(), safeStorage)

const accountRegistry = createAccountRegistry({
  root: appDataDir(),
  appSettings: () => currentSettings(),
  saveAppSettings: saveSettings,
  accountSettings: accountSettingsStore,
  tokens: accountTokenStore,
})

/**
 * A valid access token for one account, refreshed when it is about to
 * expire.
 *
 * The token and the refresh belong to the account, so one account's
 * expiry cannot disturb another account's sign-in.
 */
async function accessTokenFor(id: string): Promise<string> {
  const tokens = await accountTokenStore.read(id)
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
  await accountTokenStore.write(id, next)
  return next.access_token
}

/** The Drive clients, one per account, so each has its own sign-in. */
const clients = new Map<string, DriveClient>()

/**
 * Everything one account needs for a run.
 *
 * A Drive file id means nothing outside the account that can see it, so
 * the client and the manifest both belong to the account.
 */
async function accountRuntime(id: string): Promise<AccountRuntime | null> {
  const app = await currentSettings()
  const record = app.accounts.find((account) => account.id === id)
  if (!record) return null
  let accountClient = clients.get(id)
  if (!accountClient) {
    accountClient = createDriveClient(() => accessTokenFor(id))
    clients.set(id, accountClient)
  }
  return {
    id: record.id,
    email: record.email,
    signedIn: await accountTokenStore.has(record.id),
    client: accountClient,
    store: createManifestStore(accountDir(appDataDir(), record.id)),
    settings: () => accountSettingsStore.read(record.id),
  }
}

/**
 * The settings as the user should see them.
 *
 * The client id is not a secret - it appears in the browser's address bar
 * during sign-in - so it is shown. The secret is never read back into the
 * interface; the settings only say whether one is stored.
 */
async function currentSettings(): Promise<AppSettings> {
  const settings = await settingsStore.read()
  return {
    ...settings,
    clientId: credentialStore.getClientId() ?? settings.clientId,
    clientSecretSet: credentialStore.getClientSecret() !== null,
  }
}

/**
 * Save part of the settings.
 *
 * The client id is not written to the settings file: it lives in the
 * encrypted credential store, and the settings only say whether one is
 * stored.
 */
async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await currentSettings()
  const next = { ...current, ...patch }
  await settingsStore.write(next)
  return next
}

/** The id of the account the app is showing, or null when there is none. */
async function currentAccountId(): Promise<string | null> {
  const app = await currentSettings()
  return app.currentAccountId
}

/**
 * The current account's settings: its mirrors, its schedule, its notice.
 *
 * An install with no account has none of them yet, and the defaults say
 * so: no mirrors, no schedule, nothing to sync.
 */
async function currentAccountSettings(): Promise<AccountSettings> {
  const id = await currentAccountId()
  if (!id) return defaultAccountSettings()
  return accountSettingsStore.read(id)
}

/** One account's settings. */
async function accountSettingsFor(id: string): Promise<AccountSettings> {
  return accountSettingsStore.read(id)
}

/** Save part of one account's settings. */
async function saveAccountSettingsFor(
  id: string,
  patch: Partial<AccountSettings>,
): Promise<AccountSettings> {
  const current = await accountSettingsStore.read(id)
  const next = { ...current, ...patch }
  await accountSettingsStore.write(id, next)
  return next
}


/** Where copies of the manifest are kept. */
async function backupPaths(): Promise<string[]> {
  const app = await currentSettings()
  const paths = [appBackupDir(appDataDir())]
  if (app.extraBackupPath) paths.push(app.extraBackupPath)
  return paths
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
    // Which account is this? The app cannot file the sign-in until it
    // knows, so the address is read with a client built over the token
    // that has just come back.
    const fresh = createDriveClient(async () => tokens.access_token)
    const email = await fresh.getAccountEmail()
    if (!email) {
      // The app cannot tell which account this is, so it will not guess.
      throw new Error('the app could not read your Google account address, so it will not sign you in')
    }
    const account = await accountRegistry.signIn(email, tokens)
    await accountRegistry.setCurrent(account.id)
    return { ok: true, email }
  } catch (err) {
    emit({
      type: 'error',
      accountId: null,
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

/**
 * Whether this launch is the Windows task doing one sync and leaving.
 *
 * A scheduled launch must **not** take the single-instance lock. The lock
 * is what makes a second launch quit, and a scheduled run must not quit
 * just because the window happens to be open. The lock *file*, not the
 * instance lock, is what stops two runs at once.
 */
const cli = parseCli(process.argv)
const syncOnce = cli.syncOnce

if (!syncOnce && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (!syncOnce) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
  }

  void app.whenReady().then(async () => {
    // Windows shows a toast with the app's name and icon only when the
    // app has an id of its own.
    app.setAppUserModelId('com.drivemirror.app')

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

    // An install that was made before accounts existed is moved into the
    // account layout first, and it happens before anything reads the
    // settings: the legacy file and the new one share a path.
    await migrateToAccounts({
      root: appDataDir(),
      writeAppSettings: (settings) => settingsStore.write(settings),
      unregisterLegacyTask: async () => {
        await unregisterLegacyTask()
      },
      log: (message: string) => logger.log({ level: 'info', message }),
    })

    // The mirrors are configuration, and the configuration lives with the
    // account they belong to. An app that has synced before already knows
    // them: the manifest holds the names and the roots, and they are
    // recovered from it once, so an upgrade does not hand the user four
    // broken mirrors and a fresh install starts with an empty list.
    const accountSettings = await currentAccountSettings()
    if (accountSettings.mirrors.length === 0) {
      const id = await currentAccountId()
      if (id) {
        const manifest = await createManifestStore(accountDir(appDataDir(), id)).read()
        const recovered = mirrorConfigsFromManifest(manifest)
        if (recovered.length > 0) {
          await saveAccountSettingsFor(id, { mirrors: recovered })
        }
      }
    }

    const runner = createRunner({
      // The account to run, and everything it needs.
      account: (id) => accountRuntime(id),
      // The app's own settings: the guard threshold, the list of accounts.
      appSettings: () => currentSettings(),
      // Where copies of the manifest are kept.
      backupPaths: () => backupPaths(),
      // The runner writes the settings too, when a run resets the
      // missed-slot clock.
      saveAccountSettings: (id, patch) => saveAccountSettingsFor(id, patch),
      emit,
      // The lock that stops a scheduled run and this window from writing
      // the manifest at the same time.
      lockPath: join(appDataDir(), 'sync.lock'),
      log: (message: string) => logger.log({ level: 'warn', message }),
    })

    /**
     * The schedulers, one per account.
     *
     * Each account has its own schedule, its own in-app timer and its own
     * Windows task, named after the account, so two accounts can run at
     * their own times.
     */
    const schedulers = new Map<string, Scheduler>()

    /** The scheduler for an account, made the first time it is needed. */
    function schedulerFor(id: string, email: string): Scheduler {
      const existing = schedulers.get(id)
      if (existing) return existing
      const scheduler = createScheduler({
        accountId: id,
        accountEmail: email,
        settings: () => accountSettingsFor(id),
        saveSettings: (patch) => saveAccountSettingsFor(id, patch),
        runSync: () => runner.syncNow(id),
        now: () => new Date(),
        registerTask: (shape, exePath, nextRunAt) =>
          registerTask(shape, exePath, nextRunAt, id, email),
        unregisterTask: () => unregisterTask(email),
        taskExists: () => taskExists(email),
      // The executable the Windows task launches. In development this is
      // Electron's own binary, which is why the task is only for the
      // packaged app.
      exePath: () => app.getPath('exe'),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      onResume: (fn) => {
        powerMonitor.on('resume', fn)
        return () => powerMonitor.off('resume', fn)
      },
      notify: (title, body) => {
        if (Notification.isSupported()) {
          new Notification({ title, body }).show()
        }
      },
      })
      schedulers.set(id, scheduler)
      return scheduler
    }

    registerIpc({
      runner,
      getSettings: () => currentSettings(),
      saveSettings,
      getAccountSettings: (id: string) => accountSettingsFor(id),
      saveAccountSettings: (id, patch) => saveAccountSettingsFor(id, patch),
      currentAccountId,
      async setCredentials(clientId, clientSecret) {
        try {
          await credentialStore.setCredentials(clientId, clientSecret)
          return { ok: true }
        } catch {
          return { ok: false }
        }
      },
      authenticate,
      async switchAccount(accountId: string) {
        // Which account the app is showing. Everything on screen changes
        // with it: the mirrors, the schedule, the notice.
        await accountRegistry.setCurrent(accountId)
      },
      async forgetAccount(accountId: string) {
        // The account's folder goes, and so does its Windows task: a task
        // that outlives its account keeps firing.
        const app = await currentSettings()
        const account = app.accounts.find((a) => a.id === accountId)
        if (account) await unregisterTask(account.email)
        schedulers.get(accountId)?.stop()
        schedulers.delete(accountId)
        clients.delete(accountId)
        await accountRegistry.forget(accountId)
      },
      async signOut(accountId: string) {
        // The sign-in goes; the manifest, the mirrors and the schedule
        // stay, so signing back in restores the account exactly as it was.
        await accountTokenStore.clear(accountId)
      },
      async openLogFolder() {
        await shell.openPath(join(appDataDir(), 'logs'))
      },
      async showManifest(accountId: string) {
        await shell.openPath(accountManifestPath(appDataDir(), accountId))
      },
      async appIcon() {
        // The interface shows the icon in the top bar. It is sent as a
        // data URL, because the renderer cannot read a file of its own.
        try {
          const data = await readFile(appIconPath())
          return `data:image/png;base64,${data.toString('base64')}`
        } catch {
          return ''
        }
      },
      async chooseFolder() {
        const options = {
          title: 'Choose a folder to mirror',
          properties: ['openDirectory' as const],
        }
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0] ?? null
      },
      async resetConnection() {
        // Every sign-in, the client id and the secret go. The manifests,
        // the mirrors, the schedules and the backups stay: they are the
        // user's work, not the connection's.
        const app = await currentSettings()
        for (const account of app.accounts) {
          await accountTokenStore.clear(account.id)
        }
        await credentialStore.clear()
      },
      async startFreshManifest(accountId: string) {
        // The old manifest is kept, so a change of heart costs nothing.
        const id = accountId
        const archiveDir = join(accountDir(appDataDir(), id), 'manifest-archive')
        await mkdir(archiveDir, { recursive: true })
        const store = createManifestStore(accountDir(appDataDir(), id))
        const manifest = await store.read()
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await writeFile(
          join(archiveDir, `manifest-${stamp}.json`),
          JSON.stringify(manifest, null, 2),
          'utf8',
        )
        await store.write(emptyManifest())
      },
      applySchedule: async (accountId: string) => {
        const app = await currentSettings()
        const account = app.accounts.find((a) => a.id === accountId)
        if (!account) return
        await schedulerFor(account.id, account.email).applySchedule()
      },
      applyAutoLaunch(enabled: boolean) {
        // In development the executable is Electron's own, which is not
        // something to start with Windows.
        if (!app.isPackaged) return
        app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
      },
      onError: (message: string) => {
        emit({ type: 'error', accountId: null, message })
      },
    })

    if (syncOnce) {
      // The Windows task's launch: one sync, no window, then out. The
      // scheduler records when the run happened, so the next slot is
      // measured from this one.
      const accounts = (await currentSettings()).accounts
      const named = cli.accountId
      const targets = named
        ? accounts.filter((account) => account.id === named)
        : accounts
      for (const account of targets) {
        const settings = await accountSettingsFor(account.id)
        if (!settings.schedule.enabled) {
          // The schedule was switched off, or was never turned on. The
          // task has to go, or it will keep firing.
          await unregisterTask(account.email)
          continue
        }
        await schedulerFor(account.id, account.email).runNow()
      }
      app.quit()
      return
    }

    mainWindow = createMainWindow()

    // Fill in the file counts so the window shows the real trees before
    // the first run.
    const currentId = await currentAccountId()
    if (currentId) await runner.prime(currentId)

    // A mirror the user removed more than thirty days ago is forgotten:
    // its history goes, and the copy of the bytes it replaced stays.
    if (currentId) await runner.pruneRemovedMirrors(currentId)

    // Older versions of the app kept a copy of every file it replaced.
    // It does not any more, so the folder goes.
    await clearSupersededStore()

    // The schedules start last, so a run that was missed while the app
    // was closed happens after the window is up and can say so.
    const accounts = (await currentSettings()).accounts
    for (const account of accounts) {
      await schedulerFor(account.id, account.email).start()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

/**
 * Delete the superseded store, which older versions of the app used.
 *
 * The app no longer keeps a copy of anything it replaces, so the folder
 * is dead weight. It is removed once, at start-up, and only if it is
 * there.
 */
async function clearSupersededStore(): Promise<void> {
  const dir = join(appDataDir(), 'superseded')
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) return
  try {
    await rm(dir, { recursive: true, force: true })
    logger.log({ level: 'info', message: `the old superseded store was removed: ${dir}` })
  } catch (err) {
    logger.log({
      level: 'warn',
      message: `the old superseded store could not be removed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    })
  }
}
