# Drive Mirror — Design

**Date:** 2026-10-21
**Status:** Draft for approval (rev 9)
**One-line:** A native-feeling Windows 11 desktop app that mirrors four folders on `E:` up to `My Drive/` on Google Drive, with a persistent checksum manifest and multiple anti-catastrophe guards.

---

## 1. Intent and the why

The user keeps four working trees on `E:` — `Medicine`, `graphicDesign`, `videoEditing`, `whoami` — and wants them mirrored to Google Drive so a second machine (or a lost laptop) still has the work.

The trees are small in file count (43 / 43 / 113 / 55 = **254 files**) but large in bytes (~1.93 GB total, one 292 MB file in `videoEditing`) and they contain **many files with identical names** across different directories. That single fact drives the entire comparison design: comparison must be by **full relative path**, never by filename.

The user's overriding priority is **safety over convenience**. The app must never mass-delete on Drive, never permanently delete anything, and never touch Drive outside the four target folders. Every decision below is subordinate to that.

### Goals

- A real, packaged, double-clickable Windows 11 desktop application with a GUI.
- Manual "Sync now" — no scheduler, no service, no background agent.
- Bidirectional mirror with `E:` as the authority on **structure** and a documented rule for **content** conflicts.
- A persistent manifest that makes "I deleted this locally" distinguishable from "this is new on Drive".
- Four independent safety guards (§8).
- Sync logic fully testable without launching the UI or touching the network.

### Non-goals

- Scheduled / unattended / background sync.
- Multiple Google accounts or multiple Drive roots.
- Shared Drives, "shared with me" shortcuts, or team folders.
- End-to-end encryption of file content, or sync of anything outside the four named folders.
- **Rename detection in either direction** — see §6.8 for why this is deliberately excluded and what it costs.
- Any process that permanently deletes data, anywhere, ever.

### Anti-goals (what would make this a failure even if it "worked")

- Trashing the entire Drive mirror because `E:` was not mounted or was swapped for a different disk.
- A silently wrong diff — e.g. reporting every `render_final_v3.psd` as changed because two different folders contain a file with that name.
- **Silently re-downloading files the user deleted locally**, undoing their deletions. This is the single most important failure to avoid; §9.3 explains the mechanism and §6.3 the guard.
- **Trashing a Drive file whose local copy still exists**, because the local tree could not be read completely.
- **Never uploading a local file.** A file the user created must reach Drive; a mirror that silently skips local files is not a mirror.
- **A file that stops syncing forever** because of an unhandled state in the rule table.
- **Duplicating files on Drive** because a state was misread.
- A crash mid-upload corrupting a file already on Drive.
- The app touching a Drive folder the user did not name.

---

## 2. Confirmed decisions

| Topic | Decision |
|---|---|
| Platform | Windows 11 desktop app, packaged `.exe` |
| Stack | **Electron + React + TypeScript** (§3) |
| Consent screen | **In production** (refresh tokens do not expire after 7 days) |
| OAuth scope | `https://www.googleapis.com/auth/drive` (full; `drive.file` cannot see `My Drive/Medicine`) |
| Deletion target | **Google Drive's own Trash.** Recovers for 30 days, then Google purges. Accepted by the user. |
| Client credentials | Entered in the app's **Settings** screen, stored encrypted. Not hardcoded in the repo. |
| Drive-modified-only | Drive version wins → downloaded into `E:` (rule B1) |
| Both-modified | `E:` wins → uploaded; Drive's version archived locally first (rule B1) |
| Local-vs-Drive conflict, same path | **Local wins**; Drive bytes archived locally first (rule C3). One consistent principle, applied everywhere except during a rebase. |
| Empty local folders | Mirror as empty Drive folders. Drive folders are **never** trashed. |
| Illegal Windows filenames on Drive | **Inert**: never downloaded, never trashed, reported every run (§6.7) |
| Google-native Drive files | **Never uploaded over, never trashed.** Their local copy is a regenerated export (§6.6). |
| Symlinks / junctions | **Skipped**, never followed. A junction occupying the path of a synced file blocks the trash rule (§5.2) |
| Auto-sync | **None.** Manual "Sync now" only |
| Manifest format | JSON, atomic writes, journal + checkpoint |
| Manifest backup | `E:\.drive-mirror-backup\` (live copy) + dated snapshots in `%LOCALAPPDATA%` |

---

## 3. Stack and why

**Electron 44 + React 19 + TypeScript, built with electron-vite 6, packaged with electron-builder 26.**

- **Electron** — the machine already has Node 24 and npm 11, and the WebView2 runtime is present, so no toolchain install is needed. Electron gives a genuine native-feeling Windows app: real window chrome, system-native menus, native file dialogs, and `safeStorage` for DPAPI-backed credential encryption. Packaging to a double-clickable `.exe` is one `electron-builder` command.
- **Rejected: Tauri** — needs a Rust toolchain (absent), and its Rust side adds a second language for a job that is entirely I/O and JSON.
- **Rejected: .NET / WinUI 3** — no .NET SDK on this machine; heavy install; worse OAuth story for the installed-app loopback flow.
- **Rejected: Python + Qt** — no `PySide` present; Python-to-`.exe` packaging is fussier; the async Drive REST work is more natural in Node.
- **Rejected: raw WebView2 host** — hand-writing a native-feeling window, tray, and packaging story is more work than the entire sync engine.

**Core is framework-free TypeScript.** `src/core/` imports nothing from `electron` and nothing that needs a display or the network. It talks to two injected ports: a `LocalTree` source and a `DriveClient` interface. The whole diff/guard/manifest engine is testable under plain Vitest in milliseconds.

### Dependencies

| Package | Version | Purpose |
|---|---|---|
| `electron` | 44.9 | app shell |
| `electron-vite` | 6.0 | dev server + main/preload/renderer builds |
| `electron-builder` | 26.15 | NSIS installer + portable `.exe` |
| `react` / `react-dom` | 19.3 | UI |
| `google-auth-library` | 11.3 | OAuth2 client, token refresh |
| `vite` | 8.3 | build |
| `vitest` | 5.0 | tests |
| `@vitejs/plugin-react` | 6.1 | React fast refresh |
| `typescript` | 5.x | types |

**No `googleapis` bundle.** We use `google-auth-library` for auth and issue Drive REST calls directly over `fetch`. Reason: full control over resumable-upload chunking and over the null-status failure mode (§9.5), and a far smaller dependency tree in the main process.

---

## 4. Repository layout

```
E:\dev\drive-mirror\
├─ package.json
├─ electron.vite.config.ts
├─ tsconfig.json
├─ vitest.config.ts
├─ build\                        # icons, installer assets
├─ src\
│  ├─ core\                      # PURE TypeScript — no electron, no network
│  │  ├─ types.ts                # shared domain types
│  │  ├─ paths.ts                # canonical path keys (NFC, case, separators)
│  │  ├─ manifest.ts             # manifest schema, atomic write, journal, checkpoint
│  │  ├─ localScan.ts            # walk E:\ tree → LocalTree (present/absent/unknown)
│  │  ├─ driveTree.ts            # Drive listing → driveFiles + driveDirs
│  │  ├─ claims.ts               # claim index + native export path planning
│  │  ├─ diff.ts                 # the normative dispatch (§6.3)
│  │  ├─ guards.ts               # count-drop guard, volume fingerprint guard
│  │  ├─ sync.ts                 # plan executor, action ordering, error isolation
│  │  ├─ hashing.ts              # streaming MD5 + size/mtime fast path
│  │  ├─ googleMime.ts           # native-type detection + export MIME map
│  │  └─ logger.ts               # structured event log
│  ├─ drive\                     # implements the DriveClient port
│  │  ├─ client.ts               # DriveClient interface + errors
│  │  ├─ httpClient.ts           # REST impl: list, get, create, update, trash, export
│  │  ├─ resumable.ts            # resumable upload sessions + null-status recovery
│  │  └─ oauth.ts                # loopback OAuth flow, token persistence
│  ├─ main\                      # Electron main process
│  │  ├─ index.ts                # app lifecycle, window, single-instance
│  │  ├─ ipc.ts                  # typed IPC surface
│  │  ├─ settings.ts             # client id/secret, manifest path, overrides
│  │  ├─ runner.ts               # wires core + drive + events → progress
│  │  └─ window.ts
│  ├─ preload\index.ts           # contextBridge API
│  └─ renderer\                  # React UI
│     ├─ index.html
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ components\
│     │  ├─ FolderCard.tsx
│     │  ├─ SummaryBar.tsx
│     │  ├─ ProgressPanel.tsx
│     │  ├─ LogView.tsx
│     │  ├─ SettingsDialog.tsx
│     │  └─ GuardBanner.tsx
│     └─ styles.css
└─ test\
   ├─ diff.test.ts
   ├─ exhaustiveness.test.ts
   ├─ localScan.test.ts
   ├─ guards.test.ts
   ├─ rebase.test.ts
   ├─ manifest.test.ts
   ├─ paths.test.ts
   ├─ sync.test.ts
   ├─ listing.test.ts
   └─ helpers\fakeDrive.ts       # in-memory DriveClient for tests
