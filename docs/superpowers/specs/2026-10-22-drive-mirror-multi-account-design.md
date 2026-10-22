# Drive Mirror — multiple Google accounts — design spec

**Date:** 2026-10-22
**Status:** Draft for approval
**Supersedes:** nothing. Amends `2026-10-21-drive-mirror-design.md` and
`2026-10-21-drive-mirror-v2-design.md`.
**Builds on:** the code as of `ab8be51` on `main`.

---

## 1. Intent and the why

Drive Mirror today signs in to **one** Google account and mirrors that
account's Drive. The user wants the app to hold **several** Google accounts
at once, each with its own mirrors, its own schedule and its own history, and
to move between them without signing out and back in.

The reason is separation. Someone with a work account and a personal account
wants the work tree on the work Drive and never on the personal one. Someone
who wants the same folder in two places wants two independent copies, not one
that fights itself.

The app is not public yet — it was made on 2026-10-21 and has no users other
than the author — so the design is chosen for the public app, not for the
install that exists today.

### The shape of the change

The engine does not change. `src/core/` has **zero** account references: the
diff engine, the sync executor, the manifest rules, the count-drop guard, the
Drive client and the OAuth flow are already per-run and per-mirror, and a
Drive file id only means something inside one account's Drive, so they were
already account-shaped without saying so.

Everything that is hard-wired to a single account lives in `src/main/`, the
IPC surface and the renderer:

| Hard-wired thing | Where |
|---|---|
| one `Settings` object: one `clientId`, one `mirrors[]`, one `schedule` | `src/main/settings.ts:54-78` |
| one encrypted credential pair | `src/main/settings.ts:130-177` |
| one token file | `src/main/index.ts:73-96` |
| one `DriveClient`, bound to one `accessToken()` | `src/main/index.ts:134` |
| one `ManifestStore`, rooted at the app data dir | `src/main/index.ts:322` |
| one `Manifest.accountEmail` | `src/core/types.ts:157` |
| one `AppState.accountEmail` | `src/main/ipc.ts:64` |
| one `sync.lock` and one in-process `inFlight` | `src/main/runner.ts:176-180`, `972-1030` |
| one `ScheduleConfig` and one Windows task | `src/main/settings.ts:73`, `src/main/taskScheduler.ts:18` |
| the account guard, at run time | `src/main/runner.ts:563-583` |
| 23 IPC channels, none of them carrying an account | `src/main/ipc.ts:109-297` |
| a flat mirror grid and one account label | `src/renderer/App.tsx:228-232`, `280-297` |

That is the whole blast radius. The core is untouched.

### A live bug this work also fixes

`src/main/scheduler.ts:100-104` advances the schedule's `lastRunAt` after any
run that returns without throwing — including a run that never happened,
because the app was busy (`src/main/runner.ts:524-534` returns a summary
carrying an anomaly report, not an error). The missed-run logic therefore
never fires and **a scheduled slot is silently lost**. The fix is in §7.6 and
it ships with this work.

---

## 2. Goals

- One install holds several Google accounts at once.
- Each account is a **separate world**: its own mirrors, its own schedule, its
  own file list, its own sign-in, its own notices.
- Moving between accounts is one click, from the top bar.
- The Google client id is entered **once** and used by every account. A second
  account costs one sign-in, not another hour in the Google Cloud Console.
- The same local folder may be mirrored into two accounts, as two entirely
  independent mirrors.
- One account's problem never stops another account.
- Nothing that exists today is lost: the author's install keeps its four
  mirrors, its 254 files, its schedule and its sign-in.

## 3. Non-goals

- Shared drives, or folders shared between accounts.
- Service accounts, or any identity that is not a human's own Google login.
- Several Windows users sharing one install.
- Google Workspace domain-wide delegation.
- One install serving several people. Each install belongs to one person.
- Per-mirror schedules. A schedule belongs to an account.
- A "sync every account at once" button.

## 4. Anti-goals — the things that must never happen

- **An account's file list must never be used with another account's tokens.**
  A Drive file id in account A's manifest means nothing in account B's Drive.
- **An account's schedule must never run another account's mirrors.**
- **A run for one account must never be silently skipped because another
  account is running** without saying so, and a run that did not happen must
  never be recorded as having happened.
- **Adding, changing or removing a mirror in one account must never touch
  another account's mirrors**, including the shared ones: the same local
  folder, mirrored into two accounts, is two mirrors and they must not share
  any state.
- **Signing out must never destroy an account's manifest.** The manifest is the
  app's memory of what is on Drive; losing it means re-uploading everything.
- **A migration failure must never leave the author's data in two half-states.**
  The old files are the copy of record until the new ones are verified.

