import { describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => unknown
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: unknown): void => {
      handlers.set(channel, handler as IpcHandler)
    },
  },
  shell: { openExternal: async (): Promise<void> => undefined },
}))

import { registerIpc } from '../src/main/ipc'
import { defaultAppSettings } from '../src/main/settings'
import { defaultAccountSettings } from '../src/main/accountSettings'
import type { IpcDeps } from '../src/main/ipc'

/**
 * Every channel the preload script exposes.
 *
 * The preload script is the only thing the interface can reach, so a
 * channel that is registered but not exposed is dead code, and a channel
 * that is exposed but not registered is a promise that rejects for no
 * reason. The two lists have to agree.
 */
const PRELOAD_CHANNELS = [
  'drive-mirror:get-state',
  'drive-mirror:sync-now',
  'drive-mirror:override-guard',
  'drive-mirror:rebase',
  'drive-mirror:get-app-settings',
  'drive-mirror:save-app-settings',
  'drive-mirror:switch-account',
  'drive-mirror:forget-account',
  'drive-mirror:get-account-settings',
  'drive-mirror:save-account-settings',
  'drive-mirror:set-credentials',
  'drive-mirror:authenticate',
  'drive-mirror:sign-out',
  'drive-mirror:open-log-folder',
  'drive-mirror:show-manifest',
  'drive-mirror:choose-folder',
  'drive-mirror:app-icon',
  'drive-mirror:add-mirror',
  'drive-mirror:update-mirror',
  'drive-mirror:remove-mirror',
  'drive-mirror:set-mirror-enabled',
  'drive-mirror:get-schedule',
  'drive-mirror:save-schedule',
  'drive-mirror:reset-connection',
  'drive-mirror:reset-account-history',
  'drive-mirror:download-restored',
  'drive-mirror:open-external',
]

/** A set of dependencies that do nothing but answer. */
function stubDeps(): IpcDeps {
  return {
    runner: {
      syncNow: async (_accountId: string, _mirrorName?: string) => ({
        startedAt: '',
        finishedAt: '',
        uploaded: 0,
        updated: 0,
        downloaded: 0,
        trashed: 0,
        errors: 0,
        mirrors: [],
        changed: [],
        reports: [],
      }),
      state: async (_accountId: string) => ({
        mirrors: [],
        running: false,
        phase: 'idle',
        lastRun: null,
        accountEmail: null,
        needsAuth: false,
      }),
      prime: async (_accountId: string) => undefined,
      rebase: async (_accountId: string, _mirrorName: string) => undefined,
      moveMirrorDestination: async (
        _accountId: string,
        _mirrorName: string,
        _drivePath: string,
      ) => ({ ok: true }),
      pruneRemovedMirrors: async (_accountId: string) => 0,
      downloadRestored: async (
        _accountId: string,
        _mirrorName: string,
        _driveFileId: string,
      ) => ({ ok: true, path: 'a.txt' }),
    },
    getSettings: async () => defaultAppSettings(),
    saveSettings: async () => defaultAppSettings(),
    getAccountSettings: async (_accountId: string) => defaultAccountSettings(),
    saveAccountSettings: async (_accountId: string, _patch: unknown) => defaultAccountSettings(),
    currentAccountId: async () => 'acc_test',
    switchAccount: async (_accountId: string) => undefined,
    forgetAccount: async (_accountId: string) => undefined,
    setCredentials: async () => ({ ok: true }),
    authenticate: async () => ({ ok: true }),
    signOut: async () => undefined,
    openLogFolder: async () => undefined,
    showManifest: async () => undefined,
    chooseFolder: async () => null,
    appIcon: async () => '',
    resetConnection: async () => undefined,
    startFreshManifest: async () => undefined,
    applySchedule: async () => undefined,
    applyAutoLaunch: () => undefined,
  }
}

describe('the IPC surface', () => {
  it('registers every channel the preload exposes', () => {
    handlers.clear()
    registerIpc(stubDeps())
    for (const channel of PRELOAD_CHANNELS) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('routes an account-scoped call to the account it names', async () => {
    const seen: string[] = []
    const deps = stubDeps()
    deps.runner.state = async (accountId: string) => {
      seen.push(accountId)
      return {
        mirrors: [],
        running: false,
        phase: 'idle',
        lastRun: null,
        accountEmail: null,
        needsAuth: false,
      }
    }
    registerIpc(deps)
    await handlers.get('drive-mirror:get-state')!(null, 'acc_7f3a2b')
    expect(seen).toEqual(['acc_7f3a2b'])
  })

  it('registers no channel twice', () => {
    handlers.clear()
    registerIpc(stubDeps())
    expect(handlers.size).toBe(PRELOAD_CHANNELS.length)
  })
})