```

---

## 5. Data model

### 5.1 Canonical path keys

Every path in every map is stored as a **canonical key**:

```
canon(p) = p.replace(/\\/g, "/").normalize("NFC").toLowerCase()
```

Lowercase because the local filesystem is case-insensitive while Drive is case-sensitive — `Photo.JPG` and `photo.jpg` must be the same file. NFC because Drive normalizes to NFC and macOS-origin names often are not. Separators normalized to `/`.

**All map keys and all lookups use the canonical form.** The original casing is kept in a separate `displayPath` field for the UI. This is stated explicitly because a mismatch between "keys are canonical" and "Drive's casing is preserved" is a silent-duplicate-upload bug.

### 5.2 Local tree — three states, not two

A mirror's local state is a map from canonical relative path → an entry with a **state**:

| State | Meaning |
|---|---|
| `present` | The path was read successfully; `size`, `mtimeMs` and (lazily) `md5` are known |
| `absent` | The path does not exist on disk. The user deleted it |
| `unknown` | The path **could not be read** — permission denied, I/O error, path too long, or a junction/symlink occupies it |

**How the three states are determined.** This matters because rule B0 — the only trash rule — fires only on `absent`.

- The scanner walks the local tree and records every file it can read as `present`, and every file it can see but not read as `unknown`.
- **A path that is not in the local tree at all is `absent`.** The scanner does not need to know that a file was deleted; the *absence* of the path from the tree is the evidence. The manifest is consulted only to mark paths as `unknown`: for every path the manifest knows about, if the path lies **under an unreadable directory**, it is marked `unknown` rather than `absent`.
- That last point is the whole reason `unknown` exists. If an unreadable subtree were treated as "the files are gone", the app would trash their Drive copies.

**`unknown` is not `absent`.**

Any path in state `unknown`:

- is excluded from **every** rule — the dispatch (§6.3) skips such paths at step P3, before any group is consulted;
- is **reported by the scanner**, which emits one line per unreadable directory: *"could not read `E:\...\renders\final` (access denied) — 14 files were skipped and left untouched on Drive."* The scanner's report is the only source of this message; no rule emits it, because a rule cannot know how many files were skipped.

A junction or symlink occupying the path of a previously-synced file makes that path `unknown`, which blocks B0. The Drive copy survives until the user replaces the junction with a real file.

Directories are a separate set of paths. Symlinks and junctions are never followed.

### 5.3 Drive tree — files and folders are separate structures

The Drive listing returns both files and folders. They are stored in **two separate structures**, and this separation is deliberate:

- **`driveFiles`** — canonical path → **an array** of file entries, because Drive permits more than one file under one name:

```
{
  id, name, mimeType, size, md5?, driveModifiedTime, parentRelPath,
  unrepresentable: boolean,   // name not representable on Windows
  ambiguous: boolean          // >1 entry under this key
}
```

- **`driveDirs`** — canonical path → folder id. Folders are **never** part of the diff. They exist only so §7.1 can create missing ones and so an upload knows its parent.

A path with exactly one file entry is usable. A path with two or more is **ambiguous**: step P1 skips it entirely (§6.7) and it is reported. The tree stores all entries so the report can name them, but never picks a winner.

Had folders been left in the file tree, every Drive folder with no local counterpart would have matched the "download it into `E:`" rule, producing a 404 on `alt=media` for every folder on every run.

### 5.4 Manifest

Stored at `%LOCALAPPDATA%\DriveMirror\manifest.json`.

```jsonc
{
  "version": 9,
  "updatedAt": "2026-10-21T10:00:00.000Z",
  "volumes": {
    "E:": { "dev": 404660920, "label": "Local Disk", "checkedAt": "2026-10-21T09:59:00.000Z" }
  },
  "mirrors": {
    "Medicine": {
      "root": "E:\\Medicine",
      "driveFolderId": "1AbCdEf...",
      "driveFolderName": "Medicine",
      "lastSyncAt": "2026-10-21T09:59:00.000Z",
      "lastCounts": { "": 43, "incision": 29, "researchs": 14 },
      "rebase": null,             // or { "pending": true, "mergePolicy": "drive-wins" }
      "dirs": { "incision": { "driveFolderId": "1GhIjK..." } },
      "files": {
        "renders/scene_01.psd": {
          "displayPath": "renders/scene_01.psd",
          "driveFileId": "1XyZ...",
          "driveMd5": "9f2b...",
          "driveModifiedTime": "2026-10-20T18:00:00.000Z",
          "driveMimeType": "application/octet-stream",
          "exportMime": null,
          "localPath": "renders/scene_01.psd",
          "localMd5": "9f2b...",
          "localSize": 204800,
          "localMtimeMs": 1759660800000
        }
      },
      "retired": {
        "1QaBcD": {
          "path": "renders/old.psd",
          "state": "trashed",
          "at": "2026-10-20T12:00:00.000Z",
          "md5": "77aa..",
          "driveMimeType": "application/octet-stream",
          "localPath": null,
          "prevLocalMd5": "12bc.."
        }
      }
    }
  }
}
```

**The manifest is split into two maps, and that split is load-bearing.**

- **`files`** holds only **live** tracked entries, keyed by canonical **Drive relative path**. Every entry is a file the app believes is present on both sides and in sync.
- **`retired`** holds every Drive file id the app has stopped tracking, keyed by **`driveFileId`**, with the path it occupied, a state, and the MD5 it had.

The split exists because several situations produce **two facts about the same path** — the old file is trashed on Drive *and* a new local file now occupies that path; the old file was deleted on Drive *and* a different Drive file took its place. A single path-keyed map can hold only one of those facts, which would either resurrect deleted files or permanently exclude a path from syncing. Keying `retired` by id resolves this.

**`retired` records are never deleted and never weakened.** A `trashed` record is the **proof** that the user deleted that file locally; losing it would let the file be re-downloaded. Records are only ever *transitioned* between states, and the transition table below says exactly which transitions exist.

#### `retired[].state` — the complete state set

| State | Meaning | Entered by | Consumed by |
|---|---|---|---|
| `trashed` | **The app** moved this Drive file to Trash because the local file was deleted. It may still be in Trash, or the user may have restored it. | B0 | R1, R7, D1 |
| `trashed-externally` | Someone else (another person, or the user in the Drive UI) trashed this Drive file. **The app did not do this and will never undo it.** | B3, N5, N7 | R1, R7, D2 |
| `gone` | The Drive file was deleted on Drive permanently. | B2, B3, B4, N5, N6 | R4, D3 |
| `restored` | The user restored this file from Drive Trash. It is on Drive and the app **leaves it alone forever** — no download, no trash. | R1 | R2, R3, D3 |
| `purged` | Google purged the file from Trash. It is gone forever and will never reappear. | D1 | R4, D3 |
| `moved` | The file was renamed or moved on Drive. Its content lives at a new path. | B2, B3, B4, D1, N5, N9 | R5, R6, D3 |
| `rebased` | The volume changed under this file. Carries the **old local fingerprint** so the app can tell "the same file came back" from "a different file took its place". | §8 rebase | R8, R9, R10, D4 |
| `resynced` | The file became live again under the same Drive id and is now tracked by a live `files[]` entry. The record is kept for audit but **drives no rule** — the live `files[]` entry owns the id. | R6, R7, R9, R10, D1 | — (see step P4) |

The distinction between `trashed` and `trashed-externally` is not cosmetic. A single `trashed` state carrying both meanings let rule D1 un-trash a file that another person had deliberately removed from Drive, silently resurrecting it and erasing the "unbacked-up file" warning.

`resynced` exists so that **no record is ever deleted**. When a file is restored and re-synced, the record moves to `resynced` — retained forever, but no longer driving any rule, because the live `files[]` entry now owns the id. **Step P4 explicitly excludes `resynced`**, so the path falls through to the ordinary rules and keeps syncing. Without that exclusion the path would freeze permanently, because no rule in Group R handles `resynced`.

**Every state transition refreshes `at`.** The `at` timestamp is the tie-break for the path-scoped lookup (§5.4, "Tie-break"), so a transition that did not update it could leave a stale record as the winner. A record whose state changes to `resynced` gets the current time; so does every other transition.

**A `resynced` record never reaches step P9.** Every rule that writes `resynced` writes the live `files[P]` entry in the same operation, and every rule that later removes a live entry transitions **that same id's** record to the matching state (B0 → `trashed`; B3/B4 → `gone` / `trashed-externally` / `moved`; N5/N6/N7/N9 → likewise). A `resynced` record therefore always has a live entry beside it, and step P4 — not step P9 — handles the path.

**`localMd5` is the MD5 of the file's content as of the last sync.** For a synced binary it equals `driveMd5` (same bytes on both sides). It is the value the rebase conversion (§8) copies into a `rebased` record as `prevLocalMd5`, so the rebase rules can tell "the same file came back" from "a different file took its place". When Drive provides no checksum, `driveMd5` and `localMd5` are `null`, and the rebase rules treat the content as **changed** — which resolves to the safe direction (the Drive copy wins).

#### `retired[].path` — historical, not current

`path` is the path the id occupied **at the moment it was retired**. It is used only for path-scoped lookups (D1–D5). It is **not** where the file lives now. A file renamed on Drive has its retired record pointing at the *old* path.

**`retired[].md5`** is the MD5 of the Drive file's content at the moment it was retired. It is `null` when Drive provides no checksum. The rebase rules compare it against the Drive file's *current* checksum to detect a Drive-side edit (§6.3, R9/R10).

**`retired[].localPath`** — the export path of a retired native file

For a Google-native file, `localPath` records the **export path** it used — `Budget.csv` for a Drive file named `Budget`. When such a file is retired, the export path is remembered so that the stale export is **never uploaded as a stray binary** (§6.2, Pass A). Every rule that retires a live entry carries the entry's `localPath` into the retired record when that entry was a native file: **B2**, **B3**, **B4**, **N5**, **N6**, **N7**, **N9**, and the rebase conversion (§8). For every other file, `localPath` is `null`.

#### Indexes derived on load

The manifest is loaded into these indexes, rebuilt on every load and updated on every write:

- `files` — canonical path → live entry.
- `retired` — driveFileId → retired record.
- `retiredByPath` — canonical path → retired records at that path, **newest first** (by `at`, descending).
- `retiredById` — the same records keyed by id. **This index exists precisely because id membership is checked globally, not per path.**

`retiredByPath` is required: `retired` is keyed by id and is never pruned, so scanning it per path would be O(retired) per path over a growing map. Both indexes are rebuilt in O(n) at load.

**Tie-break when several retired ids share a path.** `retiredByPath[path][0]` — the most recently retired, by `at` — is *the* record for path-scoped rules. Older records at the path are still in the index but do not drive actions. The newest is the one the app most recently wrote there, so it is the one the user's actions refer to.

**Consequence of the historical path.** A path that once held a retired Drive file keeps a retired record, so it is routed to Group D (step P9) rather than Group E (step P10). A brand-new local file at such a path is therefore handled by D1/D3, not E1 — which is correct, because the retired record is exactly the information needed to restore the original Drive id rather than creating a duplicate.

#### `lastCounts`

Keyed by **every** directory path known for that mirror, including directories that have since disappeared. It is the baseline for Guard 3 and is what makes a wholly-deleted subtree detectable.

Counts are **recursive**: a directory's count is the number of files in it *and all its descendants*. The root's count is the mirror's total file count.

### 5.5 Journal, checkpoint, and write-ahead intent

The manifest is rewritten atomically (write `manifest.json.tmp` → `fsync` → `rename`) but not on every single file operation — for a large tree that is O(n²) I/O. Instead:

- A **journal** (`journal.ndjson`) is appended with one line per completed operation. Each append is **`fsync`'d** before the operation is considered done.
- A **checkpoint** rewrites the full manifest atomically at the end of each mirror, and every 250 operations.
- On startup, the journal is replayed on top of the last checkpoint to recover operations completed after the last checkpoint.

**Write-ahead intent.** Some Drive mutations can lose information if their manifest write is lost, and the next run would then act on a false belief. Two classes need a durable record written **before** the mutation:

**Class 1 — create-upload** (a file that did not exist on Drive before). If the upload succeeded but the manifest write did not, the next run sees a Drive file with no manifest entry and no local file — and would download it, resurrecting a file the user had deleted in the meantime.

```
{ "op": "intent", "path": "...", "parentId": "...", "localMd5": "...", "size": 1234 }
```

The complete list of create-upload branches is:

| Rule | Branch |
|---|---|
| **E1** | always |
| **D1** | the `404` branch and the `alive, moved` branch |
| **D3** | always |
| **D4** | always |
| **B3** | the `404` branch and the `alive, moved` branch |
**Class 2 — un-trash** (rule D1's `trashed` branch, and only that branch). It mutates Drive (`trashed=false`) *before* any durable record says so. If the app dies between the un-trash and the journal append, the manifest still says `trashed` while the file is live: the next run sees the file at P4, rule R1 fires, and it reports a false *"X was restored from Drive Trash"* and flips the record to `restored` — which rule R2 then honours forever, **freezing the path permanently**. The intent record prevents this:

```
{ "op": "intent", "untrash": "<driveFileId>", "path": "..." }
```

On startup, an unresolved un-trash intent is resolved by probing the id: if the file is live, the journal line is replayed as if the un-trash had completed; if it is still trashed, the intent is dropped.

**Class 3 — no intent needed.** Rules that replace the content of an **existing** Drive file (B1, B2, C3, R6, R7, R10, and D1's in-place branches) are self-healing: the manifest still holds the id, so the next run sees "neither changed" and the upload is simply repeated.

A checkpoint is **all-or-nothing**: it writes the complete manifest, including every mirror's `rebase` flag and the volume serial, in one atomic rename. This is what makes the rebase in §8 atomic across mirrors.

---

## 6. The diff engine

### 6.1 Inputs

The engine compares `L` (local tree), `D` (drive files) and `M` (manifest). The manifest is what makes the asymmetric rules possible.

The engine iterates over the **union** of:

- canonical local file paths,
- canonical Drive file paths,
- canonical `files` keys,
- **canonical paths of retired records** (`retiredByPath` keys).

Including retired paths is what keeps rule D5 reachable: a path with no local file, no Drive file and no live entry is otherwise never visited, and the rule table would contain an unreachable entry.

The iteration set is a set, so a path appearing in several sources is visited once.

For each path `P`:

- `L(P)` — the local entry at `P`, with its state (`present` / `absent` / `unknown`), per §5.2.
- `D(P)` — the Drive file entries at `P`. Usable only if there is exactly one and it is neither `unrepresentable` nor `ambiguous`.
- `M(P)` — the live manifest entry at `P`.
- `Rt(P)` — retired records at `P`, newest first.
- `rec` — the retired record for a **given Drive file id**, looked up globally by id.

### 6.2 The claim index

A local file is not automatically an upload candidate. The engine builds a **claim index**:

```
claimedBy: Map<canonicalLocalPath, Set<manifestKey>>
retiredClaims: Set<canonicalLocalPath>     // export paths of retired native files
```

A local path is claimed by a manifest key when either:

1. A live manifest entry records that path as its `localPath` — the app created or adopted that file; or
2. The path is the **planned export path** of a Google-native Drive file (§6.6).

A local path is in `retiredClaims` when a **retired** Google-native file recorded it as its export path. Such a path is a stale export of a document that is no longer tracked. It is **never uploaded** — it is a derived artifact, not user content — and it is **reported once**, so the user can rename or move it if they want it backed up. (Without the report, a user file created at a retired export path would be silently skipped forever.)

The index is a **multi-map** because two keys can legitimately want the same local path. When a path is claimed by more than one key, rule P2 skips it and reports it.

**Claiming by name alone is not sufficient.** If the user's own unrelated file happens to sit at a native file's natural export path, treating it as the export would silently swallow that file — it would never be uploaded to Drive. Content-verified claiming avoids that.

**A claimed local file is still `L(P)` at its own path.** The claim changes what the file *is for* (it is the local representation of another manifest key), not whether it exists. This matters: rule B0 fires when `L(P)` is `absent`, so a claimed file at `P` must not read as absent, or the Drive file at `P` would be trashed while its local counterpart sits on disk.

#### Pass A — planning (no side effects)

The claim index must be complete *before* the diff runs, but a native file's export path is chosen during the diff. So the diff runs in two passes.

**Pass A** plans the export path of every Google-native Drive file and builds the claim index:

```
for each native Drive file D at path P (in canonical path order):
    ext = exportExt(D.mimeType)
    if ext is undefined:
        # no export exists for this native type (forms, scripts, sites)
        continue                                  # rule N11 handles it; no path planned

    owner = the manifest entry whose driveFileId == D.id   (may be undefined)

    candidates = []
    if owner and owner.localPath:  candidates.push(owner.localPath)   # ours, always acceptable
    candidates.push(P + ext)                                        # the natural path
    for n = 1, 2, ...:  candidates.push(P + " (export " + n + ")" + ext)

    chosen = undefined
    for c in candidates:
        if owner and c == owner.localPath: chosen = c; break        # ours
        if c collides with another Drive file path,
                     another manifest entry's localPath,
                     another planned export path,
                     a retired native file's export path,
                     or a local file present on disk:
            continue                                                  # someone else's
        chosen = c; break

    if chosen is undefined:  chosen = candidates[0]; report a conflict
    plan[D.id] = chosen