---

## 5. Decisions

These were settled with the user, by question and answer, on 2026-10-22.

### Shape

**M1 — This is for the public app.** Strangers will connect several accounts.
The design is chosen for the public app, not for the install that exists.

**M2 — One Google client id for the whole app, shared by every account.** The
client id identifies the *app*; the person is identified by their own Google
login. A second account must cost one sign-in, not a second trip to the
Google Cloud Console.

**M3 — Separate worlds, with a switcher.** The app has a current account. You
see only that account's mirrors, schedule and files.

**M4 — One schedule per account, and one Windows scheduled task per account.**
Each account gets its own timing. Task Scheduler shows one entry per account.

**M5 — The same local folder may be mirrored into two accounts**, as two
entirely independent mirrors with separate manifests and separate file lists.

**M6 — The existing install is restructured on upgrade**, in one automatic
step, with the old layout kept.

### On disk

**M7 — One folder per account.**

```
%LOCALAPPDATA%\DriveMirror\
  settings.json          app-wide: the account list, the current account, the
                         client-id flag, the guard threshold, start-with-Windows,
                         the extra backup location, an app-level notice
  credentials.json       app-wide: the one shared client id and secret (encrypted)
  accounts\
    acc_7f3a2b\
      settings.json      this account: its mirrors, its schedule, its notice
      manifest.json      this account: its file list, its mirrors, its disk prints
      journal.ndjson     this account: its journal
      tokens.json        this account: its sign-in (encrypted). Absent when signed out.
    acc_91c4de\          ...
  backups\               the app's own copy of each manifest
    someone@example.com\manifest.json
  logs\app.log           one log; every line carries the account it came from
  sync.lock              one lock for the whole app
  legacy\                the pre-multi-account layout, kept after the migration
```

**M8 — An account's id is an opaque generated string** (`acc_` plus twelve
lowercase hex characters). The email is stored inside the account and used as
the display label and the ownership record. Emails can be renamed, can
collide through aliases, and make an unreadable folder name.

**M9 — The account folder is the unit of storage.** The mirrors and the
schedule live *inside* the account folder, not in the app-wide settings file,
so that the folder is genuinely self-contained and "forget this account" is
one delete.

**M10 — Backup folders are named by the account's email**, not by its id. A
backup exists to be read by a human, and an email says who it belongs to at a
glance. The working folders under `accounts\` are named by the id because
they are machine-facing. The email is sanitised for the filesystem.

**M11 — One extra backup location, app-wide, with a sub-folder per account.**
The app's own copy always lives at `backups\<email>\manifest.json`. The user
may name **one** extra location, and each account's manifest is written to
`<location>\<email>\manifest.json`.

**M12 — One log file for the app**, with the account recorded on every line.

### Behaviour

**M13 — "Sync now" acts on the current account only.** The switcher defines
which world you are in.

**M14 — The account guard becomes structural.** Each account holds its own
tokens and its own manifest, so the app cannot mix them. The run-time check
survives only as a safety net for a manifest whose recorded owner does not
match the account it is filed under.

**M15 — A changed disk letter stops only the accounts whose mirrors live on
that disk.** Each account's manifest records the fingerprints of the disks its
own mirrors use, so each detects the change for itself.

**M16 — Signing in with a Google account the app has never seen always makes
a new account.** It never reuses another account's history. The dropdown
shows every account with its email, so a mistaken sign-in is visible.

**M17 — One lock for the whole app.** Two accounts never sync at the same
instant.

**M18 — The account switcher is a dropdown in the top bar.** The top bar
already shows the account; it becomes a button that opens a list.

**M19 — "Sync now" on an account that is busy waits, then runs.** If account A
is syncing and you press "Sync now" on account B, the button says *"waiting
for the other account's sync to finish"* and B runs as soon as A is done. B
never receives A's results, and B is never silently skipped.

**M20 — A run that could not happen is never recorded as having happened.**
The summary of a skipped run says so, and the schedule's clock is not
advanced. This is the fix for the live bug in §1.

**M21 — Settings' "Test connection" button becomes "Connect an account."** It
signs the user in, and creates or attaches the account. The account dropdown
also offers "Connect another account".

### The destructive actions

**M22 — "Sign out of this account" drops the tokens and keeps everything
else.** The manifest, the mirrors and the schedule stay. Signing back in
restores the account exactly as it was.

**M23 — "Forget this account" deletes the account's folder for good** — the
manifest, the journal, the tokens, the per-account settings and the per-account
manifest archive — and removes its Windows scheduled task. The files already
on Drive are not touched. The manifest copy in the backup locations survives,
because those live outside the account folder: the file list can be recovered
by hand.

**M24 — "Reset the connection" is app-wide.** It signs out every account and
clears the shared client id. Every account's manifest, mirrors and schedule
stay. It is the closest match to what the button does today.

**M25 — Signing out of the account you are looking at moves you to another
connected account**, or to the "connect an account" screen if there is none.

---

## 6. Data model

### 6.1 `AppSettings` — app-wide (`src/main/settings.ts`)

Replaces today's `Settings` for the app-wide half.

```ts
export interface AccountRecord {
  /** The opaque id. The folder name and the key everywhere. */
  id: string
  /** The Google address this account is signed in as. */
  email: string
  /** ISO timestamp. */
  addedAt: string
}

