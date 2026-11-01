import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appDataDir, defaultAppSettings } from '../src/main/settings'
import { defaultAccountSettings } from '../src/main/accountSettings'
import { accountsDir, appBackupDir } from '../src/main/accountPaths'
import { emptyManifest } from '../src/core/manifest'
import { mirrorConfigsFromManifest } from '../src/core/mirrorConfig'

/**
 * What a stranger gets the first time they run this.
 *
 * The app was first written for one person, on one machine, with four
 * folders on an `E:` drive. None of that may leak into a public release:
 * a first install has to know nothing about anybody.
 */
describe('a first install', () => {
  it('starts with no mirrors', () => {
    expect(defaultAccountSettings().mirrors).toEqual([])
  })

  it('finds no mirrors to recover from an empty manifest', () => {
    expect(mirrorConfigsFromManifest(emptyManifest())).toEqual([])
  })

  it('starts with no client and no secret', () => {
    const settings = defaultAppSettings()
    expect(settings.clientId).toBe('')
    expect(settings.clientSecretSet).toBe(false)
  })

  it('starts with no account at all', () => {
    const settings = defaultAppSettings()
    expect(settings.accounts).toEqual([])
    expect(settings.currentAccountId).toBeNull()
  })

  it('starts with the schedule switched off', () => {
    expect(defaultAccountSettings().schedule.enabled).toBe(false)
  })

  it('does not start with Windows', () => {
    expect(defaultAppSettings().startWithWindows).toBe(false)
  })

  it('starts with nothing to tell the user about', () => {
    expect(defaultAppSettings().pendingNotice).toBeNull()
    expect(defaultAccountSettings().pendingNotice).toBeNull()
    expect(defaultAccountSettings().schedule.lastRunAt).toBeNull()
    expect(defaultAccountSettings().schedule.nextRunAt).toBeNull()
  })

  it('keeps everything inside its own data directory', () => {
    const dir = appDataDir()
    for (const path of [accountsDir(dir), appBackupDir(dir)]) {
      expect(path.startsWith(dir)).toBe(true)
    }
    expect(defaultAppSettings().extraBackupPath).toBeNull()
  })

  it('has nothing of the author in the source', async () => {
    // The runtime paths are under the user's own data directory, which is
    // right. What must not exist is a drive letter or a folder name
    // written into the source, because that is the author leaking into
    // everybody else's install.
    const files = await sourceFiles(join(process.cwd(), 'src'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      expect(text, `${file} names a drive`).not.toMatch(/['"`][A-Za-z]:[\\/]/)
      for (const name of ['Medicine', 'graphicDesign', 'videoEditing', 'whoami']) {
        expect(text, `${file} names ${name}`).not.toContain(name)
      }
    }
  })
})

/** Every source file under a directory. */
async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)))
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}