```

"Collides with a local file present on disk" is what stops the export from overwriting the user's own file at `P + ext`. The collision check against the **local disk** is not optional: without it, the planner hands the export to a path the user already occupies, and rule N1 then overwrites their file with no archive.

**Pass A then builds the claim index**: every manifest entry contributes `claimedBy[entry.localPath].add(entryKey)`, every planned native export contributes `claimedBy[plan[D.id]].add(nativeKey)`, and every retired native record contributes `retiredClaims.add(record.localPath)`.

**Pass B** runs the dispatch (§6.3) with the complete claim index. Rule N1 performs the actual export using the path planned in Pass A.

### 6.3 The normative dispatch

**This section is the single normative definition of the sync engine.** Appendix A is a mechanical restatement of it, generated from the same table; where they differ, this section wins.

For each path `P` in the iteration set, the **first** matching step applies. Each step either performs its action and **stops** for that path, or passes control to the next step.

The steps are ordered so that they **partition** the input space. Every path reaches exactly one step, and no path reaches two.

| Step | Condition | Outcome |
|---|---|---|
| **P1** | `D(P)` exists and is ambiguous or unrepresentable | Skip `P` entirely; report. **Stop** |
| **P2** | The local path `P` is claimed by a manifest key `K ≠ P`, **or** `P ∈ retiredClaims` | Claimed by another live key → `D(P)` usable → skip `P`, report the conflict; `D(P)` absent → skip `P` silently (an export artifact owned by `K`). In `retiredClaims` → skip `P` silently (a stale export of a retired native file). **Stop** |
| **P3** | `L(P).state == "unknown"` | Skip `P`; the scanner's report covers it (§5.2). **Stop** |
| **P4** | `D(P)` is usable **and** `rec = retiredById[D(P).id]` exists **and `rec.state != "resynced"`** | **Group R.** Resolve by `rec.state`. **Stop** |
| **P5** | `D(P)` is usable **and** `D(P).mimeType` is Google-native | **Group N.** **Stop** |
| **P6** | `M(P)` exists, `M(P).driveMimeType` is Google-native, `D(P)` is absent | **Group N** (rules N6–N9). **Stop** |
| **P7** | `M(P)` exists | **Group B.** **Stop** |
| **P8** | `M(P)` is null, `D(P)` is usable | **Group C.** **Stop** |
| **P9** | `M(P)` is null, `D(P)` is absent, `Rt(P)` is non-empty | **Group D.** **Stop** |
| **P10** | `M(P)` is null, `D(P)` is absent, `Rt(P)` is empty | **Group E.** **Stop** |

**Why the partition holds.** Consider the two axes `M(P)` ∈ {null, exists} and `D(P)` ∈ {absent, usable, unusable}.

- `D(P)` unusable → **P1**, always. Nothing below can be reached.
- `M(P)` exists:
  - `D(P)` absent → **P6** if `M(P).driveMimeType` is Google-native, else **P7**.
  - `D(P)` usable → **P4** if the Drive id is a retired id (other than `resynced`), else **P5** if the Drive file is Google-native, else **P7**.
- `M(P)` is null:
  - `D(P)` absent → **P9** if `Rt(P)` is non-empty, else **P10**.
  - `D(P)` usable → **P4** if the Drive id is a retired id (other than `resynced`), else **P5** if the Drive file is Google-native, else **P8**.

Each cell resolves to exactly one step, so no path reaches two steps and none reaches zero. P2 and P3 are **pre-gates**: they sit above this partition and stop a path before it reaches any cell.

**The `resynced` exclusion in P4 is load-bearing.** A `resynced` record means the id is live and owned by a `files[]` entry. If P4 matched it, the path would enter Group R, which has no `resynced` row, and the file would **stop syncing forever**. Excluding it lets the path fall through to P5 or P7, where the live entry takes over — the ordinary "compare and act" path.

#### Group R — the Drive file is a known, retired id (step P4)

Let `rec = retiredById[D(P).id]`.

| # | `rec.state` | `L(P)` | Action | Manifest write |
|---|---|---|---|---|
| **R1** | `trashed`, `trashed-externally` | `absent` | The user deleted it locally (or someone else trashed it); the file is now live again because it was **restored**. **Do not download.** Leave it on Drive. Report it once: *"X was restored from Drive Trash — it is on Drive but not on `E:`."* Offer a one-click **"Download to `E:`"** action. Never re-trash it — that would fight the user | **W-retire(id, "restored", P)** — the state flip is the "report exactly once" mechanism; thereafter rule R2 applies |
| **R2** | `restored` | `absent` | Nothing, ever, at any path. The user restored it; the app leaves it alone permanently and stays quiet | — |
| **R3** | `restored` | `present` | The user restored the Drive file and a local file occupies the same path. **Leave both untouched.** Uploading would create a duplicate name; downloading would destroy the local file. Report the conflict every run, in the "needs attention" group | — |
| **R4** | `gone`, `purged` | any | These states mean the file cannot exist on Drive, so its presence is an anomaly (Drive never reuses file ids). **Leave it alone: never download, never trash, never upload over.** Report the anomaly every run | — |
| **R5** | `moved` | `absent` | A known file that now lives at this path. Treat it as new-on-Drive: **download** it into `E:`, keep the Drive copy. If the file is Google-native, **export** it instead of downloading (§9.2). **The `moved` record is released**, so the path returns to the ordinary rules on the next run | **W-live(P)** with the Drive id; **W-retire(id, "resynced", P)** |
| **R6** | `moved` | `present` | The local file and the Drive file are different files at the same path. **Local wins**: archive the Drive bytes, then replace the Drive content **in place, keeping the Drive file id**. Under `drive-wins`: archive the **local** bytes, then download the Drive version over it (exporting if the file is Google-native). **If `D(P)` is Google-native, this rule does not apply** — see rule N11 | **W-live(P)** with the Drive id; **W-retire(old id, "resynced", P)** |
| **R7** | `trashed`, `trashed-externally` | `present` | The user restored the Drive file and a local file occupies the path. **Local wins**: archive the Drive bytes, then replace the Drive content **in place, keeping the restored Drive id**. This backs the local file up without creating a second file under the same name. Under `drive-wins`: archive the **local** bytes, then download the Drive version over it (exporting if the file is Google-native). **If `D(P)` is Google-native, this rule does not apply** — see rule N11 | **W-live(P)** with the Drive id; **W-retire(id, "resynced", P)** |
| **R8** | `rebased` | `absent` | The volume changed under this file. **Do not download.** The local file was deleted before the volume change and that deletion was never synced. Leave the Drive file alone and report it: *"not downloaded — the path was empty locally before the volume changed"* | — (the record stays `rebased`: it is the anti-resurrection proof) |
| **R9** | `rebased` | `present`, local `md5 == rec.prevLocalMd5` **and** the Drive file's current `md5 == rec.md5` | The same file came back, unchanged on both sides. Adopt it: write the live entry back, no transfer. **The `rebased` record is released**, so the path returns to the ordinary rules on the next run | **W-live(P)** with the Drive id; **W-retire(id, "resynced", P)** |
| **R10** | `rebased` | `present`, and **either** the local `md5 != rec.prevLocalMd5` **or** the Drive file's current `md5 != rec.md5` | Something changed on one side or the other — a different file took the place, or the Drive copy was edited after the last sync. Reconcile by the conflict principle (§6.3): under `drive-wins` (the rebase default) archive the **local** bytes and download the Drive version over it; under `local-wins` archive the **Drive** bytes and upload local over it. **If `D(P)` is Google-native, this rule does not apply** — see rule N11. **The `rebased` record is released** | **W-live(P)** with the Drive id; **W-retire(id, "resynced", P)** |

**R9 and R10 must release the `rebased` record.** If they left it as `rebased`, step P4 would match the id again on the next run and the path would be pinned in Group R forever: local deletions would never be trashed, Drive-side edits would never be downloaded, and every local edit would re-upload the whole file on every run — because the comparison would keep using the stale pre-rebase hashes. Writing `resynced` releases the record and restores rules B0 and B1 for that path. **R8 does not release it**, because a file that is absent locally is exactly the case the record exists to protect.

**R9 and R10 compare *both* sides.** R9 requires the local content to match the pre-rebase local hash **and** the Drive copy to match the pre-rebase Drive hash. If the Drive copy was edited after the last sync, R9 must not fire: adopting the stale local content would make the mirror diverge silently, and B1's size+mtime fast path would then report "neither changed" forever. Any difference on either side sends the path to R10, which reconciles by the conflict principle — under the rebase's `drive-wins`, the Drive copy wins.

**The Google-native guard on R6, R7 and R10.** A Google-native Drive file is never uploaded over (§6.6). If the Drive file at `P` is Google-native and a local binary occupies the same path, the outcome is the same as rule N11: **report the conflict and change nothing**. The native file is *not* exported on this path, because P4 has already claimed the path for Group R. This is the one documented exception to "the native file is always backed up into `E:`" (§6.6).

#### Group N — Google-native files (steps P5, P6)

A Google-native Drive file is **never uploaded over and never trashed** (§6.6).

| # | Condition | Action | Manifest write |
|---|---|---|---|
| **N1** | First sight: `M(P)` is null, `D(P)` is native, and an export mime exists | Export to the **planned** export path `E` (Pass A, §6.2). If `E` already holds bytes **identical** to the fresh export → adopt `E` as the export path and **write nothing to disk**; the file is the export. Otherwise write the export to `E`. Either way the native file **is** backed up into `E:`, and the user's unrelated file at another path is left untouched | **W-live(P)** with `localPath = E`, `exportMime`, `driveModifiedTime` |
| **N2** | `M(P).driveFileId == D(P).id` and `D(P).driveModifiedTime != M(P).driveModifiedTime` | Re-export. Before overwriting the recorded `localPath`: if the local export exists and its bytes **differ** from the fresh export, the user edited it → **archive the local file** (§7.3) first, then overwrite, and report it | **W-live(P)** with the new `driveModifiedTime` |
| **N3** | `M(P).driveFileId == D(P).id`, unchanged, and the recorded `localPath` is missing | The export was deleted locally. Regenerate it. Native Drive files are **never** trashed in response to a deleted export | **W-live(P)** unchanged |
| **N4** | `M(P).driveFileId == D(P).id`, unchanged, export present | Nothing to do | — |
| **N5** | `M(P)` exists and `M(P).driveFileId != D(P).id` | The Google-native file at `P` **replaced** whatever we tracked at `P` (a binary, or an earlier native file with a different id). Probe `M(P).driveFileId` (§9.6) and retire it as `gone` / `trashed-externally` / `moved`; delete `files[P]`. Then treat `D(P)` as a first sight: export it to its planned path and adopt it. **Never upload over it, never trash it.** If the retired entry was itself a native file, its export path is carried into the retired record so the stale export is never uploaded as a stray binary | **W-retire(old id, "gone" / "trashed-externally" / "moved", P)** with the old `localPath` if the old entry was native; delete `files[P]`; **W-live(P)** with `D(P).id` and its planned export path |
| **N6** | `M(P)` is a native entry, `D(P)` is absent, and the probe (§9.6) returns **404** | The native file was deleted on Drive. Remove `files[P]`, record it retired `gone` (carrying the export path). The local export is left in place; it becomes a stale export of a retired native file and is **never uploaded** | **W-retire(id, "gone", P)** with `localPath`; delete `files[P]` |
| **N7** | `M(P)` is a native entry, `D(P)` is absent, and the probe returns **`trashed: true`** | Someone else trashed the native file on Drive. **Never restore it.** Record it `trashed-externally` and report the local export as unbacked-up | **W-retire(id, "trashed-externally", P)** with `localPath`; delete `files[P]` |
| **N8** | `M(P)` is a native entry, `D(P)` is absent, and the probe returns **alive, not trashed, same path** | The file was merely missed by the listing. **Re-adopt it**: write the live entry back unchanged, no transfer | **W-live(P)** unchanged |
| **N9** | `M(P)` is a native entry, `D(P)` is absent, and the probe returns **alive, not trashed, different path** | The native file was **moved on Drive**. Retire the entry as `moved` and delete `files[P]`; the moved file is picked up at its new path as a first sight (rule N1). The local export stays on disk and becomes a stale export, which is **never uploaded** | **W-retire(id, "moved", P)** with `localPath`; delete `files[P]` |
| **N10** | A local file exists at the **exact canonical path** of a native Drive file | Conflict: a local binary sits at the Drive path of a Google-native file. **The native file is still exported** to its planned path — which by construction never collides with that local file, because the planner treats a local file present on disk as a collision. The local binary is left untracked: the only Drive path it could occupy is already owned by the native file, and using it would make the path ambiguous and freeze it (§6.8). **This rule reports only; it performs no Drive action and does not compete with the export rules above.** Report it every run, in the "needs attention" group, naming the local file | — (report only) |
| **N11** | `D(P)` is Google-native but has **no export mime type** (forms, scripts, sites) | The native file cannot be backed up into `E:` — the type has no export. **Never upload over it, never trash it, never adopt it.** Report it every run in the "needs attention" group, naming the file and the reason. The path is otherwise left alone | — (report only) |

**N10 is a report, not a competing action.** It applies *in addition to* whichever export rule fires (N1–N5), and never changes what that rule does. This is why it does not violate the mutual-exclusivity invariant in §11.1.

**N11 covers one situation: a native type with no export.** The native file has no local representation to create, so there is nothing to export and nothing to adopt. The path is left alone and the file is reported.

**The two native guards on R6, R7 and R10.** When a Drive file at `P` is Google-native and a local binary occupies the same path, the outcome is the same as rule N10: **report the conflict and change nothing**. The native file is *not* exported on this path, because P4 has already claimed the path for Group R and the dispatch does not fall through to Group N. The native file may already have an export at its recorded `localPath` — that export is untouched. This is the one documented exception to "the native file is always backed up into `E:`" (§6.6).

#### Group B — the path has a live manifest entry (step P7)

| # | Condition | Action | Manifest write |
|---|---|---|---|
| **B0** | `D(P)` usable, `D(P).id == M(P).driveFileId`, `L(P)` is **`absent`** → **the user deleted the file locally** | **Archive the Drive bytes** (§7.3), then **trash the Drive file**. This is the **only trash action in the entire rule set**. **If `mergeOnly` is set (a rebase is in progress), this rule does not execute at all** — not the trash, and not the manifest write. Suppressing only the trash would write a `trashed` record for a file that is alive on Drive, which the next run would read as "the user restored it from Trash" and report falsely | **W-retire(id, "trashed", P)**; delete `files[P]` |
| **B1** | `D(P)` usable, `D(P).id == M(P).driveFileId`, `L(P)` is **`present`** | Compare (§6.5). **Local changed only** → upload in place, keeping the Drive id. **Drive changed only** → archive the local bytes, then download (Drive wins). **Both changed** → archive the Drive bytes, then upload in place (local wins). **Neither changed** → leave alone. Under `drive-wins`, the "local changed only" and "both changed" branches instead archive the **local** bytes and download the Drive version | **W-live(P)** with updated hashes and timestamps |
| **B2** | `D(P)` usable, `D(P).id != M(P).driveFileId` | The tracked file moved or was replaced. Probe `M(P).driveFileId` (§9.6). Outcomes: **404** → the tracked file is gone for good → retire it `gone`. **`trashed: true`** → someone else trashed it → retire it `trashed-externally`. **Alive, not trashed, at a different path** → it was renamed or moved on Drive → retire it `moved`. (Alive at the same path is impossible here: two live files under one path would have made the key ambiguous, and step P1 would have caught it.) The file now at `D(P)` is a **different** file and is treated as new-on-Drive: if `L(P)` is `absent` → **download** it, keep the Drive copy; if `L(P)` is `present` → **local wins**: archive the Drive bytes, replace Drive content in place keeping the new Drive id; under `drive-wins`, archive the **local** bytes and download the Drive version over it | **W-retire(old id, "gone" / "trashed-externally" / "moved", P)** with the old entry's `localPath` if that entry was a native file; **W-live(P)** with the new id |
| **B3** | `D(P)` absent, `L(P)` is **`present`** | Probe `M(P).driveFileId` (§9.6). **404** → the Drive copy is gone for good → **upload the local file as a new Drive file** (new id), report it. **Alive + `trashed: true`** → someone else trashed it on Drive → **leave Drive alone**, do **not** re-upload, retire the entry as `trashed-externally`, and report the local file loudly as an **unbacked-up file needing attention**. **Alive + not trashed, and its current path is still `P`** → it was merely missed by the listing → **re-adopt it** (write the live entry back, no transfer). **Alive + not trashed, current path differs** → it was renamed or moved on Drive → retire the entry as `moved`; the local file becomes an ordinary local-only file and is uploaded at this path (rule E1) | **W-retire(old id, "gone" / "trashed-externally" / "moved", P)**; delete `files[P]`; on the 404 branch **W-intent**, upload, then **W-live(P)** with the new id; on the re-adopt branch **W-live(P)** unchanged; on the moved branch **W-retire(old id, "moved", P)**, **W-intent**, upload, then **W-live(P)** with the new id |
| **B4** | `D(P)` absent, `L(P)` is **`absent`** | Both sides appear gone. Probe `M(P).driveFileId` (§9.6) before recording anything: **404** → the file is gone for good → retire it `gone`. **`trashed: true`** → the user moved it to Drive Trash, where it is **still restorable** → retire it `trashed-externally` and leave it alone; if the user later restores it, rule R1 applies and it is *not* re-downloaded. **Alive, not trashed, current path == `P`** → it was missed by the listing → re-adopt it, write the live entry back unchanged, no transfer. **Alive, not trashed, current path differs** → it was renamed or moved on Drive → retire it `moved` and delete the entry; the file is picked up at its new path as a first sight | **W-retire(id, "gone" / "trashed-externally" / "moved", P)**; delete `files[P]`; on the "alive, same path" outcome **W-live(P)** unchanged instead |

**Why B4 probes.** Drive's ordinary "delete" puts a file in Trash, where it stays for 30 days. Recording such a file as `gone` would claim it was permanently deleted, and a later restore would be reported as an impossible anomaly forever instead of being re-adopted. The probe distinguishes the two cases, and it distinguishes "moved on Drive" from "deleted".

#### Group C — a Drive file we have never tracked (step P8)

| # | Condition | Action | Manifest write |
|---|---|---|---|
| **C1** | `L(P)` is `absent` | **Download** into `E:`, **keep the Drive copy** — "new on Drive" | **W-live(P)** |
| **C2** | `L(P)` is `present`, Drive `md5` equals local `md5` | Identical content → **no transfer**; just adopt it. This is what keeps a first sync from needlessly re-uploading 1.93 GB | **W-live(P)** with the Drive id |
| **C3** | `L(P)` is `present`, content differs | **Local wins**: archive the Drive copy locally (§7.3), then replace Drive content **in place, keeping the Drive file id**. Under `drive-wins`: archive the **local** copy, then download the Drive version over it | **W-live(P)** with the Drive id |

#### Group D — a retired record at this path, Drive file absent (step P9)

Let `rec = Rt(P)[0]` — the most recently retired record at this path.

| # | `rec.state` | `L(P)` | Action | Manifest write |
|---|---|---|---|---|
| **D1** | `trashed` | `present` | **The user re-created the file locally after deleting it.** Probe `rec.id` (§9.6). **Trashed (not-404)** → un-trash it (`trashed=false`, keeping the same Drive file id) and replace its content with the local file, archiving the old Drive bytes first. **404 (Google purged it)** → upload a new Drive file instead. **Alive, not trashed, same path** → it was restored without moving: archive the Drive bytes and replace its content with the local file, keeping the id. **Alive, not trashed, different path** → it was restored *and* moved: retire it as `moved` and upload the local file as a new Drive file. Either way the file is backed up again, and the Drive id is preserved when possible. **During a rebase (`mergeOnly`) this rule does not execute** — un-trashing is destructive, and a rebase must not perform destructive actions; the path is reported as deferred | **W-live(P)** with the (possibly new) Drive id; **W-retire(rec.id, "resynced", P)** when restored, or **W-retire(rec.id, "purged" / "moved", P)** otherwise; **W-intent** before any new upload, and a separate **un-trash intent** before the un-trash (§5.5) |
| **D2** | `trashed-externally` | `present` | Someone else trashed this Drive file and the app did not. **Do not re-upload it** — that would undo their deliberate removal, and the app must never undo a removal it did not perform. Report the local file as **unbacked-up, needing attention**, every run until the user acts. Nothing else | — |
| **D3** | `gone`, `purged`, `moved`, `restored` | `present` | The old Drive file is gone for good. The local file is simply new → **upload it** (rule E1) | **W-intent**, upload, then **W-live(P)** with the new Drive id |
| **D4** | `rebased` | `present` | The Drive file is gone and the volume changed. The local file is whatever is on the new disk → **upload it** (rule E1) | **W-intent**, upload, then **W-live(P)** with the new Drive id |
| **D5** | any | `absent` | Nothing to do. The retired records stay, forever | — |

#### Group E — a local file we have never tracked, Drive file absent (step P10)

| # | Condition | Action | Manifest write |
|---|---|---|---|
| **E1** | `L(P)` is `present` | **Upload** — a new Drive file. This is the rule that carries every local-only file to Drive | **W-intent**, upload, then **W-live(P)** with the new Drive id |

There is no second rule in this group: step P10 is only reached when `D(P)` is absent and `Rt(P)` is empty. If `L(P)` is `absent` as well, the path has nothing on either side and is not iterated (§6.1) — there is no rule to write.

#### The conflict principle and the `drive-wins` inversion table

**One principle, applied everywhere:** when the same path holds different content on both sides, **`E:` wins** and the Drive-side bytes are archived locally first.

**Two exceptions**, both of which are deliberate and both of which favour the Drive copy:

1. **`mergePolicy: "drive-wins"`**, which applies during a rebase only. It inverts exactly these branches:

| Rule and branch | `local-wins` (normal) | `drive-wins` (rebase) |
|---|---|---|
| **B1** — local changed only | archive Drive bytes; upload local over Drive | archive **local** bytes; download Drive over local |
| **B1** — both changed | archive Drive bytes; upload local over Drive | archive **local** bytes; download Drive over local |
| **B2** — Drive file present, id differs, local present | archive Drive bytes; upload local over Drive | archive **local** bytes; download Drive over local |
| **C3** — both present, differ | archive Drive bytes; upload local over Drive | archive **local** bytes; download Drive over local |
| **R6** — known file at a new path, local present | archive Drive bytes; upload local over Drive | archive **local** bytes; download Drive over local |
| **R7** — restored file at this path, local present | archive Drive bytes; upload local over Drive | archive **local** bytes; download Drive over local |
| **R10** — rebased, local present, different content | archive Drive bytes; upload local over Drive | archive **local** bytes; download Drive over local |

2. **Rule R3** — a file the user explicitly restored from Drive Trash, where a local file occupies the same path. The Drive copy wins because the user restored it; nothing is overwritten either way.

**D1 is not inverted.** A trashed Drive file cannot be downloaded — Drive's media endpoint does not serve trashed files, and the only way to obtain it would be to un-trash it, which would resurrect a file the user deleted. During a rebase, D1 does not execute at all (see §8).

### 6.4 Rule reachability

Every rule in the tables above is reachable. These notes exist so that no implementer "fixes" a rule into a state it was never meant to have:

- **B0** requires `L(P)` to be `absent`, and it is additionally gated on `mergeOnly` being clear.
- **B4** and **D5** require `absent`.
- **N6–N9** are reached from step P6, which dispatches on the **manifest entry's** mimeType, not on the Drive tree's. A deleted native file is handled there, not by B3/B4.
- **C1** requires `L(P)` to be `absent` — the "download a new Drive file" case.
- **E1** requires `L(P)` to be `present` and `D(P)` absent — the "upload a new local file" case. It is reached through step P10, because step P9 (the retired-path group) consumes every path that has a retired record. Because a retired record's path is **historical** (§5.4), a path that once held a retired Drive file is routed to Group D, not Group E.
- **D5** is reachable only because the iteration set includes retired paths (§6.1). Without that, a path with nothing on either side would never be visited.
- **`resynced`** is consumed by **no** rule, by design. Step P4 excludes it so that the path falls through to the ordinary rules, and it never reaches step P9 because the rule that would remove its live entry transitions the same record to a different state. Every state other than `resynced` is consumed by at least one rule.

### 6.5 Change detection

For binary files `md5` is authoritative on both sides (Drive returns `md5Checksum` for non-native files).

Local files use a two-step check to avoid hashing 1.93 GB every run:

1. If `(size, mtimeMs)` match the manifest's recorded local values → assume unchanged, skip hashing.
2. Otherwise compute MD5. If it equals the manifest's `driveMd5` → content is actually unchanged (only the timestamp moved) → update `localMtimeMs`, take no action.
3. Otherwise → content changed.

**When Drive omits `md5Checksum`** (some binary types, and zero-byte files), content is *unknown* rather than *different*. In that case the app compares `size` and `modifiedTime`; if those also fail to decide, it re-uploads **without archiving** (there is no older version to preserve) and says so in the log. It does **not** treat "no checksum" as "content differs" and does not archive on every run.

Google-native files have no `md5Checksum` and their exports are not byte-stable, so they are compared by **`driveModifiedTime`** (rules N2, N3).

### 6.6 Google-native files

Native types cannot be downloaded with `alt=media`; they must be exported.

| Drive mimeType | Export mimeType | Local extension |
|---|---|---|
| `application/vnd.google-apps.document` | `application/pdf` | `.pdf` |
| `application/vnd.google-apps.spreadsheet` | `text/csv` | `.csv` |
| `application/vnd.google-apps.presentation` | `application/pdf` | `.pdf` |
| `application/vnd.google-apps.drawing` | `image/png` | `.png` |

Other native types (forms, scripts, sites) have **no defined export**. Rule N11 reports them and leaves them completely alone: never uploaded over, never trashed, never adopted.

**A native Drive file is never uploaded over and never trashed.** It is a live object on Drive with its own history, and its local counterpart is a *derived artifact*. Two consequences:

- **The export path is planned** (§6.2, Pass A): `drivePath + extension` when that path is free, otherwise `drivePath (export N).ext`. The chosen path is recorded as the entry's `localPath`. The manifest key remains the Drive path.
- **Deleting the local export does not delete the Google Doc.** The export is simply regenerated (rule N3). Trashing a user's Google Doc because they deleted a derived `.csv` would destroy someone else's work — the exact class of mistake this app exists to avoid.

**Resolving a native file whose natural export path is occupied.** The user's own unrelated file at `P + ext` must not be swallowed, and must not be overwritten. The planner avoids every path occupied by another Drive file, another manifest entry, another planned export, a retired native file's export path, **or a local file present on disk**, so the export lands on `P (export N).ext` and the user's file stays an ordinary local file that rule E1 uploads normally.

**"Always backed up into `E:`" has one documented exception:** a Google-native type with **no export mime** (forms, scripts, sites) — rule N11. There is nothing to export, so there is nothing to back up, and the file is reported every run.

A local binary occupying a native file's exact path is **not** an exception to that promise: the native file is still exported to its planned path (rule N10), because the planner treats a local file present on disk as a collision and routes the export elsewhere. What stays untracked is the *local binary*, which cannot be uploaded without making the Drive key ambiguous.

### 6.7 Drive entries that cannot be represented on Windows

A Drive file whose name contains any of `: * ? " < > |`, or ends in a dot/space, or is a reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), cannot exist on `E:`.