/** What the switcher needs to draw one line. */
export interface AccountSummary extends AccountRecord {
  /** Whether the account has a sign-in. */
  signedIn: boolean
  /** How many mirrors it has configured. */
  mirrorCount: number
  /** Whether it has a notice that has not been shown. */
  hasNotice: boolean
}

export interface AppSettings {
  /** Every account this install knows about, signed in or not. */
  accounts: AccountSummary[]
  /** Which account the app is showing. Null when there are none. */
  currentAccountId: string | null
  /** Whether a client secret is stored. The secret itself is never here. */
  clientSecretSet: boolean
  /** The smallest folder size the count-drop guard applies to. */
  guardThreshold: number
  /** Start with Windows. */
  startWithWindows: boolean
  /** One extra place to keep a copy of each manifest. Null for none. */
  extraBackupPath: string | null
  /** A problem with the app itself, shown once. */
  pendingNotice: { message: string; at: string } | null
}
```

`accounts` holds **summaries**, not bare records, so the switcher is drawn
from a single call. The summary fields are derived at read time, never stored:
signed-in from the existence of the account's token file, mirror count and
notice from the account's settings file. The stored record is still
`{ id, email, addedAt }`.

The `clientId` projection survives: it is read from the credential store, never
written to the settings file.

### 6.2 `AccountSettings` — per account (`accounts\<id>\settings.json`)

```ts
export interface AccountSettings {
  /** The mirrors this account has configured. */
  mirrors: MirrorConfig[]
  /** How often this account syncs on its own. */
  schedule: ScheduleConfig
  /** A problem from a run the user did not watch, shown once. */
  pendingNotice: { message: string; at: string } | null
}
```

`MirrorConfig` and `ScheduleConfig` are unchanged.

### 6.3 The manifest — unchanged in shape

The per-account manifest is today's manifest, byte for byte:

- `version` stays **11**. The manifest's *shape* does not change; only the
  path it lives at does. The migration moves the file, it does not rewrite it,
  so the old manifest stays readable by the old code and the new code reads
  it unchanged.
- `accountEmail` stays, and now means "the Google account that owns this
  manifest" — the same thing it means today.
- `mirrors` is keyed by mirror name, as today. Names are unique **within an
  account**, not across accounts.
- `volumes` keeps the disk fingerprints. After the split each account's
  manifest carries only the disks its own mirrors use. The migration copies
  the table across unchanged: a superset of the disks an account uses is
  harmless, because the guard only ever checks a disk a mirror is on.

**The journal is per account** (`accounts\<id>\journal.ndjson`). It has to
be: a journal op is a manifest mutation, and replaying one account's journal
into another account's manifest would corrupt it.

### 6.4 The account registry

The list of accounts lives in `settings.json`. **Signed-in state is not
stored**: an account is signed in exactly when
`accounts\<id>\tokens.json` exists. There is one source of truth for that,
and it is the file itself.

### 6.5 The token store

`tokens.json` moves from the app data dir into the account folder. Its
on-disk shape is unchanged: `{"payload":"<base64 of the encrypted JSON>"}`,
written with `writeFile` as today, encrypted with `safeStorage` as today.

The credential store is **unchanged**: one shared client id and secret in
`credentials.json`, one file, one pair, as today.

### 6.6 The events

Every `AppEvent` gains an `accountId`:

```ts
export type AppEvent =
  | { type: 'state'; accountId: string; state: AppState }
  | { type: 'progress'; accountId: string; mirror: string; relPath: string; phase: string; done: number; total: number }
  | { type: 'finished'; accountId: string; summary: RunSummary }
  | { type: 'guard'; accountId: string; mirror: string; reason: string; message: string; canOverride: boolean }
  | { type: 'notice'; accountId: string | null; message: string }
  | { type: 'error'; accountId: string | null; message: string }
