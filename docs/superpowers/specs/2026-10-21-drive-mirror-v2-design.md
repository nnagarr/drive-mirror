# Drive Mirror v2 — design spec

**Date:** 2026-10-21
**Status:** draft for approval
**Supersedes:** nothing. `2026-10-21-drive-mirror-design.md` (rev 10) remains the base spec; this document adds to it and amends the two places named in §8.

---

## 1. Intent and the why

Drive Mirror v1 mirrors four fixed `E:\` trees to Google Drive. It works, it has been live-tested against a real Drive, and it never deletes anything. It is not yet usable by anyone else, for three reasons:

1. The four folders are a hardcoded constant (`src/main/runner.ts:48-53`). A different person cannot point it at their own folders, and a different person without an `E:` drive cannot run it at all.
2. It only syncs when a human presses a button. A backup that needs a human to remember is not a backup.
3. The four trees are named in the source, the manifest key is the tree's name, the backup path is the literal string `E:\.drive-mirror-backup\`, and the Drive folder name is derived from the tree's name. Every one of those is an assumption about one person's computer baked into the code.

On top of those, the user asked for four things in one round: **folders you choose**, **a schedule**, **a real icon**, and **a way to clear the Google connection and put a new one in place** — plus instructions in the app for getting an OAuth client in the first place.

The "why" of all four is the same: the app should be usable by someone who is not the author, on a machine that is not the author's, without reading the source to work out what to edit.

---

## 2. Goals

| # | Goal |
|---|---|
| G1 | The user picks the folders to mirror. The four `E:` trees become ordinary, pre-seeded mirrors the user may edit, pause, or remove. |
| G2 | A sync can run on a schedule, with or without the app open. |
| G3 | The app has a real icon on disk, in the installer, in the taskbar, and in its own UI. |
| G4 | The user can clear the Google connection, put a different one in place, and be told plainly what that will do to their existing mirror history. |
| G5 | A user with no OAuth client can get one from inside the app, without leaving it to guess. |
| G6 | The app runs on a machine with no `E:` drive. No path in `src/` is a hardcoded `E:`. |
| G7 | The test suite cannot write to any path the real app uses. |
| G8 | The last unbuilt promise in the base spec (rule R1, "Download to E:") is built. |

## 3. Non-goals

- Multiple Google accounts at once. One account per app, always.
- Per-mirror schedules. One global schedule.
- Shared drives, other users' `My Drive`, or any Drive location outside a configured mirror's destination.
- Per-file download for arbitrary Drive files. "Download to E:" covers only files the app itself trashed and the user then restored.
- macOS or Linux support. Windows only.
- Any UI framework. The renderer stays plain React + plain CSS.

## 4. Anti-goals — the things that must never happen

1. Nothing is ever permanently deleted from Drive. Trash only.
2. Nothing is ever written to a Drive location outside a configured mirror's destination.
3. The manifest is never destroyed by a connection reset, an account change, or an uninstall.
4. A failed backup write never fails a sync.
5. A test run never writes to a path the real app uses.

---

## 5. Decisions

Every decision below was made in conversation with the user. The table is the record.

| # | Area | Decision |
|---|---|---|
| D1 | Schedule mechanism | **Both**, as alternatives: an in-app timer, or a Windows Task Scheduler task that launches the app when it is closed. **Only one is ever active.** |
| D2 | Schedule shapes | All four: every N hours, daily at HH:MM, every N days, weekly on a chosen day at a chosen time. |
| D3 | Missed runs | One run at start-up if a slot was missed. Not one run per missed slot. |
| D4 | Scheduled failure notice | A Windows toast, plus a banner the next time the app opens. |
| D5 | Schedule scope | One global schedule for all enabled mirrors. |
| D6 | What a mirror is | The user picks a local folder. The Drive destination defaults to `My Drive/<folder name>` and is editable to any path under `My Drive`. |
| D7 | Removing a mirror | The Drive content is left completely alone. The app forgets the mirror. |
| D8 | Overlapping folders | Blocked. A folder may not be inside another mirror's root, and may not contain one. |
| D9 | Mirror identity | The mirror's **name** is the key, and names are unique (case-insensitively). No manifest migration. |
| D10 | Changing a destination | The Drive folder is **moved** to the new parent. File ids stay valid; the manifest stays valid. |
| D11 | Removing a mirror's history | Kept for **30 days**, then forgotten entirely — including its retired records. **This amends the base spec's never-prune rule; see §8.** |
| D12 | Disconnect | Two separate actions: "Sign out of Google" (tokens only) and "Reset connection" (tokens + client id + secret). Neither touches the manifest, the mirror list, the schedule, or the backups. |
| D13 | Account switch | Blocked. The app names both accounts and offers to start a fresh manifest, archiving the old one. |
| D14 | Setup guide | A first-run wizard when there is no client id, plus a "How do I get these?" link in Settings. |
| D15 | Backups | One copy beside the manifest, plus an optional second copy on another drive. The existing `E:\.drive-mirror-backup\` becomes that optional second copy on this machine. |
| D16 | Icon | "Two panes": a blue tile, a mint rounded square behind, a white rounded square in front. |
| D17 | Download to E: | Build it. It is the one gap left in the base spec. |
| D18 | Start with Windows | A toggle in Settings, **off by default**. |
| D19 | Enabling a schedule | Does not trigger an immediate sync. The manual "Sync now" is there for that. |
| D20 | Per-mirror enable/disable | Every mirror card gets a pause toggle. A paused mirror keeps its history and is skipped by scheduled runs. |

### D1 in detail — the one schedule, two mechanisms

The user picks **one** mechanism. The schedule shape is shared by both.

- `in-app` — a timer inside the main process. Only fires while the app is running.
- `windows-task` — the app registers a task with `schtasks.exe` that launches `Drive Mirror.exe --sync-once`. The app runs one sync headlessly and exits.

Only one can be active, because both firing would mean two syncs per slot.

**Constraint the user was told about, and accepts:** a task registered for the current user runs **only while that user is signed in**. The app's credentials are encrypted with DPAPI and cannot be decrypted from a locked-down service context. "Every 6 hours" therefore means "every 6 hours of a signed-in session, machine on". This is not fixable without storing the Windows password in the task, which the app will not do.

---

## 6. Data model

### 6.1 `Settings` (`src/main/settings.ts`)

```ts
/** One folder the user chose to mirror. */
export interface MirrorConfig {
  /** Unique, case-insensitively. This is the manifest key. */
  name: string
  /** Absolute local path. */
  root: string
  /** Destination under My Drive, e.g. "Photos" or "Archive/Photos". */
  drivePath: string
  /** False when the mirror is paused. */
  enabled: boolean
  /** ISO timestamp. Set when the mirror is removed. */
  removedAt?: string
}

