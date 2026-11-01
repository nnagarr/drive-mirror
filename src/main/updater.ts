/**
 * Update Manager.
 *
 * Coordinates update lifecycle: checking, downloading, progress tracking,
 * and installing updates. Wraps electron-updater's autoUpdater behind an
 * interface to decouple from Electron during unit tests and protect against
 * crashes in unpackaged development environments.
 */

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateInfo {
  status: UpdateState
  currentVersion: string
  availableVersion?: string
  releaseDate?: string
  releaseNotes?: string
  progress?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
}

export interface UpdaterBackend {
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: string, listener: (...args: any[]) => void): this
  off?(event: string, listener: (...args: any[]) => void): this
}

function cleanErrorMessage(err: unknown): { isNoRelease: boolean; message: string } {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown update error')
  const isNoRelease =
    raw.includes('Unable to find latest version on GitHub') ||
    raw.includes('No published versions on GitHub') ||
    raw.includes('ERR_UPDATER_LATEST_VERSION_NOT_FOUND') ||
    raw.includes('ERR_UPDATER_NO_PUBLISHED_VERSIONS') ||
    (raw.includes('406') && raw.includes('releases'))

  const message = raw.split('\n')[0]!.split(', XML:')[0]!.split(',\nXML:')[0]!.split('Headers:')[0]!.trim()
  return { isNoRelease, message }
}

export interface UpdateManagerDeps {
  backend: UpdaterBackend
  currentVersion: string
  isPackaged?: boolean
  log?: (message: string) => void
}

export interface UpdateManager {
  getStatus(): UpdateInfo
  checkForUpdates(): Promise<UpdateInfo>
  downloadUpdate(): Promise<void>
  installUpdate(): void
  onChange(listener: (info: UpdateInfo) => void): () => void
}

/**
 * Creates an UpdateManager instance.
 */
export function createUpdateManager(deps: UpdateManagerDeps): UpdateManager {
  const isPackaged = deps.isPackaged ?? true
  const listeners = new Set<(info: UpdateInfo) => void>()

  let currentStatus: UpdateInfo = {
    status: 'idle',
    currentVersion: deps.currentVersion,
  }

  let activeCheckPromise: Promise<UpdateInfo> | null = null
  let activeDownloadPromise: Promise<void> | null = null

  function setStatus(next: Partial<UpdateInfo>): void {
    currentStatus = { ...currentStatus, ...next }
    for (const listener of listeners) {
      try {
        listener(currentStatus)
      } catch (err) {
        deps.log?.(`Update listener threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Bind backend events
  deps.backend.on('checking-for-update', () => {
    setStatus({ status: 'checking', error: undefined })
  })

  deps.backend.on('update-available', (info: any) => {
    const availableVersion = info?.version ? String(info.version) : undefined
    const releaseDate = info?.releaseDate ? String(info.releaseDate) : undefined
    const releaseNotes = typeof info?.releaseNotes === 'string'
      ? info.releaseNotes
      : Array.isArray(info?.releaseNotes)
        ? info.releaseNotes.map((n: any) => n.note ?? '').join('\n')
        : undefined

    setStatus({
      status: 'available',
      availableVersion,
      releaseDate,
      releaseNotes,
      error: undefined,
    })
  })

  deps.backend.on('update-not-available', () => {
    setStatus({
      status: 'not-available',
      error: undefined,
    })
  })

  deps.backend.on('download-progress', (progress: any) => {
    const percent = typeof progress?.percent === 'number' ? Math.round(progress.percent) : undefined
    const bytesPerSecond = typeof progress?.bytesPerSecond === 'number' ? progress.bytesPerSecond : undefined
    const transferred = typeof progress?.transferred === 'number' ? progress.transferred : undefined
    const total = typeof progress?.total === 'number' ? progress.total : undefined

    setStatus({
      status: 'downloading',
      progress: percent,
      bytesPerSecond,
      transferred,
      total,
      error: undefined,
    })
  })

  deps.backend.on('update-downloaded', (info: any) => {
    setStatus({
      status: 'downloaded',
      availableVersion: info?.version ? String(info.version) : currentStatus.availableVersion,
      progress: 100,
      error: undefined,
    })
  })

  deps.backend.on('error', (err: any) => {
    const { isNoRelease, message } = cleanErrorMessage(err)
    deps.log?.(`Updater error: ${message}`)
    if (isNoRelease) {
      setStatus({ status: 'not-available', error: undefined })
    } else {
      setStatus({ status: 'error', error: message })
    }
  })

  return {
    getStatus(): UpdateInfo {
      return { ...currentStatus }
    },

    async checkForUpdates(): Promise<UpdateInfo> {
      if (!isPackaged) {
        deps.log?.('Skipping auto-updater check in unpackaged environment')
        setStatus({ status: 'not-available', error: undefined })
        return currentStatus
      }

      if (currentStatus.status === 'downloading' || activeDownloadPromise) {
        return currentStatus
      }

      if (currentStatus.status === 'checking' && activeCheckPromise) {
        return activeCheckPromise
      }

      setStatus({ status: 'checking', error: undefined })

      activeCheckPromise = (async () => {
        try {
          await deps.backend.checkForUpdates()
        } catch (err) {
          const { isNoRelease, message } = cleanErrorMessage(err)
          deps.log?.(`Check for updates failed: ${message}`)
          if (isNoRelease) {
            setStatus({ status: 'not-available', error: undefined })
          } else {
            setStatus({ status: 'error', error: message })
          }
        } finally {
          activeCheckPromise = null
        }
        return currentStatus
      })()

      return activeCheckPromise
    },

    async downloadUpdate(): Promise<void> {
      if (!isPackaged) {
        deps.log?.('Skipping update download in unpackaged environment')
        return
      }

      if (activeDownloadPromise) {
        return activeDownloadPromise
      }

      if (currentStatus.status === 'downloaded') {
        return
      }

      setStatus({ status: 'downloading', progress: 0, error: undefined })

      activeDownloadPromise = (async () => {
        try {
          await deps.backend.downloadUpdate()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err ?? 'Failed to download update')
          deps.log?.(`Download update failed: ${message}`)
          setStatus({ status: 'error', error: message })
        } finally {
          activeDownloadPromise = null
        }
      })()

      return activeDownloadPromise
    },

    installUpdate(): void {
      if (!isPackaged) {
        deps.log?.('Cannot quit and install in unpackaged environment')
        return
      }
      if (currentStatus.status !== 'downloaded') {
        deps.log?.('Cannot install update: no update has been downloaded')
        return
      }
      deps.backend.quitAndInstall()
    },

    onChange(listener: (info: UpdateInfo) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Real backend adapter wrapping electron-updater's autoUpdater.
 */
export class ElectronAutoUpdaterBackend implements UpdaterBackend {
  private updater: any

  constructor(autoUpdaterInstance: any) {
    this.updater = autoUpdaterInstance
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true
  }

  checkForUpdates(): Promise<unknown> {
    return this.updater.checkForUpdates()
  }

  downloadUpdate(): Promise<unknown> {
    return this.updater.downloadUpdate()
  }

  quitAndInstall(): void {
    this.updater.quitAndInstall(false, true)
  }

  on(event: string, listener: (...args: any[]) => void): this {
    this.updater.on(event, listener)
    return this
  }

  off(event: string, listener: (...args: any[]) => void): this {
    if (typeof this.updater.off === 'function') {
      this.updater.off(event, listener)
    } else if (typeof this.updater.removeListener === 'function') {
      this.updater.removeListener(event, listener)
    }
    return this
  }
}

