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

Press **Add a folder** in the top bar, choose the folder on your computer, and
give it a name. The Drive folder defaults to the same name under `My Drive`,
and you can put it somewhere else - `Archive/Photos`, say - or change it later.
Changing it **moves** the folder on Drive rather than copying it, so nothing
is uploaded again.

Two folders cannot overlap: a folder inside another mirror's folder would be
synced twice, so the app refuses it.

A mirror can be **paused** (it keeps its history and is left alone by a
scheduled run) or **removed**. Removing a mirror leaves the copy in your
Drive exactly as it is. The app forgets the mirror's history after thirty
days; the files on Drive are not touched at any point.

## Setting up the Google side

This is done once, by hand, in the Google Cloud console. The app has the same
steps written out, with a button for each page, under **Settings > How do I
get a client id and secret?**

1. Open the **Google Cloud console**, create a project if you do not have
   one, and enable the **Google Drive API** for it.
2. Open **APIs and Services > Credentials**, and create an **OAuth client
   ID**. Choose the **Desktop app** type. A web client will not work: the app
   signs in through a loopback address on your own machine.
3. Open **OAuth consent screen** and set it to **In production**. The app
   asks for the full Drive scope, which Google only grants to apps that are
   in production.
4. Copy the **client id** and the **client secret** into the app's
   **Settings** dialog.

The client secret is entered into the app and stored encrypted with DPAPI on
this machine. **It is never written to the repository, and never leaves your
computer** except to reach Google's token endpoint, which is what it is for.

**You only do this once.** The client id identifies the app, not the person,
so every Google account you connect uses the same one. A second account
costs a sign-in, not another trip to the console.

## Using it

Open **Settings**, paste the client id and secret, press **Connect an
account**, and complete the sign-in in the browser that opens. Then press
**Sync now**.

- **Sync now** syncs every folder that is enabled.
- **Sync this folder** on a card syncs just that one.

When nothing has changed, the app says so and stops. There is no popup and no
sound: a run that finds nothing to do is the normal case.

## Running on a schedule

**Settings > Running on a schedule** sets how often the app syncs on its own:
every few hours, every day at a time, every few days, or once a week on a day
you pick.

There is **one** schedule and **one** way to run it:

- **While the app is open** - a timer inside the app.
- **Even when the app is closed** - the app registers a task with Windows that
  launches it to do one sync and leave.

Only one of the two is ever on, because two would mean two syncs per slot.

> **A Windows task runs only while you are signed in.** The app's credentials
> are encrypted with your Windows account, so a task that ran under a service
> account could not read them. The trade is that "every 6 hours" means "every
> 6 hours of a signed-in session, with the machine on".

A slot the machine slept through is not lost: the app checks the clock when it
wakes and runs once if a run was missed.

## The four guards

The app stops rather than act when something does not look right. Each guard
skips the **whole** tree it applies to - not a folder, not a file.

1. **The local folder is missing.** An unmounted drive looks exactly like an
   empty folder, and an empty folder means "trash everything". If the folder
   is not there, nothing happens.
2. **The drive changed.** Windows reports the volume serial number of a
   drive. If the drive is now a different disk - a reassigned letter, a swapped
   drive, a USB stick - the app stops and asks you to approve the change.
   Treating every file as "deleted locally" would empty your Drive mirror.
3. **Too many files disappeared.** If a folder held at least *N* files (5 by
   default) and now holds fewer than half as many, the app stops and asks
   whether you meant it. A folder that was emptied completely always stops
   it, however small it was.
4. **The Drive folder is ambiguous.** If more than one folder on Drive has
   the name of one of your mirrors, the app stops rather than guess which one
   you meant.

A guard that stops a tree keeps the tree's old file counts, so the next run
stops on the same evidence. Only a run that completed - including one you
chose with **Sync anyway** - updates them.

## More than one Google account

The app can hold several Google accounts at once. **An account is a separate
world**: its own folders, its own schedule, its own file list, its own
sign-in. The account on screen is chosen from the dropdown in the top bar,
and everything you see belongs to it.

- **Connect another account** (in the dropdown, or **Connect an account** in
  Settings) signs in to a second Google account. An address the app has seen
  before is signed back in, with everything it knew; a new address makes a
  new account.
- **Sign out of this account** forgets the sign-in and nothing else. The
  folders, the schedule and the file list stay, so signing back in restores
  the account exactly as it was.
- **Forget this account** deletes the account's folder and its scheduled
  task, for good. The copies of its manifest in the backup folders are
  kept, so the file list can be recovered by hand. The files already on
  Drive are not touched.
- **Reset the connection** (Settings) signs every account out and forgets
  the client id and the secret. Every manifest, folder list and schedule
  stays.

The same folder can be mirrored into two accounts. They are then two
separate mirrors with two separate file lists, and a file deleted on the
disk is trashed on both Drives.

Two accounts never sync at the same time: one waits for the other, and
nothing is dropped. A run that is finally given up on says so, and its
slot is caught up at the next tick rather than lost.

## Where things are kept

| What | Where |
| --- | --- |
| An account's folder | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\` |
| An account's manifest | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\manifest.json` |
| An account's sign-in | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\tokens.json` |
| Backups of the manifests | `%LOCALAPPDATA%\DriveMirror\backups\<address>\` and any extra copy you name |
| Logs | `%LOCALAPPDATA%\DriveMirror\logs\app.log` |
| Encrypted credentials | `%LOCALAPPDATA%\DriveMirror\credentials.json` |
| The layout from before accounts existed | `%LOCALAPPDATA%\DriveMirror\legacy\` |

The manifest is the app's memory: it records every file it has synced, with
its content hash, and every file it has stopped tracking. **It is never
pruned**, because dropping a record would resurrect a file you deleted. The
one exception is a mirror you removed: thirty days later the app forgets that
mirror's history entirely, retired records and all.

A backup copy that cannot be written never fails a sync. It is reported
instead, because a safety net that quietly stops being refreshed is worse
than one that says so.

## Getting a file back

- **You deleted it locally.** The Drive copy is in the **Drive Trash** for
  thirty days. Restore it from there in the browser. The app lists it on the
  card, under **Waiting to be brought back**, and **Download to this
  computer** puts it back on your disk. Nothing is downloaded until you ask
  for it, and nothing already at that path is ever replaced.
- **The app overwrote the Drive copy.** The old bytes are gone. Drive keeps
  no history for ordinary files, and the app keeps no copy of its own.
- **The drive changed.** The app stops and asks you to approve the new
  volume. Your old files on Drive are untouched.

## Building it

```bash
npm install
npm test          # the test suite
npm run typecheck # both TypeScript projects
npm run dev       # run it from source
npm run dist      # build the Windows installer into dist\
```

The installer is `dist\Drive-Mirror-1.0.0-Setup.exe`.

## For developers

The app is a single decision core and a thin shell around it.

- `src/core/` - the rules. What to sync, what not to, and why. No Electron,
  no network.
- `src/drive/` - the only code that talks to Google.
- `src/main/` - the Electron main process: the window, the IPC bridge and
  the runner that ties the two together.
- `src/renderer/` - the interface. It has no file access and no network
  access; it calls the main process through a fixed set of channels.
- `test/` - the tests.
- `docs/superpowers/` - the design document and the implementation plan the
  code was built from. Worth reading before changing a rule.

The test suite includes an **exhaustiveness matrix**: every combination of
the engine's inputs, checked against the rules the design promises. It is
the test that finds the gaps a per-rule test cannot see.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is laid out, and
[SECURITY.md](SECURITY.md) for what the app holds and how to report a
problem.