/** How often the app syncs on its own. */
export type ScheduleShape =
  | { kind: 'every-hours'; everyHours: number }
  | { kind: 'daily'; at: string }              // "HH:MM", local time
  | { kind: 'every-days'; everyDays: number }
  | { kind: 'weekly'; day: number; at: string } // day: 0 = Sunday

export interface ScheduleConfig {
  enabled: boolean
  shape: ScheduleShape
  /** 'in-app' or 'windows-task'. Never both. */
  mechanism: 'in-app' | 'windows-task'
  /** When the last run finished, for missed-run detection. */
  lastRunAt: string | null
  /** When the next run is due. Computed, shown in the UI. */
  nextRunAt: string | null
}

export interface Settings {
  clientId: string
  clientSecretSet: boolean
  manifestPath: string
  /** Extra places to keep a copy of the manifest. */
  backupPaths: string[]
  supersededPath: string
  guardThreshold: number
  /** The mirrors the user has configured. */
  mirrors: MirrorConfig[]
  schedule: ScheduleConfig
  /** Start with Windows. */
  startWithWindows: boolean
  /** A problem from a run the user did not watch, shown once. */
  pendingNotice: { message: string; at: string } | null
}
```

**Where the mirror list lives, and why:** the mirror list is *configuration*; the manifest is *history*. The manifest must survive a settings wipe, and the configuration must be editable without touching the history. So the list lives in `settings.json` and the history stays in `manifest.json`.

`backupPaths` replaces the single `backupPath`. The first entry is the local copy beside the manifest; the rest are extra copies the user names. **Writing any backup copy is best-effort: a failure is logged and the sync continues.**

### 6.2 `Manifest` (`src/core/types.ts`)

```ts
export interface Manifest {
  version: number            // 10 -> 11
  updatedAt: string
  volumes: Record<string, { dev: number; label?: string; checkedAt: string }>
  mirrors: Record<string, MirrorManifest>
  /** The Google account that owns this Drive data. Null until first sync. */
  accountEmail: string | null
}
```

`MirrorManifest` gains one field:

```ts
export interface MirrorManifest {
  root: string
  /** The destination under My Drive, e.g. "Archive/Photos". */
  drivePath?: string
  driveFolderId?: string
  driveFolderName?: string
  ...
}
```

**Migration:** version 11 is read and written; a version 10 manifest is read as-is and gains `accountEmail: null` on first write. The four existing mirrors keep their names, their roots, their 254 tracked files and their `lastCounts`. **No migration step, no data movement.**

### 6.3 The account binding

The manifest records the Google account that owns the Drive data. Before a sync, the runner compares it with the signed-in account:

- No account recorded (a fresh or pre-v11 manifest) → record the signed-in account and continue.
- Recorded account === signed-in account → continue.
- They differ → **block the whole run**, name both accounts, and offer "Start a new manifest for this account". That action archives the current manifest to `superseded/manifest-<timestamp>.json`, writes a fresh empty manifest, and re-records the new account.

---

## 7. Behaviour

### 7.1 Adding a folder

1. The user presses **Add folder** in the top bar.
2. The main process opens a native directory picker (`dialog.showOpenDialog`, `properties: ['openDirectory']`). **This is the first use of Electron's `dialog` module in this codebase.**
3. The chosen path is offered as: **Name** (prefilled with the folder's basename, editable) and **Drive folder** (prefilled with the name, editable — `My Drive/Archive/Photos` style, entered relative to `My Drive`).
4. The app validates and, if it passes, adds the mirror and shows the new card.
5. **Adding a mirror does not sync it.** The card appears with status "not synced yet". The user presses "Sync this folder".

**Validation, all of it blocking with a message that names the problem:**

| Rule | Message shape |
|---|---|
| The name is already taken (case-insensitive) | "There is already a mirror called *Docs*." |
| The name is empty or has illegal characters | "That name cannot be used as a folder name." |
| The root overlaps another mirror's root, either way | "*E:\Docs\Notes* is inside the mirror *Docs*, so it would be synced twice." |
| The Drive folder is empty, has a leading or trailing `/`, has an empty segment, or contains `..` | "That is not a folder path." |
| The Drive folder starts with a segment the app cannot create | "Drive does not allow a folder called *<name>*." |

### 7.2 Resolving a destination path

`resolveMirrorFolder` currently takes a folder *name* and lists My Drive's children once. It becomes `resolveMirrorPath(client, drivePath)`:

- Split on `/`. Walk the segments, one Drive API call per level.
- At each level: list the parent's children, match folders by name **case-insensitively**.
  - More than one match → the `ambiguous-folder` guard, the mirror is skipped. The app must not guess.
  - No match → create the folder, then continue.
- The last segment is the mirror's Drive folder. Its **name** is the last segment; the manifest stores `drivePath` and `driveFolderName`.

### 7.3 Changing a destination

When the user edits a mirror's Drive folder:

- If the mirror has never synced, or the new path equals the old one → just store the new path.
- Otherwise → **move the Drive folder** to the new parent with a single `files.update` that changes the parent id. The file ids stay valid, the relative paths inside the mirror do not change, and the manifest keeps working.
- If the move fails, the old destination is kept, the change is rejected with the reason, and the mirror is left exactly as it was.

**New DriveClient method:** `moveFolder(fileId: string, newParentId: string): Promise<void>`.

### 7.4 Removing a mirror

- The Drive content is **not touched**. Not trashed, not moved, not renamed.
- The mirror's config is marked `removedAt` and it disappears from the UI.
- The manifest entry is kept. **Thirty days later it is pruned: the mirror's files, its retired records, its counts, everything.** After that the mirror is unknown to the app.
- Re-adding a removed mirror before the 30 days are up re-adopts its history and does not re-upload.
- Re-adding it after the 30 days are up treats it as new: the existing Drive content is adopted by path and hash, and nothing is re-uploaded.

**Pruning happens at start-up**, in the same place the app already primes its state. It prunes only mirrors whose `removedAt` is more than 30 days old. It never prunes anything belonging to a mirror that is still configured.

### 7.5 Scheduling

**Computing the next fire time** (`nextFireAt(shape, from, lastRunAt)`) is a pure function in `src/core/schedule.ts`, unit-tested for all four shapes:

| Shape | Next fire |
|---|---|
| `every-hours` n | `from + n hours` |
| `daily` at HH:MM | the next occurrence of HH:MM, today or tomorrow |
| `every-days` n | `from + n days`, at the time of day `from` |
| `weekly` day at HH:MM | the next occurrence of that weekday at that time |

**In-app mechanism:**

- A `setTimeout` armed for `nextRunAt`. Re-armed after every run.
- `powerMonitor.on('resume')` re-checks the clock: if the machine slept through a slot, the run happens on wake rather than being lost. **This matters** — a laptop that sleeps for eight hours does not fire timers during sleep.
- On start-up: if `schedule.enabled` and `now - lastRunAt` exceeds one interval, run **once** (D3), then arm normally.

**Windows-task mechanism:**

- The app registers the task with `schtasks.exe` when the mechanism is switched on, and deletes it when it is switched off.
- The task runs `<exe> --sync-once`.
- On start-up the app checks the task exists; if not, it re-registers it (self-heal).
- Uninstalling removes the task (see §7.9).

**The `schtasks` command for each shape** (a pure function, unit-tested):

| Shape | Command |
|---|---|
| `every-hours` n | `/SC HOURLY /MO n` |
| `daily` at HH:MM | `/SC DAILY /ST HH:MM` |
| `every-days` n | `/SC DAILY /MO n /ST HH:MM` |
| `weekly` day at HH:MM | `/SC WEEKLY /D <DAY> /ST HH:MM` |

Common part: `/TN "Drive Mirror Sync" /TR "\"<exe>\" --sync-once" /F`. The task is created **without `/RU` and without `/RP`**, so it runs in the interactive session of the user who created it — which is what DPAPI needs. `/IT` is passed explicitly.

`/MO` for `HOURLY` is valid 1–23; for `DAILY` it is valid 1–31. The UI clamps the input to those ranges.

**`--sync-once` mode:** the app starts, creates no window, runs one sync of all enabled mirrors, writes the summary to the log, shows a Windows toast if the run failed or a guard tripped, and exits. It uses the same silent token refresh as every other path.

### 7.6 The mutex

The runner gets a single-flight guard:

```ts
let inFlight: Promise<RunSummary> | null = null
```

` syncNow()` while a run is in progress **returns the promise of the run already happening**. A second caller is not an error, it just does not start a second run. This is what makes the scheduler safe against a manual sync, and what makes a double-click on "Sync now" harmless.

**Also fixed:** `running` and `phase` are reset in a `finally`, so a thrown error can no longer leave the app stuck on "Syncing..." forever, and the manifest is still checkpointed.

### 7.7 Notifications

- `app.setAppUserModelId('com.drivemirror.app')` at start-up, so Windows shows the toast with the right name and icon.
- Electron's built-in `Notification`. No new dependency.
- A toast fires when a run that the user did not watch **errors**, or when a **guard trips** (a mirror was skipped).
- The same event is written to `settings.pendingNotice`. The renderer reads it at start-up, shows a banner, and clears it. This is how a problem that happened while the app was closed reaches the user.

### 7.8 The connection

| Action | What it clears | What it keeps |
|---|---|---|
| **Sign out of Google** | `tokens.json` | client id, secret, mirrors, schedule, manifest, backups |
| **Reset connection** | `tokens.json` and `credentials.json` | mirrors, schedule, manifest, backups |

Neither one can be triggered by accident: **Reset connection asks for confirmation and states in the confirmation text that the manifest and the mirror list are not touched.**

The account email is fetched from the Drive API (`GET /drive/v3/about?fields=user(emailAddress)`) and shown in the top bar and in Settings. Today `accountEmail` is hardwired to `null` (`src/main/index.ts:281`); that becomes a real value.

**New DriveClient method:** `getAccountEmail(): Promise<string | null>`.

### 7.9 Uninstall

The Windows scheduled task is registered outside the app, so the app must clean it up. electron-builder's NSIS supports an include file; `build/installer.nsh` adds a finish-page macro that runs:

```
schtasks /Delete /TN "Drive Mirror Sync" /F
```

Deleting a task that does not exist is not an error; the macro ignores the exit code.

The app's own data (`%LOCALAPPDATA%\DriveMirror`) is **not** deleted on uninstall — `deleteAppDataOnUninstall: false` stays.

### 7.10 The icon

- **`build/icon.png`** at 512×512 is the source of truth.
- **`build/icon.ico`** holds 16, 32, 48, 64, 128 and 256 pixel entries, PNG-encoded (supported by Windows Vista and later).
- `electron-builder.yml` gets an explicit `win.icon: build/icon.ico` so a missing icon fails the build instead of silently shipping the default Electron logo.
- The app's own PNG is shipped in the packaged app as an extra resource and used as the `BrowserWindow` icon, so the taskbar and the title bar show it. In development the file is read from `build/` directly.
- The top bar shows the icon at 20px next to the title.

`build/` is **not** gitignored today, and it must not be — the icon is source, not build output. `dist/` stays ignored.

**A test asserts the icon exists and is a valid ICO** with the six expected sizes, so CI catches a broken or missing icon without needing a full installer build.

### 7.11 Download to E: (base spec rule R1)

The base spec promises that a file the app trashed, and that the user then restored in Drive, can be pulled back to the local disk. The rule has never been implemented.

**What is built:**

- A **Recovered files** panel, per mirror, listing the manifest's retired records whose state is `restored`.
- Each row shows the path and a **Download to E:** button.
- Pressing it downloads the Drive file (or its export, if it is a Google-native file) to the local root at the recorded path.
- If the target path already holds a file with **different content**, the download is **refused** and the panel says so. Nothing is overwritten.
- On success the record's state becomes `resynced` and the file returns to the mirror's live entries.
- A failure leaves the record as `restored` and shows the reason.

**New IPC channel:** `drive-mirror:download-restored` → `{ mirror: string; driveFileId: string }` → `RunSummary`-shaped result or an error string.

---

## 8. Amendments to the base spec

Two rules in `2026-10-21-drive-mirror-design.md` change. Both are deliberate and both are consequences of decisions the user made.

**A1 — the never-prune rule becomes scoped.** Base spec §6: retired records are never pruned. That stays true **for every mirror that is still configured**. A mirror the user removed is forgotten entirely after 30 days, retired records included (D11).

*Why the user chose this:* a removed mirror is a mirror the user does not want, and holding its whole file list forever is clutter. The trade-off is accepted knowingly: the record that "this file was trashed on 2026-10-02" does not survive the removal of its mirror.

*Consequence the implementation must honour:* the exhaustiveness test's INV-5 invariant ("every retired state is consumed") must be amended to carve out removed mirrors, and the amendment must be stated in the test file, not hidden.

**A2 — the four fixed trees become defaults.** Base spec §1 and the README's table of four mirrors become "the mirrors this app was first built for", pre-seeded on first run and editable like any other. The spec's rule "never touch Drive outside the four roots" becomes **"never touch Drive outside a configured mirror's destination"**.

---

## 9. Bugs found while planning, fixed as part of this work

These are not features. They are defects found during the investigation, and each has a failing test first.

| # | Defect | Where | Fix |
|---|---|---|---|
| B1 | **The test suite overwrites the real manifest backup.** `backupPath` is hardcoded to `E:\.drive-mirror-backup\` and `test/runner.test.ts` never overrides it, so every `npm test` replaces the user's safety-net copy with test junk. It happened to the author's own backup. | `src/main/settings.ts:63`, `test/runner.test.ts:31` | `backupPaths` becomes a setting; tests use a temp directory; **a test asserts that no test writes outside its temp directory**. |
| B2 | **A hardcoded `E:` makes the app fail on any machine without one.** `driveLetterOf` falls back to the literal `'E:'` when a path has no drive letter, so a UNC or relative path silently reports the wrong volume. | `src/main/runner.ts:517-521` | No drive letter → the mirror's own `stat.dev` is the fingerprint, and the drive-letter check is skipped. No `E:` survives in `src/`. |
| B3 | **The runner has no mutex.** Two concurrent runs interleave, both read the manifest, both write it, and the last one wins. | `src/main/runner.ts:419-465` | Single-flight guard (§7.6). |
| B4 | **A thrown error leaves the app stuck.** `running` and `phase` are never reset when `runMirror` throws, and the manifest is never checkpointed. | `src/main/runner.ts` | `try`/`finally`; the manifest is always checkpointed. |
| B5 | **The progress bar never moves.** The runner hardcodes `done: 0, total: 0` on every progress event, and the core progress event carries no counters. | `src/main/runner.ts`, `src/core/sync.ts` | The progress event carries real counters; the bar advances. |
| B6 | **`open-external` is unreachable.** The main process registers the handler, but the preload does not expose it, so the renderer cannot open a link. The first-run wizard needs it. | `src/preload/index.ts`, `src/main/ipc.ts:141` | Exposed in the preload API. |
| B7 | **The signed-in account is never shown.** `accountEmail: () => null` is hardwired. | `src/main/index.ts:281` | Real value from the Drive API (§7.8). |

---

## 10. Testing

The suite is `vitest`, `environment: 'node'`, no DOM. That stays. There is no jsdom, no React Testing Library, and no component test is added — the renderer's behaviour is covered by the core functions it calls.

**New unit tests**

- `test/mirrorConfig.test.ts` — name uniqueness, name legality, root overlap in both directions, Drive path legality, name-to-path derivation.
- `test/schedule.test.ts` — `nextFireAt` for all four shapes, across month and year boundaries, and around a DST change; missed-run detection.
- `test/schtasks.test.ts` — the command built for each shape; the quoting of a path with spaces in `/TR`; the day-name mapping.
- `test/backup.test.ts` — a backup write to an unwritable path logs and does not fail the sync; every configured copy is attempted; the first failure does not stop the others.
- `test/prune.test.ts` — a removed mirror is pruned at 30 days and not at 29; an active mirror is never pruned; its retired records survive.
- `test/icon.test.ts` — `build/icon.ico` exists, has a valid ICONDIR header, and contains 16/32/48/64/128/256.
- `test/runner.test.ts` additions — two concurrent `syncNow` calls produce one run; adding a mirror; removing a mirror; changing a destination moves the folder; an account mismatch blocks the run; the download-restored path refuses to overwrite different content.
- `test/mutex.test.ts` — folded into the runner test.

**Not tested:** the renderer's components, `schtasks.exe` actually running (the command builder is tested, not the invocation), Electron's `Notification` actually appearing.

---

## 11. What is left to the builder

Nothing about the product is undecided. The builder decides:

- The names of the new modules (`src/core/mirrorConfig.ts`, `src/core/schedule.ts`, `src/main/taskScheduler.ts` are the obvious names).
- The exact shape of the new IPC channels, following the existing `drive-mirror:<verb>` convention.
- Whether the "Add folder" flow is one dialog with a form, or a picker followed by a second dialog.
- The exact wording of every message the user sees.
- How the settings store grows — it is a plain JSON file with a shallow merge today, and it now carries a list, a schedule and a notice. It probably wants an atomic write and a real merge.

---

## 12. Amendments from the builder check

A fresh engineer read this spec against the real code and found twelve places where a plan would have had to guess. All twelve are answered here. **Where §12 disagrees with an earlier section, §12 wins.**

**A3 — a scheduled run and the app can both be running.** (`--sync-once` vs the single-instance lock)

`app.requestSingleInstanceLock()` makes the second process quit. If the GUI is open when the Windows task fires, the scheduled run would quit too and do nothing — silently. The in-process mutex does not help, because the two runs are in different processes and would both write `manifest.json`.

Answer: **`--sync-once` does not take the single-instance lock at all.** It takes a **lock file** instead: `%LOCALAPPDATA%\DriveMirror\sync.lock`, created with the exclusive-create flag, held for the duration of the run and deleted at the end. If the lock cannot be taken, the scheduled run exits quietly and logs that another run was already going. A lock older than six hours is treated as stale and taken over, so a crashed run cannot wedge the schedule forever.

The lock is held **for the run, not for the app's lifetime**. So a scheduled run still happens while the app is open and idle; it is skipped only when a sync is genuinely in progress.

**A4 — re-adding a removed mirror must not inherit a different folder's history.** (the mass-trash hole)

The manifest is keyed by name. Adding a mirror called `Docs` that points at a *different* folder than the removed `Docs` would inherit the old tree's `lastCounts` and `files`. The count-drop guard would then compare the new tree against the old baseline, and every old path would read as absent — and rule B0 would trash the Drive copies. One typo, and the app deletes the whole old mirror's worth of files in Drive.

Answer: **the root is part of a mirror's identity when it is re-added.** Adding a mirror whose name matches a removed mirror:

- **the same root** → the history is re-adopted, nothing is re-uploaded.
- **a different root** → the app **refuses**, and says so by name: *"There is already a mirror called Docs for E:\OldDocs, removed on 2026-10-02. Give this one a different name, or forget the old one."* A **Forget the old one** button deletes that manifest entry on the spot, with the same confirmation text.

**A5 — the 30-day forgetting deletes the history, not the archived bytes.** (§7.4)

The prune deletes the manifest entry: the file list, the retired records, the counts. It does **not** delete the superseded copies under `superseded\<mirror>\`. Those are the only local copies of bytes the app replaced, and silently deleting gigabytes because a mirror was forgotten is not something a backup tool should do on its own. They stay until the user runs the existing **Prune superseded copies** action, which is already user-initiated and already in the UI.

**A6 — the Drive folder is found by its stored id first.** (§7.2)

The base spec's §9.4 step 1 says to probe the stored `driveFolderId` before walking the path. The code never implemented it, and §7.2 as first written described only the walk. That would mean a user who renames the mirror's folder in the Drive browser gets a **second** folder created and the whole mirror uploaded again — 1.9 GB in this repository's case.

Answer: **the stored id wins whenever it is alive.**

1. The manifest has a stored `driveFolderId` and the probe says it is alive → use it. If its current name no longer matches the configured path, the user's manual rename is respected and a report says so: *"the folder on Drive is now called X, not Y"*. The manifest's `driveFolderName` is updated to the name that is actually there.
2. The stored id is missing or trashed → resolve by path, creating what is missing.
3. No stored id → resolve by path.

The path walk is the fallback, never the authority.

**A7 — moving a folder can rename it.** (§7.3, and `moveFolder`'s signature)

`moveFolder(fileId, newParentId)` cannot express `Photos` → `Archive/Pictures`, which changes both the parent and the name.

Answer: `moveFolder(fileId: string, newParentId: string, newName?: string): Promise<void>` — **one** `files.update` carrying `parents` and, when the name changes, `name`. After the move the manifest's `driveFolderId` and `driveFolderName` are rewritten.

**A8 — the archived manifest gets its own directory.** (§6.3)

`superseded/` is where the executor writes the bytes it replaced, and the existing **Prune superseded copies** action deletes everything under it. An archived manifest placed there would be deleted by that action — and that archive is the only way back from an account switch.

Answer: the archived manifest goes to `%LOCALAPPDATA%\DriveMirror\manifest-archive\manifest-<timestamp>.json`, a directory of its own. `pruneSuperseded` does not touch it.

**A9 — the runner reads the settings when it runs, not when it starts.** (§7.5 and the whole UI)

`createRunner` captures the mirror list once and `deps.settings` is a snapshot taken at start-up. The new UI changes settings live: add a folder, pause a mirror, change a destination. With today's wiring "Add folder" would add a card the runner never syncs, and a changed `guardThreshold` or backup path would not take effect until a restart.

Answer:

- `RunnerDeps.settings` becomes `() => Promise<Settings>` — a getter, not a value.
- The runner reads it at the start of every run, and derives the mirror list from `settings.mirrors` each time.
- `Runner.state()` becomes `async` and rebuilds the cards from the settings each time it is asked, so a card appears the moment it is added. The IPC handler awaits it; the preload already returned a promise.
- `AppState.mirrors` is derived from the **settings list** — the source of truth — merged with the runner's per-mirror status. The runner's `cards` map is a cache of the last known state, not the authority.

**A10 — the schedule is anchored, not drifting.** (§7.5)

`nextFireAt` needs an anchor, or a daily 09:00 schedule drifts by however long the app was closed, and an every-N-hours schedule restarts its interval every time it is recomputed.

Answer: `nextFireAt(shape: ScheduleShape, from: Date, lastRunAt: string | null): Date`.

| Shape | Anchor |
|---|---|
| `every-hours` n | the **last run**. `lastRunAt + n hours`, advanced until it is after `from`. |
| `every-days` n | the **last run**. `lastRunAt + n days`, advanced until it is after `from`. |
| `daily` at HH:MM | the **wall clock**. The next occurrence of HH:MM after `from`. |
| `weekly` day at HH:MM | the **wall clock**. The next occurrence of that weekday at HH:MM after `from`. |

With no `lastRunAt`, the every-N shapes anchor on `from`.

- **A manual "Sync now" updates `lastRunAt`.** A manual sync is a run. It also means the missed-slot clock is reset, which is correct: the user just synced, so there is nothing to catch up on.
- **The start-up catch-up applies in both mechanisms.** If the machine was off, the Windows task missed its slot too; opening the app honours the missed slot.
- **`nextRunAt` is persisted *and* recomputed** at start-up. It is shown in the interface and used by the scheduler.
- **One interval**, for the missed-run test: `every-hours` → n hours; `every-days` → n days; `daily` → 24 hours; `weekly` → 7 days.

**A11 — the client id lives in one place.** (§7.8)

The client id is currently in `credentials.json` (encrypted) **and** copied into `settings.json` (plaintext) by `currentSettings()`. A reset that clears only `credentials.json` leaves the plaintext copy behind, and the first-run wizard never fires again.

Answer:

- `credentials.json` holds the encrypted client id and secret, as today.
- **`settings.json` never holds the client id.** `Settings.clientId` stays in the type as a read-only projection that always comes from the credential store. `saveSettings` strips it before writing.
- **Reset connection clears `credentials.json` entirely**, so `clientId` becomes empty and the first-run wizard fires again.
- The client id is not a secret — Google publishes it in the consent screen — so it is not worth a migration.

**A12 — "Download to E:" writes to a definite path, and refuses a definite way.** (§7.11)

- **The target path** is the retired record's `localPath` when it has one (a Google-native file's export path), and otherwise the record's `path` (the relative path). The full path is `root` + that.
- **The refusal test** compares the md5 of the bytes about to be written with the md5 of the file already at the target path. Equal → the download proceeds (it is the same content). Different → the download is refused. A retired record's own md5 is the hash *at retirement*, so it is not the right comparison: the Drive file may have been edited after the restore.
- **The button is shown but disabled** when a local file occupies the path, with the reason next to it. The base spec says to hide it; a disabled button that says why is more useful than a button that is not there.
- **The live entry** written on success needs `driveModifiedTime`, `exportMime`, `localSize` and `localMtimeMs`. None are in the retired record, so the download reads the Drive file's metadata with `client.getFile(driveFileId)` and stats the file it just wrote.

**A13 — the recovered-files list comes from the mirror card.** (§7.11)

The renderer cannot read the manifest, and a `Report` carries no Drive file id.

Answer: `MirrorCard` gains `recovered: Array<{ driveFileId: string; path: string; at: string }>`, filled by the runner from the manifest's retired records whose state is `restored`. The panel is per mirror, so the card is the right place. `Report` gains an optional `mirror?: string`, set by the runner, so a report can be attributed to a mirror.

**A14 — which legality rule applies to what.** (§7.1)

*Corrected after the code was written. The original wording of this clause was wrong about one thing, and the correction makes the rule stricter, not looser.*

- The **mirror name** is a manifest key and a label — but it **does** reach the local disk: it is the directory name under the superseded archive (`src/core/sync.ts:406`, `join(archiveDir, sanitizePathSegment(mirrorName), …)`). It only gets there through `sanitizePathSegment`, which turns the characters Windows forbids into `_`. Because of that, the name follows the **Windows** rule: not empty, not `.` or `..`, none of `< > : " / \ | ? *`, no control character, and not ending in a space or a dot.
- A **Drive path segment** follows the same rule plus Drive's own limits: non-empty, not `.` or `..`, no `/` or `\`, no control character, at most 255 characters, and not ending in a space or a dot.
- `isRepresentableOnWindows` in `src/core/paths.ts` is about **Drive file names that have to be mirrored onto the local disk** — that is the sync engine's job, not this module's. What applies to a mirror name here is `sanitizePathSegment`.
- **The strict rule is deliberate.** It can only *refuse* a name, never admit one that cannot be used, and `suggestDrivePath` rewrites the offending characters to `-`, so the user is always offered a path that works. The alternative — Drive's own more permissive list — would buy a mirror named `Sales: 2026` at the cost of a name that reaches the disk through a sanitiser, and a default Drive path that differs from the name it came from. The trade is not worth it.


---

## 13. Open risk the user was told about

The 30-day pruning (D11) is the one decision that trades a safety property for tidiness. If the user would rather keep every removed mirror's history forever, that is a one-line change in §7.4 and nothing else in this spec depends on it.
