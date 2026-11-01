import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createUpdateManager } from '../src/main/updater'
import type { UpdaterBackend } from '../src/main/updater'

class MockUpdaterBackend extends EventEmitter implements UpdaterBackend {
  checkForUpdates = vi.fn().mockResolvedValue(undefined)
  downloadUpdate = vi.fn().mockResolvedValue(undefined)
  quitAndInstall = vi.fn()
}

describe('UpdateManager', () => {
  it('initializes with idle status and current version', () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    const status = manager.getStatus()
    expect(status.status).toBe('idle')
    expect(status.currentVersion).toBe('1.0.0')
  })

  it('handles check for updates when an update is available', async () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    const changes: string[] = []
    manager.onChange((info) => changes.push(info.status))

    const checkPromise = manager.checkForUpdates()
    expect(manager.getStatus().status).toBe('checking')

    // Simulate backend finding update
    backend.emit('update-available', {
      version: '1.1.0',
      releaseDate: '2026-11-01',
      releaseNotes: 'Fixed sync bug',
    })

    await checkPromise
    const status = manager.getStatus()
    expect(status.status).toBe('available')
    expect(status.availableVersion).toBe('1.1.0')
    expect(status.releaseNotes).toBe('Fixed sync bug')
    expect(changes).toEqual(['checking', 'available'])
  })

  it('automatically downloads update when isAutoDownload returns true', async () => {
    const backend = new MockUpdaterBackend()
    createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
      isAutoDownload: () => true,
    })

    backend.emit('update-available', {
      version: '1.1.0',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(backend.downloadUpdate).toHaveBeenCalled()
  })

  it('does not automatically download update when isAutoDownload returns false', async () => {
    const backend = new MockUpdaterBackend()
    createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
      isAutoDownload: () => false,
    })

    backend.emit('update-available', {
      version: '1.1.0',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(backend.downloadUpdate).not.toHaveBeenCalled()
  })

  it('handles check for updates when no update is available', async () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    const checkPromise = manager.checkForUpdates()
    backend.emit('update-not-available', { version: '1.0.0' })
    await checkPromise

    expect(manager.getStatus().status).toBe('not-available')
  })

  it('tracks download progress and update-downloaded', async () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    await manager.downloadUpdate()
    expect(backend.downloadUpdate).toHaveBeenCalled()

    backend.emit('download-progress', {
      percent: 45.3,
      bytesPerSecond: 1024,
      transferred: 4500,
      total: 10000,
    })

    let status = manager.getStatus()
    expect(status.status).toBe('downloading')
    expect(status.progress).toBe(45)
    expect(status.transferred).toBe(4500)
    expect(status.total).toBe(10000)

    backend.emit('update-downloaded', { version: '1.1.0' })
    status = manager.getStatus()
    expect(status.status).toBe('downloaded')
  })

  it('handles backend errors gracefully', async () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    backend.emit('error', new Error('Network connection failed'))
    const status = manager.getStatus()
    expect(status.status).toBe('error')
    expect(status.error).toContain('Network connection failed')
  })

  it('prevents concurrent checks', async () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    const p1 = manager.checkForUpdates()
    const p2 = manager.checkForUpdates()

    backend.emit('update-not-available', {})
    await Promise.all([p1, p2])

    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('safely handles unpackaged (dev) mode without throwing', async () => {
    const backend = new MockUpdaterBackend()
    backend.checkForUpdates.mockRejectedValue(new Error('Cannot check for updates because app is not packed'))
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: false,
    })

    const res = await manager.checkForUpdates()
    expect(res.status).toBe('not-available')
    expect(backend.checkForUpdates).not.toHaveBeenCalled()
  })

  it('calls quitAndInstall on installUpdate only when downloaded', () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    // Ignored when not downloaded
    manager.installUpdate()
    expect(backend.quitAndInstall).not.toHaveBeenCalled()

    // Allowed when downloaded
    backend.emit('update-downloaded', { version: '1.1.0' })
    manager.installUpdate()
    expect(backend.quitAndInstall).toHaveBeenCalled()
  })

  it('deduplicates concurrent downloadUpdate calls and sets downloading status immediately', async () => {
    const backend = new MockUpdaterBackend()
    backend.downloadUpdate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    const d1 = manager.downloadUpdate()
    expect(manager.getStatus().status).toBe('downloading')
    const d2 = manager.downloadUpdate()
    await Promise.all([d1, d2])

    expect(backend.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not interrupt an active download when checkForUpdates is called', async () => {
    const backend = new MockUpdaterBackend()
    backend.downloadUpdate.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)))
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    void manager.downloadUpdate()
    expect(manager.getStatus().status).toBe('downloading')

    const res = await manager.checkForUpdates()
    expect(res.status).toBe('downloading')
    expect(backend.checkForUpdates).not.toHaveBeenCalled()
  })

  it('treats GitHub 406 / no published releases error as not-available instead of crashing', () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    backend.emit(
      'error',
      new Error(
        'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/nnagarr/drive-mirror/releases/latest), please ensure a production release exists: HttpError: 406 "method: GET url: https://github.com/nnagarr/drive-mirror/releases\n\n Data:\n \n " Headers: { ... }'
      )
    )

    const status = manager.getStatus()
    expect(status.status).toBe('not-available')
    expect(status.error).toBeUndefined()
  })

  it('sanitizes long XML/header error strings into clean error messages', () => {
    const backend = new MockUpdaterBackend()
    const manager = createUpdateManager({
      backend,
      currentVersion: '1.0.0',
      isPackaged: true,
    })

    backend.emit(
      'error',
      new Error(
        'Cannot find channelFile in the latest release artifacts, XML: <?xml version="1.0"?> Headers: {...}'
      )
    )

    const status = manager.getStatus()
    expect(status.status).toBe('error')
    expect(status.error).toBe('Cannot find channelFile in the latest release artifacts')
  })
})