Such entries are flagged **`unrepresentable`**. They are never downloaded (no legal local path), **never trashed** — they cannot have been synced, so a local deletion cannot explain their absence, and trashing them would delete user data on the strength of a rule that does not apply — never adopted into the manifest, and reported on every run.

**Collision handling.** Two Drive files can collide under one canonical key:

- **Case collision** — Drive permits `A.psd` and `a.psd` in one folder; Windows does not.
- **Exact duplicate** — Drive permits two files with the identical name in one folder.

In both cases the key holds two entries, so the key is **ambiguous**: step P1 skips it entirely — no download, no upload, no trash, and the live manifest entry at that key is left untouched (not orphaned, not deleted) — and it is reported with both file names and ids so the user can resolve it in the Drive UI. Picking a winner arbitrarily risks trashing the wrong file, and the user has explicitly said these trees are full of same-named files.

### 6.8 Rename detection — deliberately excluded

Because the diff is path-keyed, a rename is seen as a delete plus an add:

- **Local rename** (`a.psd` → `b.psd`): rule B0 trashes the old Drive file, rule E1 uploads a new one for `b.psd`. The Drive file id, revision history and share links are lost. The old file is **not** re-downloaded: on every later run `a.psd` has no live entry and no usable Drive entry, so the path is not iterated (§6.1) and nothing happens.
- **Drive rename** (`a.psd` → `b.psd` on Drive): rule B2 retires the old entry as `moved`; the file at `b.psd` is new-on-Drive and is downloaded into `E:` (rule C1); the local `a.psd` has no Drive counterpart and is uploaded (rule E1). The content ends up at both paths on both sides — duplication, but no loss and no silent hole.

