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
  revealSuperseded(): Promise<void>
  pruneSuperseded(): Promise<{ freedBytes: number }>
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
  revealSuperseded: () => ipcRenderer.invoke('drive-mirror:reveal-superseded'),
  pruneSuperseded: () => ipcRenderer.invoke('drive-mirror:prune-superseded'),

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
