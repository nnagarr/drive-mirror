/**
 * The preload script.
 *
 * This is the only bridge between the interface and the app. It exposes a
 * fixed set of functions and nothing else: no file access, no modules, no
 * Electron. Every call is a message to the main process, and every rejected
 * promise stays a rejected promise rather than becoming an unhandled
 * rejection in the page.
 *
 * The account-scoped calls may name an account, and leave it out to mean
 * the one on screen. The interface works on the account on screen, so it
 * leaves it out; the extra argument is there for a caller that does not.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, AppState, RunSummary } from '../main/ipc'
import type { AppSettings, ScheduleConfig } from '../main/settings'
import type { AccountSettings } from '../main/accountSettings'

export interface DriveMirrorApi {
  getState(accountId?: string): Promise<AppState>
  syncNow(mirrorName?: string, accountId?: string): Promise<RunSummary>
  overrideGuard(mirrorName: string, accountId?: string): Promise<RunSummary>
  rebase(mirrorName: string, accountId?: string): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Show a different account. */
  switchAccount(accountId: string): Promise<void>
  /** Forget an account: its folder, its task, and its place on the list. */
  forgetAccount(accountId: string): Promise<{ ok: boolean }>
  /** The current account's settings: its mirrors, its schedule, its notice. */
  getAccountSettings(accountId?: string): Promise<AccountSettings>
  saveAccountSettings(
    patch: Partial<AccountSettings>,
    accountId?: string,
  ): Promise<AccountSettings>
  setCredentials(clientId: string, clientSecret: string): Promise<{ ok: boolean }>
  authenticate(): Promise<{ ok: boolean; email?: string }>
  signOut(accountId?: string): Promise<void>
  openLogFolder(): Promise<void>
  showManifest(accountId?: string): Promise<void>
  /** Ask the user for a folder to mirror. */
  chooseFolder(): Promise<string | null>
  addMirror(
    config: {
      name: string
      root: string
      drivePath: string
    },
    accountId?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  updateMirror(
    config: {
      name: string
      drivePath: string
    },
    accountId?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  removeMirror(name: string, accountId?: string): Promise<{ ok: true }>
  setMirrorEnabled(
    name: string,
    enabled: boolean,
    accountId?: string,
  ): Promise<{ ok: true }>
  getSchedule(accountId?: string): Promise<ScheduleConfig>
  saveSchedule(
    patch: Partial<ScheduleConfig>,
    accountId?: string,
  ): Promise<ScheduleConfig>
  /** Forget the Google connection: the token, the client id and the secret. */
  resetConnection(): Promise<{ ok: true }>
  /** Archive the manifest and start a new one, for a different account. */
  startFreshManifest(accountId?: string): Promise<{ ok: boolean }>
  /** Pull a restored file back down to the disk. */
  downloadRestored(
    mirror: string,
    driveFileId: string,
    accountId?: string,
  ): Promise<{ ok: true; path: string } | { ok: false; message: string }>
  /** Open a link in the browser, never inside the app. */
  openExternal(url: string): Promise<void>
  /** The app's icon, as a data the interface can show. */
  appIcon(): Promise<string>
  onEvent(cb: (event: AppEvent) => void): () => void
}

/** The channel the main process sends events on. */
const EVENT_CHANNEL = 'drive-mirror:event'

const api: DriveMirrorApi = {
  getState: (accountId?: string) => ipcRenderer.invoke('drive-mirror:get-state', accountId),
  syncNow: (mirrorName?: string, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:sync-now', accountId, mirrorName),
  overrideGuard: (mirrorName: string, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:override-guard', accountId, mirrorName),
  rebase: (mirrorName: string, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:rebase', accountId, mirrorName),
  getSettings: () => ipcRenderer.invoke('drive-mirror:get-app-settings'),
  saveSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke('drive-mirror:save-app-settings', patch),
  switchAccount: (accountId: string) =>
    ipcRenderer.invoke('drive-mirror:switch-account', accountId),
  forgetAccount: (accountId: string) =>
    ipcRenderer.invoke('drive-mirror:forget-account', accountId),
  getAccountSettings: (accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:get-account-settings', accountId),
  saveAccountSettings: (patch: Partial<AccountSettings>, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:save-account-settings', accountId, patch),
  setCredentials: (clientId: string, clientSecret: string) =>
    ipcRenderer.invoke('drive-mirror:set-credentials', clientId, clientSecret),
  authenticate: () => ipcRenderer.invoke('drive-mirror:authenticate'),
  signOut: (accountId?: string) => ipcRenderer.invoke('drive-mirror:sign-out', accountId),
  openLogFolder: () => ipcRenderer.invoke('drive-mirror:open-log-folder'),
  showManifest: (accountId?: string) => ipcRenderer.invoke('drive-mirror:show-manifest', accountId),
  chooseFolder: () => ipcRenderer.invoke('drive-mirror:choose-folder'),
  addMirror: (
    config: { name: string; root: string; drivePath: string },
    accountId?: string,
  ) => ipcRenderer.invoke('drive-mirror:add-mirror', accountId, config),
  updateMirror: (config: { name: string; drivePath: string }, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:update-mirror', accountId, config),
  removeMirror: (name: string, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:remove-mirror', accountId, name),
  setMirrorEnabled: (name: string, enabled: boolean, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:set-mirror-enabled', accountId, name, enabled),
  getSchedule: (accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:get-schedule', accountId),
  saveSchedule: (patch: Partial<ScheduleConfig>, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:save-schedule', accountId, patch),
  resetConnection: () => ipcRenderer.invoke('drive-mirror:reset-connection'),
  startFreshManifest: (accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:reset-account-history', accountId),
  downloadRestored: (mirror: string, driveFileId: string, accountId?: string) =>
    ipcRenderer.invoke('drive-mirror:download-restored', accountId, mirror, driveFileId),
  openExternal: (url: string) => ipcRenderer.invoke('drive-mirror:open-external', url),
  appIcon: () => ipcRenderer.invoke('drive-mirror:app-icon'),
  onEvent: (cb: (event: AppEvent) => void) => {
    const listener = (_event: unknown, payload: AppEvent): void => cb(payload)
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener)
    }
  },
}

contextBridge.exposeInMainWorld('driveMirror', api)