Detecting renames by content hash would be more elegant but is unsafe here: the user states these trees contain many files with identical names, which strongly implies many files with identical *content* as well. Pairing a deleted file with an added file by MD5 would then produce arbitrary pairings, and an arbitrary pairing trashes — or renames — the wrong Drive file.

**Decision: rename detection is out of scope for v1.** Both directions are treated as delete + add, and the summary states this plainly for every affected path.

**Known consequence of a restore into a reused path.** If a path is taken over by a new file (rule C3 or B2) while a `trashed` record for the old id still exists at that path, and the user later restores the old file from Trash, Drive will hold two files at that path. The key becomes ambiguous, step P1 skips it, and the app reports it for manual resolution. This is safe — nothing is trashed, nothing is silently re-downloaded — but it needs manual cleanup.

**Known consequence of a native file sharing a path with a local binary** (rule N10): the local binary is never uploaded, because the only Drive path it could occupy belongs to the Google-native file. It is reported every run so the user can rename it locally.

---

## 7. Sync execution

### 7.1 Ordering — the safety-critical part

Within one mirror, actions run in this order:

1. **Create** missing Drive folders (parents before children).
2. **Uploads** (creates and in-place content replacements). Rule D1's un-trash and content replacement happen here, because un-trashing a file whose content replacement then fails would leave the old content live — the safer failure.
3. **Downloads.**
4. **Trashes on Drive — last.**

Trashing runs last on purpose. If the app crashes halfway through, a file that was about to be trashed is still on Drive, rather than the Drive copy being removed while the local side has not yet been confirmed. A file is trashed only after the run has confirmed that its local counterpart is genuinely gone.

Within each phase, actions are ordered by path for deterministic, reproducible logs.

### 7.2 Error isolation, and fail-closed archiving

A failure on one file never aborts the mirror. The error is recorded, the file is skipped, the run continues, and the mirror finishes with a non-zero error count. The final summary distinguishes *files changed* from *errors*.

**Archiving is fail-closed.** If the archive write fails — a full `C:` drive, the 292 MB file in `videoEditing`, a permissions problem — the destructive action for that file is **skipped, not continued**. The Drive copy is **not** trashed and **not** overwritten. The file is reported as *"archived copy could not be written; the Drive file was left untouched."*

This is the one place where "record the error and continue" is explicitly wrong: continuing would destroy the only copy of the file, which is precisely what the archive exists to prevent.

### 7.3 Archiving superseded copies

Before overwriting a file on either side, the bytes being replaced are archived to:

```
%LOCALAPPDATA%\DriveMirror\superseded\<MirrorName>\<sanitized relPath>\<timestamp>-<md5prefix><ext>
```

so the replaced version is never lost. This is used for:

- archiving **Drive** bytes before an upload replaces them (rules B1, B2, C3, R6, R7, R10 under `local-wins`, and D1);
- archiving **local** bytes before a download replaces them (rule B1 drive-changed, and every `drive-wins` branch);
- archiving a **local export** the user edited before a re-export overwrites it (rule N2).

**B0 always archives** the Drive bytes before trashing, not only when the Drive content "changed since the last sync". The manifest records the Drive hash as of the last sync, so "changed since the last sync" is false by construction whenever the Drive edit was itself synced — and that is exactly the case where the user would want the edited version kept. Archiving unconditionally is the honest implementation of the promise in §12.

**Every path segment is sanitized** — characters illegal on Windows are replaced with `_`, and the leaf name carries a timestamp and a content-hash prefix so that **two archives of the same path never overwrite each other**. A sidecar `.meta.json` records the original path and side.

The superseded store is the app's only "second copy" mechanism and is never pruned automatically; the Settings dialog exposes "Reveal superseded copies" and a prune action with a clear size report.

---

## 8. Safety guards

All guards run **before any mutating operation**. If a guard trips, the affected mirror is skipped entirely and the user is told.

### Guard 1 — Local root missing

If `E:\Medicine` (or any mirror root) does not exist, that mirror is skipped and reported. The app does **not** interpret an absent root as "empty", because "empty" would mean "trash everything on Drive". This is the unmounted-drive case.

### Guard 2 — Volume fingerprint changed

On Windows, `fs.statSync(root).dev` **is the volume serial number** — verified on this machine: `E:` → `404660920`, which matches `Win32_Volume.SerialNumber` exactly, and `C:` → `101100647`. The serial is recorded in the manifest on first run and re-checked every run. The serial of each mirror root is also compared to the serial of `E:`.

If `E:` now points at a **different volume** — a reassigned drive letter, a swapped disk, a USB stick — the affected mirrors are **blocked**, not merely reported:

- The run does **not** proceed with the existing manifest. Treating every manifest path as "deleted locally" would trash the entire Drive mirror — precisely the catastrophe this guard exists to prevent.
- **The serial is volume-scoped, so the guard and the remedy are volume-scoped too.** All mirrors rooted on the changed volume are blocked together, and one action re-approves them together. A per-mirror remedy would be unsound: updating the single global serial while three mirrors still hold stale manifests would let those three proceed and trash themselves.
- The UI shows a banner explaining that `E:` is a different volume than the one last synced, and offers **"Re-approve `E:` as the source volume"**.

**Re-approving, for every mirror on that volume, in one atomic checkpoint:**

1. Each live entry in `files` is converted into a **retired record with state `rebased`**, carrying the id, the path, the entry's `localPath` if the entry was a native file, and the **old content hashes** (`prevLocalMd5` and `md5`, both copied from the live entry's `localMd5` / `driveMd5`). The old hashes are what let the app tell "the same file came back" from "a different file took its place" after the volume change.
2. `files`, `dirs` and `lastCounts` are cleared.
3. Existing `retired` records are **kept** — including `trashed` records, which still carry the proof that the user deleted those files locally. **The `rebased` record replaces any existing retired record for the same id**, so a `resynced` record left over from an earlier restore cannot survive the rebase: a surviving `resynced` record would cause step P4 to skip the path and the file would fall through to rule C1, which **downloads it — undoing the user's unsynced deletion**. Records for ids with no live entry are kept untouched.
4. `rebase = { pending: true, mergePolicy: "drive-wins" }` is set.
5. The new volume serial is written **in the same atomic checkpoint**, after all mirrors on the volume have been converted. A crash therefore leaves either the old serial with the old manifests (the guard still blocks) or the new serial with all mirrors converted (safe), never a mixed state.

**Converting `files` into `rebased` records is what stops the rebase from resurrecting unsynced deletions.** If the app merely cleared `files`, the record that "the local file at `P` had been deleted" would vanish with it — but the Drive file at `P` is still live, because the deletion was never synced. The next run would see a Drive file with no manifest entry and no local file, and rule C1 would download it, putting the deleted file back on `E:`. The `rebased` record prevents that, via rules R8–R10 and D4.

**Merge-only mode.** While `rebase.pending` is set, the mirror runs in merge-only mode:

- **Rule B0 does not execute** — not just its trash call, but its **manifest write** as well.
- **Rule D1 does not execute** — it would un-trash a file and rewrite its content, which is destructive. The affected path is reported as *"deferred — the Drive copy is in Trash"* and is handled normally once the rebase completes.
- The `drive-wins` branches of B1, B2, C3, R6, R7 and R10 apply, per the inversion table in §6.3.
- Local-only files are uploaded (additive — nothing is destroyed).
- `retired` is consulted throughout, so a file the user deleted locally is still never re-downloaded.

**Invariant: a rebase run performs zero trashes.** The trash action exists in exactly one place — rule B0 — and B0 is gated on `mergeOnly` being clear. A test runs a full rebase against the fake Drive and counts trash calls: the count must be zero. The invariant is not vacuous, because B0 is the only trash rule and it is gated; it is also structurally redundant, because a rebase clears `files` and B0 requires a live entry — the gate is what makes it hold in the **interrupted-rebase** case, where a partially repopulated `files` map would otherwise make B0 reachable.

**After a rebase run completes**, every path it resolved was either adopted (rule R9) or reconciled (rule R10), and both rules **release the `rebased` record** into `resynced`. From that moment the path behaves like any other tracked file: rules B0 and B1 apply, so a later local deletion is trashed and a later Drive edit is downloaded. Only paths that stayed absent (rule R8) keep their `rebased` record, which is correct — it is the anti-resurrection proof for a file the user had deleted before the volume change.

The `rebase.pending` flag and `mergePolicy` persist until a rebase run completes for that mirror. An interrupted rebase leaves the flag set, so the next run is still merge-only and still safe. After a rebase run completes, `rebase` is cleared and `mergePolicy` returns to `local-wins`.

### Guard 3 — File-count drop (more than half)

The manifest stores, per directory, the **recursive** file count observed at the end of the last successful sync of that mirror. At the start of the next run the current counts are compared:

- **Trip condition:** `(last >= threshold AND current < last * 0.5)` **or** `(last >= 1 AND current == 0)`. `last = 10, current = 5` does **not** trip by the ratio test, but a complete wipe always trips.
- The comparison set is the **union** of the directories in `lastCounts` and the directories currently on disk. A directory that has been deleted outright is compared with a current count of **0** and therefore trips. Iterating only the directories that still exist would make a wholly-deleted subtree invisible — exactly the catastrophe being guarded against.
- A directory with no previous count (new directory) never trips.
- A mirror with no previous sync never trips (nothing to compare against).

**Scope:** the check runs for **every** directory in the tree, not just the four roots. If *any* directory trips, the **entire mirror** is skipped — not just that subtree. Trashing the tree one level at a time is how a partial unmount or a botched `robocopy /MIR` becomes a mass deletion.

**Avoiding nuisance trips.** A literal "more than half" rule fires on ordinary small-scale editing: a 3-file directory dropping to 1 file trips the guard and blocks the whole mirror, and a user who then reflexively clicks "Sync anyway" has defeated the guard. So the ratio test applies only when `last >= threshold` files (`threshold` default 5, a setting); below that, only a complete wipe trips.

**Baseline update semantics.** When a mirror runs to completion — **including a run made via the "Sync anyway" override** — its `lastCounts` is **merged**: the count of every directory currently on disk is written, and directories absent from disk are set to `0`. This is what stops a legitimately deleted small directory from tripping forever.

**When a mirror is skipped, its baseline is not updated at all.** Otherwise the guard would defeat itself: run *N* deletes a subtree, run *N+1* trips and skips but rewrites the counts to the post-deletion values, and run *N+2* sees `0` vs `0`, proceeds, and trashes the subtree. The guard must protect more than once.

**The override is permanent for the affected directories.** After an override run, the tripped directories are recorded at their new (post-deletion) counts, so the guard does **not** protect them again. This is deliberate: the user has explicitly accepted that deletion, and re-protecting it would make the override useless. The summary states which directories were accepted and what was trashed because of them.

A tripped guard is not a dead end: the UI shows a banner naming **every** tripped directory with its before/after counts, and a **"Sync anyway"** button that re-runs that mirror with the guard overridden for this run only. The override is recorded in the log and in the run summary.

### Guard 4 — Bounded blast radius

The app only ever operates on Drive folder IDs it resolved for the four named mirrors. The resolver refuses to proceed if a mirror name matches more than one Drive folder (Drive permits duplicate sibling names) — it reports the ambiguity instead of guessing. No code path issues a Drive write against a folder outside the four resolved roots, and no code path calls a permanent-delete endpoint.

---

## 9. Google Drive specifics

### 9.1 Authentication

`google-auth-library`'s `OAuth2Client` with the **Desktop app** client type:

- Auth URL: `https://accounts.google.com/o/oauth2/v2/auth`
- Scope: `https://www.googleapis.com/auth/drive`
- `access_type=offline`, `prompt=consent` → yields a refresh token
- Redirect: `http://127.0.0.1:<ephemeral-port>` served by a tiny loopback HTTP server in the main process; the system browser is opened with `shell.openExternal`. The server is shut down immediately after the callback.

