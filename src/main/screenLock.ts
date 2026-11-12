import { execFile } from 'node:child_process'

/**
 * Check whether the Windows lock or logon screen is currently active.
 *
 * On Windows, LogonUI.exe runs exclusively to host the lock screen,
 * credential/PIN prompt, and Windows Hello dialog. It exits as soon
 * as the user authenticates and enters their desktop session.
 */
export function isWindowsScreenLocked(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/fi', 'imagename eq logonui.exe'],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(false)
          return
        }
        resolve(stdout.toLowerCase().includes('logonui.exe'))
      },
    )
  })
}