```

`accountId` is null only for app-level events — a failed migration, a failed
start-up. The renderer **ignores** every event whose account is not the one on
screen, so account A's progress never paints into account B's screen.

`RunSummary` gains one field:

```ts
export interface RunSummary {
  /* ...as today... */
  /** Set when the run did not happen because the app was busy. */
  skipped?: true
}
```

`LogEvent` in `src/core/logger.ts` gains an optional `account` field, so
every line of the log says which account it came from.

---

## 7. Behaviour

### 7.1 Connecting an account

1. The app needs a client id. If there is none, the setup wizard opens, once,
   for the whole app — not once per account. This is unchanged from today.
2. The user presses **Connect another account** in the dropdown, or
   **Connect an account** in Settings (M21).
3. The app opens the browser to Google's sign-in page with the **shared**
   client id and a loopback redirect, exactly as today.
4. Google returns the code. The app exchanges it for tokens, **holding them
   in memory**.
5. The app builds a `DriveClient` over the in-memory access token and calls
   `about?fields=user(emailAddress)` to learn the address.
   - If that call fails, the sign-in is refused with a clear message: the app
     cannot tell which account this is, so it will not guess. No account is
     created, and no token file is written.
6. The app looks for an account whose recorded email **matches the address
   case-insensitively**. Google addresses are case-insensitive, so the
   comparison is made on the lower-cased forms. The address is stored exactly
   as Google returned it, for display.
   - **Found and signed out** → the tokens are written into that account's
     folder and the account becomes the current one. Everything is exactly as
     it was.
   - **Not found** → a new account is created: a new id, a new folder, an
     empty manifest, no mirrors, no schedule, and the tokens written into it.
   - **Found and already signed in** → refused: "that account is already
     connected".
7. The new account becomes the current account.

`authenticate` returns `{ ok, email?, accountId?, message? }`. The `message`
field carries the reason for a refusal.

### 7.2 The account guard

The run-time check in `src/main/runner.ts:563-583` is kept, with its message
unchanged, but it changes in two ways:

- **The address it compares against is the registry's**, not a live `about`
  call. The account's own tokens are in the account's own folder, so the
  address of the account being run is known locally. The guard therefore
  needs no network call, and a network failure cannot disable it.
- **A missing or non-string owner is not a failure.** It means "no owner
  recorded", and the first run claims the manifest for the signed-in account,
  exactly as today (`src/main/runner.ts:580-583`). Only an owner that is
  recorded **and different** blocks the run, and the message names both
  addresses.

### 7.3 The switcher

The top-bar account label becomes a button. Opening it shows:

- every account, by email, with a mark for signed-in, a count of its mirrors,
  and a mark if it has an unshown notice;
- **Connect another account**;
- **Forget this account** (only for the current account).

The list comes from `AppSettings.accounts` in one call. Choosing an account
makes it current. The whole screen changes: its mirrors, its schedule, its
notices, its sign-in state.

### 7.4 Mirrors

Adding, changing, pausing and removing a mirror act on the current account.
The rules in `src/core/mirrorConfig.ts` change in exactly two ways:

- **The name-uniqueness check is per account.** "Medicine" may exist in two
  accounts.
- **The root-overlap check is per account.** The same local root may be
  mirrored into two accounts. The check still refuses two mirrors in the
  *same* account sharing a root, and still reserves a removed mirror's root
  for its thirty days — within that account.

Everything else about mirrors is unchanged.

### 7.5 Scheduling

Each account has its own `ScheduleConfig` and its own scheduler.

- The **in-app** mechanism: one timer per account whose mechanism is
  `in-app`. The app keeps a timer per such account and runs it at that
  account's own times.
- The **Windows task** mechanism: one task per account whose mechanism is
  `windows-task`. The task is named `Drive Mirror Sync - <email>` and runs
  `"<exe>" --sync-once --account <id>`.

`--sync-once` grows an `--account <id>` argument:

- With `--account <id>`, the app runs **that** account and quits.
- Without it, the app runs every account whose mechanism is `windows-task`,
  **one after another**, taking and releasing the lock between them, and then
  quits. This is the manual "sync everything" escape hatch.
- An `--account` that names an unknown account is refused with a message and
  nothing is run.

Mechanism exclusivity is unchanged: an account uses the in-app timer **or** a
Windows task, never both. Switching a schedule off removes that account's
Windows task.

**The legacy task is removed by the migration** (§8). The author's machine
already has a task named `Drive Mirror Sync`, firing `--sync-once` with no
account. Left alone it would keep firing forever alongside the new
per-account tasks.

### 7.6 The lock, the mutex, and the missed slot

**The lock file is app-wide**, as today: one `sync.lock`, one exclusive
create, stale after six hours. Two accounts never sync at the same instant.

**Within one process**, the state that was global becomes per account:

- a run for an account that is already running **joins that account's run**,
  as today, but only that account's run;
- a run for an account that is *not* running, while **another** account holds
  the lock, **waits** for the lock and then runs (M19). The user is told it is
  waiting.

**A skipped run is never recorded as having happened.** The runner sets
`skipped: true` on the summary of a run that could not take the lock. The
scheduler reads that field and, when it is set, does **not** advance
`lastRunAt` and re-arms the timer to retry the same slot. This is the fix for
the live bug in §1: today the slot is lost.

- The in-app timer retries the same slot when the lock frees.
- A `--sync-once` run waits and retries every 60 seconds for up to 5 minutes,
  then gives up, logs that the slot was missed, and exits. The missed-run
  logic catches the slot up at the next tick.

### 7.7 The notices

A notice belongs to the account that produced it and is stored in that
account's settings. The current account's notice is shown in the window. A
notice from another account is marked in the dropdown, so it is not hidden
while you are looking at a different account. An app-level notice — a failed
migration, a failed start-up — is stored in the app-wide settings and shown as
a banner.

### 7.8 The four actions

| Action | Where | What it does |
|---|---|---|
| **Sign out of this account** | the current account's section in Settings | Deletes that account's `tokens.json`. The manifest, the mirrors, the schedule and the notice stay. |
| **Forget this account** | the switcher | Deletes the whole account folder — manifest, journal, tokens, per-account settings, per-account manifest archive — and removes its Windows task. The files on Drive are untouched. The manifest copy in the backup locations survives. |
| **Reset the connection** | app-wide, in Settings | Deletes every account's `tokens.json` and the credential store. Every account's manifest, mirrors and schedule stay. |
| **Reset this account's history** | the current account's section in Settings | Archives that account's manifest to `accounts\<id>\manifest-archive\manifest-<stamp>.json` and starts a fresh one. The mirrors and the schedule stay. This is today's "Start a new manifest", scoped to one account. |

Signing out of the account you are looking at moves you to another connected
account, or to the "connect an account" screen if there is none.

### 7.9 Where things are kept

The README's table changes to:

| What | Where |
| --- | --- |
| Manifest | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\manifest.json` |
| Backups of the manifest | `%LOCALAPPDATA%\DriveMirror\backups\<email>\` and the extra location, if one is named |
| Sign-in | `%LOCALAPPDATA%\DriveMirror\accounts\<id>\tokens.json` |
| Encrypted credentials | `%LOCALAPPDATA%\DriveMirror\credentials.json` |
| Logs | `%LOCALAPPDATA%\DriveMirror\logs\app.log` |

### 7.10 The renderer

- The top bar's account label becomes the switcher button.
- The mirror grid shows the current account's mirrors. It is not grouped —
  there is nothing to group, because only one account is on screen.
- The Settings dialog splits into an **app-wide** section (client id and
  secret, **Connect an account**, start with Windows, guard threshold, the
  extra backup location, "Reset the connection") and a **current account**
  section (the schedule, the account's backup copies, "Sign out of this
  account", "Forget this account", "Reset this account's history").
- The empty state has two forms: no accounts at all → "Connect an account";
  accounts exist but none is signed in → "Sign in".
- The setup wizard opens when there is no client id, once for the app.

### 7.11 The IPC surface

Every account-scoped channel takes an account id as its first argument. **The
id is optional on every one of them and means "the current account"** — one
convention, not three. When there is no current account, a read returns an
empty state and a mutation returns `{ ok: false, message: 'no account is
selected' }`.

**App-wide** (12)

| Channel | Args → result |
|---|---|
| `drive-mirror:get-app-settings` | → `AppSettings` |
| `drive-mirror:save-app-settings` | `(patch: Partial<AppSettings>)` → `AppSettings` |
| `drive-mirror:set-credentials` | `(clientId, clientSecret)` → `{ ok }` |
| `drive-mirror:authenticate` | → `{ ok, email?, accountId?, message? }` |
| `drive-mirror:sign-out` | `(accountId)` → void |
| `drive-mirror:forget-account` | `(accountId)` → `{ ok }` |
| `drive-mirror:reset-connection` | → `{ ok }` |
| `drive-mirror:switch-account` | `(accountId)` → void |
| `drive-mirror:choose-folder` | → `string \| null` |
| `drive-mirror:app-icon` | → `string` |
| `drive-mirror:open-external` | `(url)` → void |
| `drive-mirror:open-log-folder` | → void |

**Account-scoped** (15)

| Channel | Args → result |
|---|---|
| `drive-mirror:get-account-settings` | `(accountId?)` → `AccountSettings` |
| `drive-mirror:save-account-settings` | `(accountId, patch)` → `AccountSettings` |
| `drive-mirror:get-state` | `(accountId?)` → `AppState` |
| `drive-mirror:sync-now` | `(accountId?, mirrorName?)` → `RunSummary` |
| `drive-mirror:override-guard` | `(accountId, mirrorName)` → `RunSummary` |
| `drive-mirror:rebase` | `(accountId, mirrorName)` → void |
| `drive-mirror:add-mirror` | `(accountId, {name, root, drivePath})` → `{ ok } \| { ok: false, message }` |
| `drive-mirror:update-mirror` | `(accountId, {name, drivePath})` → `{ ok } \| { ok: false, message }` |
| `drive-mirror:remove-mirror` | `(accountId, name)` → `{ ok }` |
| `drive-mirror:set-mirror-enabled` | `(accountId, name, enabled)` → `{ ok }` |
| `drive-mirror:get-schedule` | `(accountId)` → `ScheduleConfig` |
| `drive-mirror:save-schedule` | `(accountId, patch)` → `ScheduleConfig` |
| `drive-mirror:reset-account-history` | `(accountId)` → `{ ok }` |
| `drive-mirror:download-restored` | `(accountId, mirror, driveFileId)` → `{ ok, path } \| { ok: false, message }` |
| `drive-mirror:show-manifest` | `(accountId)` → void |

That is **27 channels, up from 23** — four new: `get-account-settings`,
`save-account-settings`, `forget-account`, `switch-account`. `get-settings`
and `save-settings` become `get-app-settings` and `save-app-settings`.
`start-fresh-manifest` becomes `reset-account-history`. `sign-out` and
`show-manifest` gain an account id.

`AppState` gains `accountId`. It keeps `accountEmail` and `needsAuth`, which
now describe the account it is about.

### 7.12 The runner and the scheduler

**One runner, shared by every account.** It resolves the account per call:

```ts
export interface AccountRuntime {
  id: string
  email: string
  /** Whether the account has a sign-in. */
  signedIn: boolean
  client: DriveClient
  store: ManifestStore
  settings: () => Promise<AccountSettings>
  /** The account's tokens, and where to write a refreshed one. */
  loadTokens: () => Promise<OAuthTokens | null>
  saveTokens: (tokens: OAuthTokens) => Promise<void>
}

export interface RunnerDeps {
  account: (id: string) => Promise<AccountRuntime>
  appSettings: () => Promise<AppSettings>
  /* ...the rest as today... */
}
```

The state inside the runner that was global becomes **per account**:

| Today | Becomes |
|---|---|
| `cards`, keyed by mirror name | keyed by account id **and** mirror name |
| one `inFlight` promise | one per account |
| one `running` flag and one `phase` | one pair per account |
| one pending guard | one per account |
| one `lastRun` summary | one per account |

Without this, two accounts that both have a mirror called "Medicine" would
show each other's file counts, and account B's "Sync now" would receive
account A's summary.

The run itself is unchanged: lock, read, check the account, loop the mirrors,
checkpoint, write the backups, record the run time. Two changes: the summary
of a skipped run carries `skipped: true`, and the backups are written per
account (§7.9).

**The scheduler** becomes one instance per account, held in a
`Map<accountId, Scheduler>` by the app, created and destroyed as accounts are
added and forgotten. Each instance reads and writes its own account's
settings, registers its own Windows task, and does not advance its clock when
the summary it gets back says the run was skipped.

---

## 8. The migration

The migration runs once, at start-up, before anything else. It follows the
pattern of the existing one-time cleanup at `src/main/index.ts:516-531`.

**It runs when** the marker `accounts\.migrated` is absent and a legacy
`manifest.json` exists.

**The order matters, and it is the opposite of the obvious one.** The legacy
`settings.json` is **copied** to `legacy\settings.json` *before* the new
app-wide `settings.json` is written, because they share a path. If the new
file were written first and the migration then failed, the next start would
read the new-shaped file as legacy — and the author's schedule, its mechanism
and the extra backup path would be gone, because they exist nowhere else.

**The steps:**

1. Read the legacy settings from `legacy\settings.json` if it is there, else
   from `<appData>\settings.json`. **Read first, before anything is written.**
2. If `legacy\settings.json` does not exist and the source file does, **copy**
   the source to `legacy\settings.json`. From this moment it is the copy of
   record, and every later step reads the settings from it, never from the
   app root.
3. Remove any partial `accounts\acc_*` folder left by an earlier failed
   attempt.
4. Create `accounts\acc_<new id>\`.
5. **Copy** (not move) the legacy `manifest.json`, `journal.ndjson` and
   `tokens.json` into it.
6. Write `accounts\acc_<id>\settings.json` from the settings read in step 1,
   applying the same singular-`backupPath` shim the settings store applies
   (`src/main/settings.ts:270-274`), so an old file is not misread.
7. Verify: the copied manifest parses and has version 11; the account
   settings parse; the legacy settings copy still parses.
8. Write the new app-wide `settings.json`:
   - `accounts`: one summary, with the id, the legacy manifest's
     `accountEmail` (or an empty string if it had none), the current time, and
     the derived `signedIn`, `mirrorCount` and `hasNotice`;
   - `currentAccountId`: that id;
   - `clientSecretSet`, `guardThreshold` and `startWithWindows`: carried over;
   - `extraBackupPath`: the first entry of the legacy `backupPaths` — after
     the shim — that is not the app's own default backup directory, or null.
9. **Move** the legacy `manifest.json`, `journal.ndjson` and `tokens.json`
   into `legacy\`, keeping them. The legacy `settings.json` is already in
   `legacy\` from step 2.
10. Delete the legacy Windows task `Drive Mirror Sync`, if it is registered.
11. Write the marker `accounts\.migrated`.
12. Log one line naming the account folder, the legacy folder and the account
    email.

**If any step fails:** the partial account folder is removed, everything else
is left exactly where it was, the app reports the failure with the path, and
the app starts with **no accounts**. The next start re-runs the migration
from step 1, and it reads `legacy\settings.json`, which by then holds the
author's schedule and extra backup path. The migration is therefore
**resumable**, and it is idempotent.

**What it does not touch:** the credential store, the log, the lock file, the
extra backup location's existing contents, and the files on Drive.

**The old `E:\.drive-mirror-backup\manifest.json`** is left alone. The new
per-account copy goes to `E:\.drive-mirror-backup\<email>\manifest.json`.

---

## 9. Testing

### What must change

| File | What |
|---|---|
| `test/runner.test.ts:642-678` | the account-mismatch block becomes "the account's manifest belongs to that account"; a missing or non-string owner still claims the manifest, a different one still blocks |
| `test/runner.test.ts:55-79` | one `settings` object becomes an app settings object plus a per-account one; one `manifest.json` becomes one per account |
| `test/runner.test.ts:173-175` | the "never issues a delete" check is unchanged, but the runner now resolves its account per call |
| `test/ipc.test.ts:26-50` | the channel list: **23 becomes 27** |
| `test/settings.test.ts` | asserts on the flat `Settings` shape; becomes `AppSettings` and `AccountSettings` |
| `test/freshInstall.test.ts:24-50` | the new defaults: no accounts, no current account, no client id, schedule off, everything inside the app's own data directory |
| `test/oauth.test.ts:127-172` | the credential store is unchanged; the token store moves into the account folder |
| `test/scheduler.test.ts` | one scheduler becomes one per account; the task is registered per account; a skipped run does not advance the clock |
| `test/schtasks.test.ts:56-64` | the task name is now built from the account's email |
| `test/backup.test.ts:39-47`, `122-127` | the backup paths become the new per-account layout |

### What is unaffected

`test/diff.test.ts`, `test/sync.test.ts`, `test/exhaustiveness.test.ts`,
`test/claims.test.ts`, `test/guards.test.ts`, `test/localScan.test.ts`,
`test/paths.test.ts`, `test/drivePath.test.ts`, `test/driveTree.test.ts`,
`test/listing.test.ts`, `test/schedule.test.ts`, `test/format.test.ts`,
`test/notice.test.ts`, `test/icon.test.ts`, `test/httpClient.test.ts`.

### What is new

- **The migration.** A legacy layout becomes the new layout, with the mirrors,
  the schedule, the sign-in and the extra backup location intact. The legacy
  folder is kept. A failed copy leaves the legacy files alone and starts with
  no accounts. The migration is idempotent, and it is **resumable**: a
  failure after the new settings file has been written still recovers, because
  the legacy settings copy is the copy of record. The legacy Windows task is
  removed. A legacy file with the singular `backupPath` is read correctly.
- **Signing in.** A known email re-attaches to the signed-out account; an
  unknown email creates a new account; a known email that is already signed in
  is refused; a failed `about` call refuses the sign-in and writes nothing;
  the email match is case-insensitive.
- **Two accounts, the same local folder.** Two mirrors, independent file
  lists, independent runs, and one account's run does not touch the other's.
  Two accounts may both have a mirror with the same name, and each shows its
  own card.
- **The busy case.** A run for a busy account waits and then runs, and gets
  its own summary — never the other account's. A run that could not happen is
  marked `skipped`, and **the schedule's clock does not advance**, so the slot
  is caught up rather than lost. This is the live bug in §1.
- **The per-account Windows task.** The name carries the email, the command
  carries the account id, and the task is removed when the account is
  forgotten or its schedule is switched off.
- **"Forget this account"** removes that account's folder and task, leaves
  every other account alone, and leaves the backup copy alone.
- **"Reset the connection"** signs out every account and clears the client id,
  and leaves every manifest, mirror and schedule alone.
- **The account id on the command line.** An unknown id runs nothing.
- **The shared client id** signs in two different accounts.
- **The events.** Every event carries the account it belongs to, and the
  renderer ignores another account's events. A notice with no account goes to
  the app-level notice.
- **The overlap and name-uniqueness rules** are per account, and the removed
  mirror's root stays reserved within its own account.
- **The switcher.** Switching accounts changes the mirrors, the schedule and
  the sign-in state on screen.

The `test/freshInstall.test.ts` rule that no source file names a drive letter
or one of the author's folders still holds, and the migration is generic.

---

## 10. What is left to the builder

- The exact form of the account id, and the generator for it.
- The sanitiser for an email used as a folder name, and where it lives.
- The exact wording of every new message: the refused sign-in, the already
  connected account, the failed migration, the forgotten account, the skipped
  slot, the waiting run.
- The exact look of the switcher dropdown, and how the marks for signed-in,
  mirror count and notice are drawn.
- Whether the app's own backup directory keeps its current name, and whether
  the extra location is chosen with a folder picker.
- Whether the log's account field is the id or the email.
- The exact verification performed on the copied files during the migration.
- How the "waiting for the other account's sync to finish" state is drawn.

## 12. Amendment A5 - what the review found, and what it changed

**On 2026-10-22, after the work was done, the whole branch was reviewed.**
Three defects came out of it, and two of them would have broken the feature
this document describes.

**A5.1 - The account being run, not the account on screen.** The guard and
the backup writer asked the app's settings which account was on screen, and
used that address as the account being run. So the second account's first run
stamped the first account's address on its own manifest, and from then on
every one of its runs was blocked with *"this manifest belongs to somebody
else"*. Its manifest backup was written into the first account's backup
folder as well. The running account carries its own address, and that is
what the guard and the backups use now.

**A5.2 - The test harness was hiding it.** The harness gave every account
the same address, so the guard could never tell two accounts apart and the
tests passed for the wrong reason. Each account has its own address now, and
the tests assert each manifest's owner and each backup's folder.

**A5.3 - The migration was not resumable.** The marker was written last,
after the old files had been moved aside. A failure in between deleted the
account folder - manifest and all - and left the manifest in the legacy
folder, where the app would never read it again. The marker now comes
**before** anything is moved aside, so a failure leaves the old files where
they were, and the tidying-up afterwards cannot undo the migration.

Two smaller things came out of the same review and are now true:

- **A call that names no account is refused**, at the interface's edge. An
  empty account id would have made "forget this account" delete the whole
  accounts folder, because `path.join` drops an empty segment. The path
  refuses an empty id, and the interface refuses a call that names no
  account or one the app does not know.
- **A slot that was missed is retried** as soon as the lock is free, rather
  than waiting a whole period for the next one.

---

## 11. Risks the user was told about

- **"Forget this account" cannot be undone.** The app's memory of which files
  it uploaded is gone. The files stay on Drive, but if the same folder is
  added again the app re-uploads everything and Drive ends up with
  duplicates. The manifest copy in the backup location survives the delete, so
  the file list can be recovered by hand. This is the user's choice: they were
  offered archiving instead and chose a permanent delete.
- **A Google account whose address changes becomes a different account.** The
  old account stays signed out with its mirrors, and a new empty account
  appears. The dropdown shows every account with its email and mirror count,
  so the situation is visible, but the app does not guess. This is the user's
  choice: they were offered to rebind the history and chose always-new.
- **The migration is the riskiest thing in this work.** It touches the only
  copy of the manifest. It copies before it moves, it copies the legacy
  settings file before it overwrites anything, it verifies before it deletes,
  it is resumable, and it leaves the legacy files alone on any failure.
- **Two accounts on one disk, one of them changed, is still a busy machine.**
  The app holds one lock, so a run for one account waits for the other. With
  two accounts on an hourly schedule, a run can be delayed. The missed-run
  logic catches the slot up, and the skipped-slot fix in §7.6 is what makes
  that work.
- **A scheduled slot can still be lost** if the app is busy for longer than
  the retry window and the next tick is a long way off. The slot is caught up
  at the next tick, so the work is not lost, only delayed.