Refresh token persistence: encrypted with Electron's `safeStorage` (DPAPI on Windows) and written to `%LOCALAPPDATA%\DriveMirror\credentials.bin`. The client id/secret from the Settings screen are stored the same way. Nothing sensitive is written to the repo, and no secret is required at build time.

Refreshed access tokens are held in memory only; a `401` triggers one refresh-and-retry.

### 9.2 Downloading

`GET /drive/v3/files/{fileId}?alt=media` streams to a temporary file, which is then renamed into place, so a partial download never appears as a complete file. The local file's mtime is set to the Drive `modifiedTime`.

For Google-native files, `GET /drive/v3/files/{fileId}/export?mimeType=...` is used instead — **`alt=media` on a Google-native file fails**, so every rule that "downloads" a native file must export it. This applies to rules R5, R10, C1 and the `drive-wins` branches of B1, B2, R6 and R7.

### 9.3 Listing — the trashed-file filter and pagination

> **This is the single most important detail in the design.**
>
> The Drive API's `files.list` **returns trashed files by default**. The official reference states it plainly: *"This method returns all files by default, including trashed files. If you don't want trashed files to appear in the list, use the `trashed=false` query parameter to remove trashed files from the results."*
>
> Without an explicit `trashed=false`, every file the app has ever trashed reappears in the Drive tree. It would then look like "present on Drive, absent locally", which is the shape that triggers a trash or a download — so the app would either re-trash files the user restored, or re-download every file the user ever deleted. The manifest's `retired` map would not save it, because step P4 depends on the trashed file being **absent** from the tree in the first place.

Every listing query therefore carries `trashed = false`, and the Drive-tree builder **excludes** any returned item whose `trashed` field is `true`. The query filter is the primary defence; the field is a secondary check. A **missing** `trashed` field is not evidence of trashed — the query already filtered — so such an item is included.

**The batched query must be parenthesised.** Drive query clauses evaluate left-to-right unless grouped, so an unparenthesised form parses as `('a' in parents) OR ('b' in parents AND trashed = false)` — the filter would apply to only the last clause, and trashed files would leak in through the others. The safe form is:

```
q = "trashed = false and ('id1' in parents or 'id2' in parents)"
```

**Pagination is mandatory.** `files.list` returns at most `pageSize` items (default 100) and a `nextPageToken`. Every listing follows `nextPageToken` to exhaustion. `videoEditing` holds 113 files, and a single Drive folder can easily hold more. Without pagination the tail of a folder is invisible to the Drive tree, and every missing file with a live manifest entry would be misread as "deleted from Drive" — producing duplicate uploads, or a false "restored from Trash" report. The app requests `pageSize=1000` and loops until `nextPageToken` is absent.

Mirror contents are enumerated by **breadth-first search from the mirror's Drive folder id**, one API call per level, with the folder ids of that level batched into a single parenthesised `files.list` query. This touches only the mirror's subtree — never the whole Drive — and keeps the request count proportional to tree depth rather than file count.

Fields requested are minimal: `id, name, mimeType, size, md5Checksum, modifiedTime, trashed, parents`. Folders are separated into `driveDirs` on arrival (§5.3).

### 9.4 Resolving the mirror folders

Each mirror's Drive folder is resolved as follows:

1. If the manifest has a stored `driveFolderId`, probe it with `files.get` (including `trashed`). If it is alive and not trashed → **use it**. This is the normal path and avoids re-resolving by name on every run.
2. Otherwise, resolve by name under My Drive's root:

```
q = "name = '<escaped>' and mimeType = 'application/vnd.google-apps.folder'
     and 'root' in parents and trashed = false"
```

3. **Zero matches** → the folder is missing. If the manifest already had a stored id (the folder existed before and has since been deleted), the app **creates** it and records the new id. On a **first** run with no stored id, a missing folder is created only when the local root actually contains files — the user's rule: *"If a Drive folder is missing but the local one has files, recreate it instead of failing."* The same applies to subfolders: a missing Drive folder is recreated before any upload into it.
4. **More than one match** → **ambiguous** → the mirror is skipped and reported (Guard 4). Drive permits duplicate sibling names, so guessing would be unsafe.
5. The `mimeType` filter excludes `application/vnd.google-apps.shortcut`, which is how shared-drive and "shared with me" items appear — both are non-goals.

### 9.5 Uploading

Files are uploaded with `POST /drive/v3/files`. In-place content replacement uses `PATCH /drive/v3/files/{fileId}`, keeping the same file id.

Files above ~5 MB use a resumable session:

1. `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable` with the file metadata as JSON → read the `Location` header as the session URI.
2. `PUT` the body in 8 MB chunks with `Content-Range: bytes a-b/total`.
3. The final response normally contains the file JSON including `id`.

**The known failure mode:** on the final chunk the API can return a response whose body is empty or whose parsed status is `null`. Treating that as a failure would either abort the run or, worse, retry the upload and create a duplicate file.

**Handling, in order:**

1. Parse the final response. If it yields an `id`, use it.
2. If the body is empty or `status` is null, **do not** retry the upload. Instead verify by querying the parent folder for the file with that name:
   `q = "name = '<escaped>' and '<parentId>' in parents and trashed = false"`.
   Names are escaped per Drive's query syntax (a literal `'` becomes `\'`, a literal `\` becomes `\\`).
3. Among the candidates, select the one whose **`md5Checksum` equals the MD5 of the bytes we just uploaded** (and whose `size` matches). Matching on name alone is not enough: Drive permits duplicate names within a folder, and adopting the wrong id would put an unrelated file into the manifest — which a later trash decision would then delete.
4. If no candidate matches the content hash, retry the lookup for up to ~5 s, since a newly created file may not be immediately queryable.
5. If it still cannot be found, record a per-file error and continue with the rest of the run. **The run must not crash.**

### 9.6 Probing a known file id

Rules B2, B3, B4, N5, N6, N7, N8, N9 and D1 need to know what happened to a Drive file the app used to track. A direct `files.get` on the recorded id — **not a listing** — answers this, and its result never enters the Drive tree.

The probe returns **the file's current full path within the mirror**, computed from its `parents` (resolved to folder paths via `driveDirs`) and its current `name`:

```
currentPath = canon(parentFolderPath) + "/" + canon(name)
```

This is compared against the manifest path `P`, which is the path the file occupied at the last sync. **The comparison is file-path against file-path** — not a parent folder path against a file path. (Comparing the parent folder path with `P` would always report "different", which would retire every probed file as `moved` and re-upload it, producing duplicates at scale.)

**Resolving the parent folder.** `parents` gives folder ids. `driveDirs` maps a canonical folder path to its id, so the probe needs the **reverse** index (`folderId → canonical path`), built once per run from `driveDirs`. A file may have more than one parent (shared into another folder); the probe uses the **first parent that resolves to a path inside this mirror**. If no parent resolves inside the mirror, the file is not ours.

**When the parent cannot be resolved** — the folder was deleted, or the file was moved outside the mirror — `currentPath` is **undefined**, and the outcome is defined: the file is treated as **"different path"**, i.e. the "alive, not trashed, different path" row below. It is never treated as "same path". This is the conservative direction: the file is retired as `moved`, which leaves the local file in place and lets the ordinary rules re-upload it if needed. The alternative — treating an unresolvable parent as "same path" — would re-adopt a file that no longer lives at that path.

| Result | Meaning | What the callers do |
|---|---|---|
| 404 | The file is gone for good | **B2**: retire the old id `gone`; the new Drive file at the path is downloaded. **B3** / **D1**: the local file is uploaded as a new Drive file. **B4**: retire `gone`. **N5** / **N6**: retire `gone` |
| `trashed: true` | Someone trashed it on Drive | **B2**: retire the old id `trashed-externally`. **B3** / **N7**: leave it alone, report the local file as unbacked-up. **B4**: retire `trashed-externally` — the file is still in Drive Trash and restorable. **N5**: retire `trashed-externally`. **D1**: the file is still there, in Trash — it can be un-trashed |
| alive, `trashed: false`, **`currentPath == P`** | The file was merely missed by the listing (a pagination or timing gap) | **B3** / **N8**: re-adopt it; no transfer. **B4**: re-adopt it; no transfer. **D1**: archive the Drive bytes and replace its content with the local file |
| alive, `trashed: false`, **`currentPath != P`** or undefined | It was renamed, moved on Drive, or moved outside the mirror | **B2** / **B3** / **B4** / **N5**: retire the old id `moved`. **N9**: retire `moved`, delete the entry; the file is picked up at its new path as a first sight. **D1**: retire `moved` and upload the local file as new |

**A probe never enters the Drive tree.** It classifies a known id; it never adds a file to `driveFiles`.

### 9.7 Trashing and restoring

`PATCH /drive/v3/files/{fileId}` with `{"trashed": true}` — Drive's own Trash, recoverable for 30 days. The app never calls a permanent-delete endpoint and never clears Drive Trash.

Restoring uses `PATCH /drive/v3/files/{fileId}` with `{"trashed": false}` (rule D1).

### 9.8 Rate limits and retries

- `401` → refresh the access token and retry once.
- `403` with `rateLimitExceeded` / `userRateLimitExceeded` → honour `Retry-After`, else exponential backoff with jitter, capped.
- `5xx` and network errors → up to 3 retries with backoff.
- File operations within a phase run with a concurrency of 4, to stay under the per-100-second request budget without tripping it.

---

## 10. The UI

Single window, 1180×760, native Windows chrome (standard Electron title bar, standard menu with File / Settings / Help), light and dark themes following the OS setting.

### Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  Drive Mirror                          Signed in as me@gmail.com  ⚙︎    │
│                                                 [ ▶  Sync now ]         │
├────────────────────────────────────────────────────────────────────────┤
│  ┌─ Medicine ─────────┐  ┌─ graphicDesign ───┐  ┌─ videoEditing ────┐  │
│  │ E:\Medicine        │  │ E:\graphicDesign  │  │ E:\videoEditing   │  │
│  │ → My Drive/Medicine│  │ → My Drive/…      │  │ → My Drive/…      │  │
│  │ 43 files           │  │ 43 files          │  │ 113 files         │  │
│  │ Synced 2 h ago    │  │ Synced 2 h ago    │  │ Synced 2 h ago    │  │
│  │ ↑2 ↓0 ✕0 ⚠0        │  │                   │  │                   │  │
│  └────────────────────┘  └───────────────────┘  └───────────────────┘  │
│  ┌─ whoami ───────────┐                                                │
│  └────────────────────┘                                                │
├────────────────────────────────────────────────────────────────────────┤
│  ▓▓▓▓▓▓▓░░░░  62%   Uploading renders/final/scene_01.psd  (18/29)      │
├────────────────────────────────────────────────────────────────────────┤
│  Last run 20:14  ·  Uploaded 3  Updated 1  Downloaded 0  Trashed 2  ⨯0  │
│  ▸ details                                                             │
└────────────────────────────────────────────────────────────────────────┘
```

### Behaviour

- **Folder cards** show: name, local path, Drive path, live file count, last-synced timestamp (relative, "2 h ago", absolute on hover), and the last run's per-folder counts (uploaded / updated / downloaded / trashed / errors). Status chip: `Up to date`, `Syncing`, `Skipped`, `Needs attention`, `Error`. Each card also has its own **Sync** button that syncs **that mirror only**; the header **Sync now** button syncs all four mirrors in sequence.
- **Sync now** is disabled while a run is in progress; the button shows a spinner and the current phase.
- **Progress**: an overall progress bar plus a live line for the file currently being worked on and a running total.
- **Summary** appears when the run finishes: a single bar with the five counts and an expandable list of what changed, grouped by mirror, each entry naming the relative path and the action.
- **When nothing changed**, the summary reads *"Everything is up to date — no changes."* in muted text. No modal, no toast, no sound, no scroll-jump. Quiet is the default state, not an event.
- **Guard banner**: if a mirror is skipped by a guard, a dismissible amber banner appears above the cards with the reason and, for the count-drop guard, a **"Sync anyway"** button listing every tripped directory. For Guard 2 the banner instead offers **"Re-approve `E:`"**.
- **Restored-from-Trash entries** appear in the summary as actionable rows with a **"Download to `E:`"** button (rule R1). The button is **not shown** when a local file already occupies that path, because downloading would overwrite it.
- **Unreadable local paths** appear in a dedicated amber group, emitted by the scanner: *"could not read … — N files left untouched on Drive."*
- **Needs-attention entries** — unbacked-up files (rules B3, D2, N7), restored-file conflicts (R3), native path conflicts (N10, N11) and anomalies (R4) — appear in a dedicated red group in the summary, each naming the path and what to do about it.
- **Error surfacing**: failures appear as a distinct red count in the summary and in the expandable details, with the error message per file. The UI never presents a failed run as a clean one.

### Settings dialog

- Google OAuth client id + client secret (masked, with a "Test connection" button).
- Manifest location, superseded-archive location, backup location (shown; the latter two editable).
- **Minimum files before the guard applies** (default 5, §8 Guard 3).
- Per-mirror "Sync anyway" override (this run only).
- **"Reset manifest"** — performs exactly the same operation as Guard 2's rebase (§8): for every mirror, convert `files` into `rebased` retired records, clear `files` / `dirs` / `lastCounts`, **keep** the existing `retired` records, and set `rebase = { pending: true, mergePolicy: "drive-wins" }`. The confirmation dialog spells this out, and specifically warns that the existing `retired` records are kept so that locally-deleted files are **not** re-downloaded.
- "Open log folder", "Show manifest", "Reveal superseded copies", "Prune superseded copies" (with a size report).
- Connection status and the last successful auth time.

---

## 11. Testing

Vitest, no Electron, no network. Tests use real temporary directories on the local filesystem and an in-memory `DriveClient` fake that counts every Drive mutation by type.

| Suite | Covers |
|---|---|
| `paths.test.ts` | canonical keys: NFC normalization, case-insensitive matching, separator handling, duplicate-filename-in-different-dirs behaviour |
| `diff.test.ts` | **every rule in the §6.3 table** and every dispatch step P1–P10: the **B0 trash** rule; **E1 upload** (a local-only file must reach Drive); local re-create after a local delete (D1) **and the run after it** (the `resynced` path must keep syncing); restore-from-Trash then a further run (R1 → R2, **no download**); a restored file **moved to another Drive folder** (the global id check at P4); a Drive file whose id differs from the manifest's (B2); **B4's four probe outcomes** (a Drive file the user moved to Trash must not be recorded as permanently gone; a file moved on Drive must not be re-adopted at the old path); a Drive-side rename; both-modified conflict; native-file handling including the occupied-export-path case, the **N5 id-mismatch** case and the **N11 no-export case**; **the claim index blocks an upload of an exported `.csv`**; **a stale export of a retired native file is never uploaded** |
| `exhaustiveness.test.ts` | a generated matrix over every combination of the input dimensions below, asserting **semantic invariants** rather than rule counts (§11.1) |
| `localScan.test.ts` | an unreadable subtree produces `unknown`, not `absent`; **B0 does not fire for an `unknown` path**; a path under an unreadable directory is `unknown` even though it is absent from the tree; a junction occupying a synced file's path blocks the trash; the scanner emits the "could not read" report |
| `guards.test.ts` | count-drop thresholds (exactly half does not trip; the `last >= threshold` rule; a **deleted subtree** trips because the comparison set is a union; a subdirectory trip skips the whole mirror); missing root; volume-serial change → **volume-wide** rebase; ambiguous Drive folder name; **a skipped mirror's baseline is not updated**; **an override run merges the baseline** |
| `rebase.test.ts` | a rebase run performs **zero trash calls**; **an unsynced local deletion is not re-downloaded** (the `rebased` record, rule R8); a rebase run with a local-vs-Drive conflict keeps the **Drive** version and archives the local copy (R10); **R9/R10 release the `rebased` record**, so the run *after* the rebase uses rules B0/B1 and a local deletion is trashed; **R7 under drive-wins does not upload local content over the Drive copy**; **B0 does not execute at all** during a rebase (no false `trashed` record); **D1 does not execute** during a rebase; an interrupted rebase (crash mid-run) still has `rebase.pending` set and the next run is still merge-only; the new serial is not written before all mirrors are converted |
| `manifest.test.ts` | atomic write; journal replay after a simulated crash; **fsync of the journal append**; **write-ahead intent** for every create-upload branch **and for D1's un-trash**, and their resolution after a simulated crash; checkpoint cadence; **`retired` entries are never deleted**; the `trashed` → `restored` → `resynced` and `rebased` → `resynced` transitions; **every transition refreshes `at`**; `retiredByPath` and `retiredById` index rebuild, newest-first tie-break; rebase archives the old manifest, converts `files` to `rebased` records, clears `files`/`dirs`/`lastCounts` and keeps `retired` |
| `sync.test.ts` | action ordering (trash last); per-file error isolation; **archive failure blocks the destructive action**; archive path sanitization and non-overwriting archive filenames; upload creates missing folders; `unrepresentable` and `ambiguous` keys are never touched; **Drive folders never enter the file diff** |
| `listing.test.ts` | every `files.list` query carries `trashed = false`; the batched query is **parenthesised**; **pagination follows `nextPageToken` to exhaustion**; trashed files never enter the Drive tree; items with `trashed === true` are excluded; the resolver query excludes shortcuts and uses the stored id first |
| `helpers/fakeDrive.ts` | in-memory Drive implementing the `DriveClient` port, with switches to simulate trashed-file leakage, duplicate names, case collisions, a 404 on `files.get`, a `parents` change, and a null-status upload response |

### 11.1 The exhaustiveness test — semantic invariants

A test that merely counts fired rules cannot see a dispatch that stops early with nothing done. The matrix therefore asserts **semantic invariants**. The dimensions enumerated are:

`Dp` ∈ {usable, absent, unusable} · `Dp.mimeType` ∈ {native, binary} · `Mp` ∈ {exists, null} · `Mp.driveMimeType` ∈ {native, binary} · `Lp.state` ∈ {present, absent, unknown} · `rec` ∈ {none} ∪ {trashed, trashed-externally, gone, restored, purged, moved, rebased, resynced} (**8** states) · `Rt(P)` ∈ {empty, non-empty × 8 states} · `claimedBy(P)` ∈ {no foreign claim, claimed by K ≠ P, in retiredClaims} · `mergeOnly` ∈ {true, false} · `driveWins` ∈ {true, false} · `Dp.id == Mp.driveFileId` ∈ {true, false}

The invariants:

| # | Invariant |
|---|---|
| **INV-1** | Every path resolves to exactly one step, and that step resolves to exactly one rule — **or** to an enumerated explicit no-op. The explicit no-ops are exactly: **P1** (unusable Drive key), **P2** in any of its three forms (a claim conflict, whether `D(P)` is usable or absent, and a `retiredClaims` path), **P3** (unreadable), **D5** (nothing on either side), **R2** (a restored file the app leaves alone), and the native guards on **R6**, **R7** and **R10** (report and change nothing). Every other combination must fire a rule with a non-empty action. A path with nothing on either side and no retired record is **not iterated** and is not a no-op case. |
| **INV-2** | **Upload completeness.** Every local file in state `present` that is not a claimed export artifact and not an explicit no-op ends the run with either a live manifest entry at its path or a recorded upload. *(This is the invariant that catches an unreachable upload rule.)* |
| **INV-3** | **Download completeness.** Every usable Drive file that is not retired ends the run with a live manifest entry at its path or an explicit conflict report. |
| **INV-4** | **Mutual exclusivity.** For every rule, the set of input combinations matching it is disjoint from every other rule's set — asserted by intersecting the condition predicates directly, not by observing which rule the engine picked. **N10, N11, R2 and R4 are exempt**: they perform no Drive action, so they are checked for reachability but not for exclusivity. |
| **INV-5** | **No dead state.** Every `retired[].state` other than `resynced` is consumed by **at least one** rule, and every (state × context) pair resolves to **exactly one** rule. `resynced` is consumed by no rule — step P4 excludes it, and it never reaches step P9 because the rule that would remove its live entry transitions the same record to a different state. Every rule is reachable — asserted by enumerating the table and checking that each rule's condition is satisfiable *and* that the step which routes to it cites it. |
| **INV-6** | **Native safety.** For every combination where `Dp.mimeType` is native, no upload-over and no trash is ever planned. *(This is the invariant that catches a missing native guard on R6, R7 or R10.)* |
| **INV-7** | **No data loss.** No planned destructive action — trash, in-place replace, export overwrite — targets a local file whose bytes were not archived first. |

An opt-in live test (`LIVE_DRIVE=1` plus real credentials) exercises the resumable upload and the null-status path against a scratch folder, skipped by default.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Trashed files reappearing in the listing** | Every `files.list` query carries a parenthesised `trashed = false` (§9.3); `trashed === true` items are excluded; pagination is complete; dedicated tests assert all three |
| A user restores a file from Drive Trash and the app re-downloads it | Step P4 (the global retired-id check) resolves it to rule R1, which flips the record to `restored`; rule R2 then leaves it alone permanently, reported exactly once |
| A restored file is moved to another Drive folder and re-downloaded | The step P4 check is **global by id**, not path-scoped, so it fires at any path (§6.3) |
| A rebase or "Reset manifest" re-downloads files the user deleted locally | Live entries are converted into `rebased` retired records carrying the old local fingerprint before `files` is cleared; rule R8 then refuses to download them (§8) |
| **A rebased path stays pinned in Group R forever** | Rules R9 and R10 **release** the `rebased` record into `resynced`, so the run after a rebase uses rules B0 and B1 normally (§6.3, §8) |
| **A local-only file is never uploaded** | Rule E1 is the only upload path for a local file, reachable through step P10; INV-2 asserts upload completeness across the whole matrix (§11.1) |
| **A file stops syncing forever after a restore** | Step P4 excludes the `resynced` state, so the path falls through to the ordinary rules; the `resynced` transition is covered in `diff.test.ts` (§6.3, §11) |
| **Files are duplicated on Drive because a probe misread a path** | The probe compares the file's **current full path** against the manifest path — file against file, never a parent folder against a file (§9.6) |
| An unreadable local subtree causes the app to trash live Drive files | The local tree has three states; step P3 skips every `unknown` path before any rule (§5.2) |
| The app trashes a file another person deliberately removed from Drive | `trashed` and `trashed-externally` are distinct states; only the app's own trash can be restored (rules D1, D2) |
| The app uploads binary bytes over a Google Doc | Rule N11, plus the `D(P)` native guards on **R6**, **R7** and **R10**; INV-6 asserts native safety across the whole matrix (§11.1) |
| A native file replaced by another native file is mishandled | Rule N5 retires the old id and re-exports; the id check is explicit in every Group N rule (§6.3) |
| A stale export of a retired native file is uploaded as a stray binary | The retired record carries the export path, and Pass A claims those paths so they are never uploaded (§5.4, §6.2) |
| The app overwrites a user's unrelated local file with a native export | The planner treats a local file present on disk as a collision (§6.2); INV-7 asserts no destructive action without an archive |
| A rebase overwrites the surviving Drive copy with unvetted disk content | The `drive-wins` inversion table covers B1, B2, C3, R6, R7 and R10; a rebase run is merge-only and B0 does not execute |
| An interrupted rebase leaves a half-converted manifest | The serial and all mirrors are converted in one atomic checkpoint; `rebase.pending` persists until the rebase completes |
| A local file is never backed up because the Drive copy was trashed by someone else | Rule B3 retires it as `trashed-externally` and reports it as unbacked-up; rule D2 keeps reporting it every run rather than silently re-uploading |
| A Drive file the user moved to Trash is recorded as permanently gone | Rule B4 probes before recording, so a restorable file is retired `trashed-externally` rather than `gone` (§6.3) |
| A crash during an un-trash freezes the path permanently | The un-trash writes a durable intent first, so the next run resumes rather than misreading the file as user-restored (§5.5) |
| The Drive id adopted after a null-status upload belongs to the wrong file | The verification lookup matches on **md5 and size**, not name alone (§9.5) |
| A create-upload succeeds but its manifest write is lost | Write-ahead intent, `fsync`'d before the upload, on every create-upload branch (§5.5) |
| Drive API quota on a large tree | BFS listing scoped to the mirror subtree; concurrency 4; minimal field selection |
| Crash mid-upload corrupts a Drive file | Uploads use resumable sessions; in-place replacement is idempotent on the same file id |
| A mass delete on `E:` propagates to Drive | Guard 3 (count drop over a union of directories, baseline not updated when skipped) + Guard 2 (volume serial → volume-wide rebase) + Guard 1 (missing root) |
| Duplicate filenames confuse the diff | Comparison keyed by canonical relative path; colliding Drive keys are flagged ambiguous and skipped entirely |
| Drive-side edits are lost when a local delete is synced | The Drive copy is archived locally **before** it is trashed (rule B0) |
| A Google Doc is destroyed because its exported `.csv` was deleted | Native Drive files are never trashed and never uploaded over (§6.6) |
| A native export is uploaded to Drive as a duplicate binary | The claim index blocks the upload at step P2 (§6.2) |
| Refresh token expires | Production consent screen; refresh token encrypted at rest via `safeStorage` |
| Drive Trash purges after 30 days | Accepted by the user explicitly |
| Windows Defender / SmartScreen on the unsigned `.exe` | Ship the NSIS installer; code-signing is out of scope but noted for later |
| A rename duplicates content on both sides | Known and accepted for v1 (§6.8); the summary states it plainly |

---

## 13. Open items for the user

1. **App name.** The design uses "Drive Mirror" for the window title, installer name, and manifest folder. Confirm or rename.
2. **`E:\.drive-mirror-backup\`.** The live manifest backup is written to the root of `E:`. It sits *outside* the four mirrored folders, so it is never itself synced. Confirm the location, or nominate another path.
3. **First-run merge direction.** On the *initial* first sync, `E:` wins on same-path conflicts: identical files are simply adopted with no transfer, and differing files have their Drive content replaced **in place** (keeping the Drive file id) with the previous Drive bytes archived locally. Confirm — this means the first run rewrites Drive content where the two sides disagree.
4. **Rebase merge direction.** On a *volume-change rebase* the direction is deliberately **reversed** — the Drive copy wins, because on a swapped-in disk the Drive copy is the only surviving version of your work. Confirm this is what you want; the alternative (local wins) would let an unvetted disk overwrite your backup.
5. **Restore from Drive Trash.** When you restore a file from Drive Trash, the app **does not** re-download it into `E:` — it leaves it on Drive, reports it once, and offers a **"Download to `E:`"** button. The alternative (silently re-downloading it) would undo your local deletion. Confirm.
6. **Guard threshold.** The count-drop guard uses a minimum of 5 files before the ratio test applies (a setting, default 5). A literal "more than half" rule with no minimum fires on ordinary small edits and trains you to click "Sync anyway", which defeats the guard. Confirm 5, or set it to 1 for the strictest literal behaviour.
7. **Google-native export path.** If a Google Doc's natural export path (`Budget.csv`) is taken by an unrelated local file or another Drive file, the export is written to `Budget (export 1).csv` instead and the manifest records that path. The alternative is to skip the export entirely, which would leave the Google Doc unbacked-up. Confirm the naming.
8. **A local file whose name exactly matches a Google Doc's name on Drive.** That local file cannot be uploaded — Drive permits both names in one folder, but our path key would then be ambiguous and the whole path would freeze. The app reports it every run and leaves it untracked; the fix is to rename it locally. Confirm that reporting is enough, rather than having the app pick a different Drive name for it.
9. **Google-native types with no export** (forms, scripts, sites). They cannot be backed up into `E:` at all. The app leaves them completely alone on Drive and reports them every run. Confirm.

---

## Appendix A — Pseudo-code restatement

**§6.3 is normative.** This appendix is a mechanical restatement of it, generated from the same table; where they differ, §6.3 wins.

```
canon(p) = p.replace(/\\/g,"/").normalize("NFC").toLowerCase()

