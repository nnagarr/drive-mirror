# Drive Mirror

Mirrors four folders on your `E:` drive up to Google Drive, so that a second
machine - or a lost laptop - still has your work.

The four trees are mirrored exactly:

| On this computer | On Drive |
| --- | --- |
| `E:\Medicine` | `My Drive/Medicine` |
| `E:\graphicDesign` | `My Drive/graphicDesign` |
| `E:\videoEditing` | `My Drive/videoEditing` |
| `E:\whoami` | `My Drive/whoami` |

Files are matched by their **full relative path**, never by their name alone.
Two files called `final.psd` in different folders are two different files,
and the app never guesses which one it means.

## What it will not do

- **It never deletes anything from Drive.** A file you delete locally is moved
  to the **Drive Trash**, where Google keeps it for thirty days and then
  removes it for good. If you delete it by accident, it is still in the Drive
  Trash.
- **It never overwrites a Google-native file.** A Google Doc, Sheet, Slide or
  Drawing is never uploaded over and never trashed. The app keeps a local
  *export* of it (`.pdf`, `.csv`, `.png`), which it can always regenerate.
- **It never writes outside the four folders.** Every run resolves the Drive
  folder first and writes only inside it.
- **It never loses the version it is replacing.** Before a Drive file is
  overwritten or trashed, its bytes are copied to the superseded store.

## Setting up the Google side

This is done once, by hand, in the Google Cloud console.

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

## Using it

Open **Settings**, paste the client id and secret, press **Test connection**,
and complete the sign-in in the browser that opens. Then press **Sync now**.

- **Sync now** syncs all four trees.
- **Sync this folder** on a card syncs just that one.

When nothing has changed, the app says so and stops. There is no popup and no
sound: a run that finds nothing to do is the normal case.

## The four guards

The app stops rather than act when something does not look right. Each guard
skips the **whole** tree it applies to - not a folder, not a file.

1. **The local folder is missing.** An unmounted drive looks exactly like an
   empty folder, and an empty folder means "trash everything". If the folder
   is not there, nothing happens.
2. **The drive changed.** Windows reports the volume serial number of a
   drive. If `E:` is now a different disk - a reassigned letter, a swapped
   drive, a USB stick - the app stops and asks you to approve the change.
   Treating every file as "deleted locally" would empty your Drive mirror.
3. **Too many files disappeared.** If a folder held at least *N* files (5 by
   default) and now holds fewer than half as many, the app stops and asks
   whether you meant it. A folder that was emptied completely always stops
   it, however small it was.
4. **The Drive folder is ambiguous.** If more than one folder on Drive has
   the name of one of your trees, the app stops rather than guess which one
   you meant.

A guard that stops a tree keeps the tree's old file counts, so the next run
stops on the same evidence. Only a run that completed - including one you
chose with **Sync anyway** - updates them.

## Where things are kept

| What | Where |
| --- | --- |
| Manifest | `%LOCALAPPDATA%\DriveMirror\manifest.json` |
| Backup of the manifest | `E:\.drive-mirror-backup\manifest.json` |
| Superseded copies | `%LOCALAPPDATA%\DriveMirror\superseded\` |
| Logs | `%LOCALAPPDATA%\DriveMirror\logs\app.log` |
| Encrypted credentials | `%LOCALAPPDATA%\DriveMirror\credentials.json` |

The manifest is the app's memory: it records every file it has synced, with
its content hash, and every file it has stopped tracking. **It is never
pruned**, because dropping a record would resurrect a file you deleted.

## Getting a file back

- **You deleted it locally.** The Drive copy is in the **Drive Trash** for
  thirty days. Restore it from there in the browser. The app will tell you it
  was restored and will **not** download it back into `E:` - your deletion
  stands until you say otherwise. Recreate the file locally and the app will
  restore the Drive copy and give it your new content.
- **The app overwrote the Drive copy.** The old bytes are in the superseded
  store, under `%LOCALAPPDATA%\DriveMirror\superseded\`.
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

The test suite includes an **exhaustiveness matrix**: every combination of
the engine's inputs, checked against the rules the design promises. It is
the test that finds the gaps a per-rule test cannot see.
