# Drive Mirror

Mirrors folders on your computer up to Google Drive, so that a second
machine - or a lost laptop - still has your work.

[![CI](https://github.com/nnagarr/drive-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/nnagarr/drive-mirror/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

You choose the folders. Each one is mirrored to a folder of your Drive, and
the app can do it on a schedule - with the window open or closed.

Files are matched by their **full relative path**, never by their name alone.
Two files called `final.psd` in different folders are two different files,
and the app never guesses which one it means.

## What it will not do

- **It never permanently deletes anything from Drive.** A file you delete locally is moved
  to the **Drive Trash**, where Google keeps it for thirty days and then
  removes it for good. If you delete it by accident, it is still in the Drive
  Trash.
- **It never overwrites a Google-native file.** A Google Doc, Sheet, Slide or
  Drawing is never uploaded over and never trashed. The app keeps a local
  *export* of it (`.pdf`, `.csv`, `.png`), which it can always regenerate.
- **It never writes outside a folder you gave it.** Every run resolves the
  Drive folder first and writes only inside it.
- **It never keeps a copy of your files.** Nothing is stored locally: a file
  that changes is replaced on Drive, and a file that is deleted goes to the
  Drive Trash. The app holds no second copy of anything.
- **It never mixes two Google accounts.** Each account has its own folders,
  its own schedule and its own file list, and one account's sign-in is never
  used with another account's manifest.

> **Replacing a file is not reversible.** Drive keeps no history for ordinary
> files, so the version that was on Drive before is gone once the new one
> goes up. Edit carefully, or keep your own history.

## Adding a folder

Press **Add folder** in the top bar or overview page, choose any folder on your computer,
and give it a name. The Drive folder defaults to the same name under `My Drive`,
and you can customize its destination path anytime.

Folders cannot overlap: a folder nested inside another mirrored folder would be
synced twice, so the app guards against it.

A mirror can be **paused** (it keeps its history and is left alone by a
scheduled run) or **removed**. Removing a mirror leaves the copy in your
Drive exactly as it is.

## Setting up the Google side

This is done once, by hand, in the Google Cloud console. The app guides you through these exact steps upon first launch or under **Settings > App Settings**:

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create a project if you do not have one, and enable the **Google Drive API** for it.
2. Open **APIs and Services > Credentials**, and create an **OAuth client ID**. Choose the **Desktop app** type. A web client will not work: the app signs in through a local loopback address on your machine.
3. Open **OAuth consent screen** and set it to **In production** (or add your email under Test Users if kept in Testing mode). The app asks for the full Drive scope to reliably mirror your chosen folders.
4. Copy the **Client ID** and the **Client Secret** into the app's setup wizard or **Settings** page.

The client secret is entered into the app and stored encrypted with DPAPI on
this machine. **It is never written to the repository, and never leaves your
computer** except to reach Google's token endpoint.

**You only do this once.** The client id identifies the app, not the person,
so every Google account you connect uses the same one. A second account
costs a sign-in, not another trip to the console.

## Using it

Open **Settings**, enter your Client ID and Client Secret, press **Connect an
account**, and complete the sign-in in the browser window that opens. Then press
**Sync now**.

- **Sync now** syncs every folder that is enabled.
- Individual folder actions allow syncing or pausing specific folders.

When nothing has changed, the app says so and stops quietly.

## Running on a schedule

**Settings > Running on a schedule** sets how often the app syncs automatically:
every few hours, every day at a specific time, every few days, or once a week.

There is **one** schedule and **one** way to run it:

- **While the app is open** - an internal timer inside the app.
- **Even when the app is closed** - the app registers a task with Windows Task Scheduler that
  launches it in the background to do one sync and exit.

Only one of the two is active at any time.

> **A Windows task runs only while you are signed in.** The app's credentials
> are encrypted with your Windows account, so a task running under a service
> account could not read them.

## The four guards

The app stops rather than act when something does not look right. Each guard
skips the **whole** tree it applies to:

1. **The local folder is missing.** An unmounted drive looks like an
   empty folder, which would otherwise mean "trash everything". If the folder
   is not there, nothing happens.
2. **The drive changed.** Windows reports the volume serial number of a
   drive. If the drive is now a different disk - a reassigned letter, a swapped
   drive, a USB stick - the app stops and asks you to approve the change.
3. **Too many files disappeared.** If a folder held at least *N* files (5 by
   default) and now holds fewer than half as many, the app stops and asks
   whether you meant it.
4. **The Drive folder is ambiguous.** If more than one folder on Drive has
   the name of one of your mirrors, the app stops rather than guess which one
   you meant.

## Multiple Google accounts

The app supports multiple Google accounts simultaneously. **Each account is isolated**:
its own folders, schedule, file list, and sign-in credentials.

- **Connect another account** signs in to an additional Google account.
- **Sign out** forgets the active sign-in while preserving folder configurations and manifest history.
- **Remove this account** deletes the local ledger, manifest, and scheduled task for that account without touching local or Drive files.

Two accounts never sync at the same time: one waits for the other with an atomic run lock.

## Where things are kept

| What | Where |
| --- | --- |
| An account's folder | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\` |
| An account's manifest | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\manifest.json` |
| An account's sign-in | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\tokens.json` |
| Backups of the manifests | `%LOCALAPPDATA%\DriveMirror\backups\<address>\` |
| Logs | `%LOCALAPPDATA%\DriveMirror\logs\app.log` |
| Encrypted credentials | `%LOCALAPPDATA%\DriveMirror\credentials.json` |

## Building it

```bash
npm install
npm test          # the test suite
npm run typecheck # both TypeScript projects
npm run dev       # run it from source
npm run dist      # build the Windows installer into dist\
```

The installer is built to `dist\Drive-Mirror-1.0.0-Setup.exe`.


## Updates & Releases

The application includes built-in auto-update checking:
- **Automatic Checking**: When enabled in Settings, the app checks for new GitHub releases automatically on startup.
- **On-Demand Checking**: You can manually click "Check for updates" under **Settings > This app**.
- **In-App Notification**: An update banner appears when a new release is available or ready to install, allowing you to download and restart to apply the update seamlessly.

### Publishing a Release

Releases are automated via GitHub Actions:
1. Bump the version in `package.json` (e.g. `"version": "1.0.1"`).
2. Commit the change and push a version tag:
   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```
3. GitHub Actions builds the Windows NSIS installer and publishes `Drive-Mirror-1.0.1-Setup.exe` and `latest.yml` to the GitHub Release. Installed apps detect the update and notify the user.

## Architecture & Code Layout

- `src/core/` - Pure decision engine: diff calculation, guard evaluation, and manifest tracking. No Electron or network dependencies.
- `src/drive/` - Google Drive API client, resumable chunked upload engine, and OAuth token lifecycle.
- `src/main/` - Electron main process, IPC dispatch, Windows Task Scheduler integration, runner lifecycle, and DPAPI credential vault.
- `src/preload/` - Secure IPC bridge with strict context isolation.
- `src/renderer/` - React 19 UI with architectural zinc design tokens, overview drawer, activity feeds, and settings views.
- `test/` - Full test suite including invariant exhaustiveness matrices over all diff states.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines, and
[SECURITY.md](SECURITY.md) for security policy and reporting.