# ---- engine inputs ----
# L:             canonPath -> { state: present|absent|unknown, size, mtimeMs, md5?, relPath }
# driveFiles:    canonPath -> DriveEntry[]      (folders are NOT here)
# driveDirs:     canonPath -> folderId
# files:         canonPath -> live entry
# retired:       driveFileId -> record
# retiredByPath: canonPath -> records, newest first
# retiredById:   driveFileId -> record

# ---- PASS A: plan native export paths, build the claim index ----
for each native Drive file D at path P (in canonical path order):
    ext = exportExt(D.mimeType)
    if ext is undefined: continue          # no export exists -> rule N11 handles it
    owner = manifest entry whose driveFileId == D.id       # may be undefined
    candidates = []
    if owner and owner.localPath: candidates.push(owner.localPath)   # ours: always acceptable
    candidates.push(P + ext)
    for n = 1, 2, ...: candidates.push(P + " (export " + n + ")" + ext)

    chosen = undefined
    for c in candidates:
        if owner and c == owner.localPath: chosen = c; break
        if c collides with a Drive file path,
                     another manifest entry's localPath,
                     another planned export path,
                     a retired native file's export path,
                     or a local file present on disk:   continue
        chosen = c; break
    if chosen is undefined: chosen = candidates[0]; report conflict
    plan[D.id] = chosen

claimedBy = Map<localPath, Set<key>>()
for each live manifest entry K: claimedBy[K.localPath].add(K)
for each planned native export:  claimedBy[plan[D.id]].add(P)
retiredClaims = Set<localPath>()
for each retired record R with R.localPath: retiredClaims.add(R.localPath)

# ---- PASS B: the dispatch ----
mergeOnly = mirror.rebase.pending
driveWins = mirror.rebase.mergePolicy == "drive-wins"

for each canon path P in union(local file paths, drive file paths,
                               files[] keys, retiredByPath keys):
    raw      = driveFiles[P]
    usable   = raw and raw.length == 1 and not raw[0].ambiguous and not raw[0].unrepresentable
    Dp       = raw[0] if usable else null
    Lp       = L[P]
    Mp       = files[P]
    Rp       = retiredByPath[P]
    rec      = retiredById[Dp.id] if Dp else null

    # ---- P1: unusable Drive key ----
    if raw and not usable:
        skip P; report; continue

    # ---- P2: claim conflict ----
    claims = claimedBy.get(P) or {}
    if P in retiredClaims:
        skip P; report once "stale export of a retired native file - not uploaded"
        continue
    if any key K in claims with K != P:
        if Dp: skip P; report conflict
        else:  skip P silently      # it is an export artifact owned by K
        continue

    # ---- P3: unreadable local path ----
    if Lp and Lp.state == unknown:
        skip P                          # the scanner reports it
        continue

    # ---- P4: the Drive file is a known, retired id ----
    if Dp and rec and rec.state != "resynced":
        if rec.state in ("trashed","trashed-externally"):
            if Lp.state == absent:
                do NOT download; W-retire(Dp.id,"restored",P); report once
                offer "Download to E:"                     # R1
            elif Lp.state == present:
                if Dp is Google-native:
                    report conflict; change nothing       # N11 applies
                else:
                    if driveWins: archive LOCAL bytes; download (export if native) Drive over local
                    else:         archive DRIVE bytes; replace Drive content with local
                    W-live(P, Dp.id); W-retire(Dp.id,"resynced",P)   # R7
        elif rec.state == "restored":
            if Lp.state == present: report conflict every run; change nothing  # R3
            # absent -> nothing, ever                                            # R2
        elif rec.state in ("gone","purged"):
            leave alone; never download/trash/upload; report anomaly every run  # R4
        elif rec.state == "moved":
            if Lp.state == absent: download (export if native) Dp; W-live(P)    # R5
                                  W-retire(rec.id,"resynced",P)
            elif Lp.state == present:
                if Dp is Google-native:
                    report conflict; change nothing       # N11 applies
                else:
                    if driveWins: archive LOCAL bytes; download (export if native) Drive over local
                    else:         archive DRIVE bytes; upload local over Dp in place
                    W-live(P, Dp.id); W-retire(rec.id,"resynced",P)             # R6
        elif rec.state == "rebased":
            if Lp.state == absent:
                do NOT download; report "not downloaded - the path was empty
                                        locally before the volume changed"      # R8
                # the record stays "rebased": it is the anti-resurrection proof
            else:
                localSame = (Lp.md5 == rec.prevLocalMd5)
                driveSame = (Dp.md5 == rec.md5)
                if localSame and driveSame:
                    W-live(P, Dp.id); W-retire(rec.id,"resynced",P)   # same file, unchanged  # R9
                else:
                    if Dp is Google-native:
                        report conflict; change nothing       # N11 applies
                    else:
                        if driveWins: archive LOCAL bytes; download (export if native) Drive over local
                        else:         archive DRIVE bytes; upload local over Dp in place
                        W-live(P, Dp.id); W-retire(rec.id,"resynced",P)             # R10
        # rec.state == "resynced" -> excluded from P4; falls through to P5/P7
        continue

    # ---- P5: the Drive file is Google-native ----
    if Dp and Dp.mimeType is Google-native:
        if exportExt(Dp.mimeType) is undefined:
            report "no export exists for this type"; change nothing  # N11
        elif Mp is null:                                             # N1            E = plan[Dp.id]
            export Dp to temp
            if a file exists at E and its bytes equal temp: adopt E; write nothing to disk
            else: write temp -> E
            W-live(P, localPath=E, exportMime, driveModifiedTime)
        elif Dp.id != Mp.driveFileId:                              # N5
            probe Mp.driveFileId -> 404 / trashed / alive(moved)
            W-retire(oldId, "gone"|"trashed-externally"|"moved", P,
                     localPath = Mp.localPath if Mp was native else null)
            delete files[P]
            E = plan[Dp.id]
            export Dp to temp
            if a file exists at E and its bytes equal temp: adopt E; write nothing to disk
            else: write temp -> E
            W-live(P, Dp.id, localPath=E, exportMime, driveModifiedTime)
        else:                                                     # same id
            if Dp.driveModifiedTime != Mp.driveModifiedTime:        # N2
                if local export exists and differs from the fresh export:
                    archive LOCAL bytes; overwrite; report
                else: re-export
                W-live(P, updated driveModifiedTime)
            elif local export missing:                             # N3
                regenerate export
            # else N4: nothing
        if Lp and Lp.state == present and canon(Lp.relPath) == P:     # N10 (report only)
            report conflict every run; the local binary is left untracked
        continue

    # ---- P6: a native manifest entry whose Drive file is gone ----
    if Mp and Mp.driveMimeType is Google-native and Dp is null:
        probe Mp.driveFileId -> 404 / trashed / alive(same path) / alive(moved)
        404:          W-retire(id,"gone",P, localPath=Mp.localPath); delete files[P]  # N6
        trashed:      W-retire(id,"trashed-externally",P, localPath=Mp.localPath)
                      delete files[P]; report the local export as unbacked-up          # N7
        alive, same:  W-live(P) unchanged                                             # N8
        alive, moved: W-retire(id,"moved",P, localPath=Mp.localPath); delete files[P]  # N9
        continue

    # ---- P7: the path has a live manifest entry ----
    if Mp:
        if Dp and Dp.id == Mp.driveFileId:
            if Lp.state == absent:                                    # B0
                if not mergeOnly:
                    archive DRIVE bytes (fail-closed)
                    trash Dp
                    W-retire(Dp.id,"trashed",P); delete files[P]
                # mergeOnly: B0 does not execute at all
            elif Lp.state == present:                                 # B1
                localChanged, driveChanged = compare(Lp, Dp, Mp)
                if localChanged and driveChanged:
                    if driveWins: archive LOCAL bytes; download Drive over local
                    else:         archive DRIVE bytes; upload local in place
                elif localChanged:
                    if driveWins: archive LOCAL bytes; download Drive over local
                    else:         upload local in place
                elif driveChanged:
                    archive LOCAL bytes; download Drive over local
                W-live(P, updated)
        elif Dp:                                                     # B2 - different id
            probe Mp.driveFileId -> 404 / trashed / alive(moved)
            W-retire(oldId, "gone"|"trashed-externally"|"moved", P,
                     localPath = Mp.localPath if Mp was native else null)
            if Lp.state == absent: download Dp; keep the Drive copy; W-live(P)
            elif Lp.state == present:
                if driveWins: archive LOCAL bytes; download Drive over local
                else:         archive DRIVE bytes; upload local over Dp in place
                W-live(P, Dp.id)
        else:                                                        # Dp absent
            if Lp.state == present:                                  # B3
                probe Mp.driveFileId -> 404 / trashed / alive(same path) / alive(moved)
                404:    W-intent; upload local as NEW file; report; W-live(P, newId)
                trashed: leave Drive alone; do NOT re-upload; report as UNBACKED-UP
                         W-retire(oldId,"trashed-externally",P,
                                  localPath = Mp.localPath if Mp was native else null)
                         delete files[P]
                alive, same:  re-adopt; W-live(P) unchanged
                alive, moved: W-retire(oldId,"moved",P,
                                       localPath = Mp.localPath if Mp was native else null)
                              delete files[P]
                              W-intent; upload local as NEW file; W-live(P, newId)
            elif Lp.state == absent:                                 # B4
                probe Mp.driveFileId -> 404 / trashed / alive(same path) / alive(moved)
                404:    W-retire(id,"gone",P,
                                 localPath = Mp.localPath if Mp was native else null)
                        delete files[P]
                trashed: W-retire(id,"trashed-externally",P,
                                 localPath = Mp.localPath if Mp was native else null)
                        delete files[P]
                alive, same:  re-adopt; W-live(P) unchanged
                alive, moved: W-retire(id,"moved",P,
                                 localPath = Mp.localPath if Mp was native else null)
                        delete files[P]
        continue

    # ---- P8: a Drive file we have never tracked ----
    if Dp:
        if Lp.state == absent:                                       # C1
            download (export if native) into E:, keep the Drive copy; W-live(P)
        elif Lp.state == present:                                    # C2 / C3
            if Dp.md5 == Lp.md5:  adopt, no transfer; W-live(P)
            else:
                if driveWins: archive LOCAL bytes; download Drive over local
                else:         archive DRIVE bytes; upload local in place
                W-live(P)
        continue

    # ---- P9: a retired record at this path, Drive file absent ----
    if Rp:
        rec = Rp[0]
        if Lp.state == present:
            if rec.state == "trashed":                               # D1
                if mergeOnly:
                    report "deferred - the Drive copy is in Trash"; no action
                else:
                    probe rec.id -> trashed / 404 / alive(same path) / alive(moved)
                    trashed:      W-intent(untrash); un-trash rec.id (keep id);
                                  archive DRIVE bytes; replace content with local;
                                  W-live(P, rec.id); W-retire(rec.id,"resynced",P)
                    404:           W-intent; upload local as NEW file; W-live(P, newId);
                                  W-retire(rec.id,"purged",P)
                    alive, same:   archive DRIVE bytes; replace content with local;
                                  W-live(P, rec.id); W-retire(rec.id,"resynced",P)
                    alive, moved:  W-retire(rec.id,"moved",P);
                                  W-intent; upload local as NEW file; W-live(P, newId)
            elif rec.state == "trashed-externally":                  # D2
                report the local file as UNBACKED-UP; do NOT upload
            elif rec.state in ("gone","purged","moved","restored"):  # D3
                W-intent; upload local as NEW file; W-live(P, newId)
            elif rec.state == "rebased":                             # D4
                W-intent; upload local as NEW file; W-live(P, newId)
        # Lp absent -> D5: nothing
        continue

    # ---- P10: a local file we have never tracked, Drive file absent ----
    if Lp.state == present:                                         # E1
        W-intent; upload (create); W-live(P, newId)
    # Lp absent -> the path is not iterated; nothing to do

checkpoint manifest (atomic, all mirrors + serial together)
merge lastCounts (current dirs set; absent dirs -> 0)
if mirror.rebase.pending: clear it; mergePolicy -> local-wins
```

**Never executed for any key flagged `unrepresentable` or `ambiguous`:** no download, no upload, no trash — reported instead. **Never executed for a local path in state `unknown`:** every rule — reported instead by the scanner. **Never executed for a Google-native Drive file:** upload-over and trash. **Never executed while `rebase.pending` is set:** B0 and D1.
