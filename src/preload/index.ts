/**
 * The preload script.
 *
 * This is the only bridge between the interface and the app. It exposes a
 * fixed set of functions and nothing else: no file access, no modules, no
 * Electron. Every call is a message to the main process, and every rejected
 * promise stays a rejected promise rather than becoming an unhandled
 * rejection in the page.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, AppState, RunSummary } from '../main/ipc'
import type { Settings } from '../main/settings'
import type { ScheduleConfig } from '../main/settings'

export interface DriveMirrorApi {
  getState(): Promise<AppState>
  syncNow(mirrorName?: string): Promise<RunSummary>
  overrideGuard(mirrorName: string): Promise<RunSummary>
  rebase(mirrorName: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  setCredentials(clientId: string, clientSecret: string): Promise<{ ok: boolean }>
  authenticate(): Promise<{ ok: boolean; email?: string }>
  signOut(): Promise<void>
  openLogFolder(): Promise<void>
  showManifest(): Promise<void>
  /** Ask the user for a folder to mirror. */
  chooseFolder(): Promise<string | null>
  addMirror(config: {
    name: string
    root: string
    drivePath: string
  }): Promise<{ ok: true } | { ok: false; message: string }>
  updateMirror(config: {
    name: string
    drivePath: string
  }): Promise<{ ok: true } | { ok: false; message: string }>
  removeMirror(name: string): Promise<{ ok: true }>
  setMirrorEnabled(name: string, enabled: boolean): Promise<{ ok: true }>
  getSchedule(): Promise<ScheduleConfig>
  saveSchedule(patch: Partial<ScheduleConfig>): Promise<ScheduleConfig>
  /** Forget the Google connection: the token, the client id and the secret. */
  resetConnection(): Promise<{ ok: true }>
  /** Archive the manifest and start a new one, for a different account. */
  startFreshManifest(): Promise<{ ok: true }>
  /** Pull a restored file back down to the disk. */
  downloadRestored(
    mirror: string,
    driveFileId: string,
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
  getState: () => ipcRenderer.invoke('drive-mirror:get-state'),
  syncNow: (mirrorName?: string) => ipcRenderer.invoke('drive-mirror:sync-now', mirrorName),
  overrideGuard: (mirrorName: string) =>
    ipcRenderer.invoke('drive-mirror:override-guard', mirrorName),
  rebase: (mirrorName: string) => ipcRenderer.invoke('drive-mirror:rebase', mirrorName),
  getSettings: () => ipcRenderer.invoke('drive-mirror:get-settings'),
  saveSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('drive-mirror:save-settings', patch),
  setCredentials: (clientId: string, clientSecret: string) =>
    ipcRenderer.invoke('drive-mirror:set-credentials', clientId, clientSecret),
  authenticate: () => ipcRenderer.invoke('drive-mirror:authenticate'),
  signOut: () => ipcRenderer.invoke('drive-mirror:sign-out'),
  openLogFolder: () => ipcRenderer.invoke('drive-mirror:open-log-folder'),
  showManifest: () => ipcRenderer.invoke('drive-mirror:show-manifest'),
  chooseFolder: () => ipcRenderer.invoke('drive-mirror:choose-folder'),
  addMirror: (config) => ipcRenderer.invoke('drive-mirror:add-mirror', config),
  updateMirror: (config) => ipcRenderer.invoke('drive-mirror:update-mirror', config),
  removeMirror: (name: string) => ipcRenderer.invoke('drive-mirror:remove-mirror', name),
  setMirrorEnabled: (name: string, enabled: boolean) =>
    ipcRenderer.invoke('drive-mirror:set-mirror-enabled', name, enabled),
  getSchedule: () => ipcRenderer.invoke('drive-mirror:get-schedule'),
  saveSchedule: (patch: Partial<ScheduleConfig>) =>
    ipcRenderer.invoke('drive-mirror:save-schedule', patch),
  resetConnection: () => ipcRenderer.invoke('drive-mirror:reset-connection'),
  startFreshManifest: () => ipcRenderer.invoke('drive-mirror:start-fresh-manifest'),
  downloadRestored: (mirror: string, driveFileId: string) =>
    ipcRenderer.invoke('drive-mirror:download-restored', mirror, driveFileId),
  openExternal: (url: string) => ipcRenderer.invoke('drive-mirror:open-external', url),
  appIcon: () => ipcRenderer.invoke('drive-mirror:app-icon'),

  onEvent(cb: (event: AppEvent) => void): () => void {
    const listener = (_event: unknown, payload: AppEvent): void => {
      try {
        cb(payload)
      } catch {
        // A broken listener must not take the app down with it.
      }
    }
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener)
    }
  },
}

contextBridge.exposeInMainWorld('driveMirror', api)
