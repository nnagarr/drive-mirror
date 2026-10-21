# Drive Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A packaged Windows 11 desktop app that mirrors `E:\Medicine`, `E:\graphicDesign`, `E:\videoEditing`, and `E:\whoami` up to the matching folders in the user's Google Drive `My Drive`, using a persistent checksum manifest and four anti-catastrophe guards.

**Architecture:** The sync engine lives in `src/core/` as framework-free TypeScript that imports neither `electron` nor `node:fs` nor `node:https`. It consumes two injected ports — a scanned local tree and a `DriveClient` interface — and produces a `SyncPlan` of actions plus manifest operations. The executor in `src/core/sync.ts` applies the plan against a real Drive client, writing the manifest through an atomic store with a write-ahead journal. The Electron main process owns credentials (DPAPI via `safeStorage`), wires the ports, and streams progress to a React renderer over a typed IPC bridge.

**Tech Stack:** Electron 44.9.x, React 19.3.x, TypeScript 5.9.x, Vite 8.3.x, electron-vite 6.0.x, electron-builder 26.15.x, Vitest 5.0.x, `google-auth-library` 11.3.x. No `googleapis` bundle — Drive REST is called directly over `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-21-drive-mirror-design.md` (rev 10). The plan argues from the spec; executors read both. §6.3 of the spec is the **normative** rule table — this plan restates it as tasks but never contradicts it.

---

## Global Constraints

These apply to every task. If a task's steps seem to conflict with one of these lines, the constraint wins and the task step is wrong.

**Toolchain and versions**

- Windows 11 only. Node 24.20.0 and npm 11.19.0 are installed on this machine.
- Pin exactly: `electron@44.9.2`, `react@19.3.1`, `react-dom@19.3.1`, `typescript@5.9.3`, `vite@8.3.4`, `electron-vite@6.0.0`, `electron-builder@26.15.3`, `vitest@5.0.5`, `@vitejs/plugin-react@6.1.2`, `google-auth-library@11.3.1`, `@types/node@24.19.2`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`.
- `npm test` runs `vitest run`. `npm run typecheck` runs `tsc --noEmit`. `npm run build` runs `electron-vite build`. `npm run dist` runs `electron-builder --win`.
- Tests live in `test/` and match `test/**/*.test.ts`. Vitest `environment: 'node'`, `include: ['test/**/*.test.ts']`.

**The four mirrors — exactly these, no more, no fewer**

| Local root | Drive destination |
|---|---|
| `E:\Medicine` | `My Drive/Medicine` |
| `E:\graphicDesign` | `My Drive/graphicDesign` |
| `E:\videoEditing` | `My Drive/videoEditing` |
| `E:\whoami` | `My Drive/whoami` |

**Invariants that must hold in every task**

1. **Only rule B0 may trash.** No other rule, and no code path anywhere, may issue a permanent delete. Trash is `PATCH /drive/v3/files/{id}` with `{"trashed": true}`. Restore is `{"trashed": false}`. Nothing ever calls `files.delete`.
2. **Every `files.list` query carries `trashed = false` and parenthesises its OR-clauses.** The exact form is `"trashed = false and ('id1' in parents or 'id2' in parents)"`. The Drive API returns trashed files by default; omitting the filter resurrects every deleted file.
3. **`pageSize=1000` and follow `nextPageToken` to exhaustion** on every listing.
4. **Archive before every destructive action**, and **fail closed**: if the archive write fails, skip that file's destructive action entirely rather than continuing.
5. **Canonical path keys everywhere.** `canon(p) = p.replace(/\\/g,"/").normalize("NFC").toLowerCase()`. Map keys and lookups use the canonical form; original casing lives in `displayPath` only.
6. **The `retired` map is never pruned.** Entries are only transitioned between states.
7. **The manifest `files` map is keyed by Drive relative path; `retired` is keyed by `driveFileId`.** Two maps, because a path can hold two facts at once.
8. **Core imports nothing from `electron`, `node:fs`, `node:https`, or `google-auth-library`.** All I/O arrives through injected ports.
9. **Drive writes are confined to the four resolved mirror roots** and their descendants.
10. **Google-native Drive files are never uploaded over and never trashed.** Their local counterpart is a regenerable export.

**Approved decisions (from the spec's §13, accepted by approving the spec)**

- App name: **Drive Mirror**. Window title, installer name, and `%LOCALAPPDATA%\DriveMirror` folder all use it.
- Manifest live backup: **`E:\.drive-mirror-backup\`**. It sits outside the four mirrored roots, so it is never itself synced.
- First sync (no manifest): **`E:` wins** on same-path conflicts. Identical files are adopted with no transfer; differing files have their Drive content replaced **in place**, keeping the Drive file id, with the prior Drive bytes archived locally first.
- Rebase (volume changed): **Drive wins.** The surviving Drive copy is the only copy of the user's work.
- Restore from Drive Trash: the app **does not** re-download it. It leaves the file on Drive, reports it once, and offers a **"Download to `E:`"** button.
- Guard threshold: **5 files** (a setting). Below 5, only a complete wipe of a directory trips the guard.
- Google-native export path collision: the export goes to **`Budget (export 1).csv`**, then `Budget (export 2).csv`, and so on. The manifest records the chosen path.
- A local file whose name exactly matches a Google-native Drive file's path: **reported every run and left untracked** — it is not uploaded and the Drive name is not changed.
- Google-native types with no export (forms, scripts, sites): **left completely alone on Drive and reported every run.**

**Credentials**

- The OAuth client id and secret are **entered in the app's Settings screen** and stored encrypted with Electron `safeStorage` (DPAPI on Windows) at `%LOCALAPPDATA%\DriveMirror\credentials.bin`. Neither is ever written into the repository, a build artifact, or a log.
- For the live smoke test only, `DRIVE_MIRROR_CLIENT_ID` and `DRIVE_MIRROR_CLIENT_SECRET` environment variables override the stored values. The client id is `429010975839-tud3c8c7fl9i91ieo7u2upk0os4np6eg.apps.googleusercontent.com`.
- OAuth redirect URI: `http://localhost:<ephemeral-port>`, matching the client's registered host. Google accepts any port for Desktop-app clients; `http://127.0.0.1:<port>` is equivalent.
- Scope is exactly `https://www.googleapis.com/auth/drive`. `drive.file` cannot see `My Drive/Medicine` and is not usable here.

---

## Review Focus

The five input classes most likely to bite a real user of this software. Each line names the input and the behaviour a reasonable person would expect. Every line is pinned by a test in the task named in its row.

| # | Input / condition | Expected behaviour | Pinned by |
|---|---|---|---|
| 1 | A file the app trashed on Drive is still listed by the API (Drive returns trashed files by default) | It must not come back into the mirror, and must not be re-downloaded. The listing filter is `trashed = false`, parenthesised, on **every** query | Task 4 (`listing.test.ts`), Task 11 (`exhaustiveness.test.ts`) |
| 2 | A local file cannot be read — access denied, path too long, a junction in its place | The app must treat it as `unknown`, not as deleted, and must not trash its Drive copy | Task 3 (`localScan.test.ts`), Task 7 (`diff.test.ts`) |
| 3 | The user restores a file from Drive Trash | The file must not silently re-download into `E:`. It is reported once and left alone | Task 9 (`diff.test.ts`), Task 11 |
| 4 | `E:` is reassigned to a different physical volume (drive letter change, disk swap) | The app must refuse to sync and must not trash the Drive mirror. The volume serial is the fingerprint | Task 12 (`guards.test.ts`) |
| 5 | A file the user created on `E:` that has never been synced | It must reach Drive. A mirror that silently skips local files is not a mirror | Task 6 (`diff.test.ts`), Task 11 (INV-2) |

Two further conditions that are not in the five but must not be forgotten: a file that Drive cannot checksum (zero-byte files, some binary types) must not be treated as "content differs" and must not trigger an archive on every run (§6.5); and a 292 MB file must upload through a resumable session whose final chunk can return an empty body with a null status, which must not be retried into a duplicate file (§9.5).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/paths.ts` | Canonical path keys, Windows representability checks, reserved names, filesystem sanitisation. No I/O. |
| `src/core/types.ts` | Every shared domain type: `LocalEntry`, `LocalTree`, `DriveFile`, `DriveTree`, `LiveEntry`, `RetiredRecord`, `RetiredState`, `MirrorManifest`, `Manifest`, `ManifestOp`, `JournalOp`, `Report`, `ReportCode`. No logic. |
| `src/core/hashing.ts` | Streaming MD5 of a file, and of a buffer. |
| `src/core/googleMime.ts` | Google-native mime detection and the export-mime map. |
| `src/core/manifest.ts` | Manifest schema, atomic write, journal append/replay, checkpoint, index construction. |
| `src/core/localScan.ts` | Walk a local root into a `LocalTree` with present/absent/unknown states; recursive per-directory file counts. |
| `src/core/driveTree.ts` | Assemble Drive listing nodes into a `DriveTree`; build the `trashed = false` listing query; detect ambiguity and unrepresentable names. |
| `src/core/claims.ts` | Claim index (`claimedBy`, `retiredClaims`) and the Pass-A export-path planner. |
| `src/core/diff.ts` | The normative dispatch: steps P1–P10 and rule groups R, N, B, C, D, E. Produces a `SyncPlan`. |
| `src/core/guards.ts` | Count-drop guard, volume-fingerprint guard, rebase conversion. |
| `src/core/sync.ts` | Plan executor: phase ordering, fail-closed archiving, error isolation, write-ahead intents, journal application. |
| `src/core/logger.ts` | Structured event log with per-run file output. |
| `src/drive/client.ts` | The `DriveClient` port interface — the only surface `core` is allowed to know about Drive. |
| `src/drive/httpClient.ts` | REST implementation of `DriveClient`: list, get, create, update, trash, untrash, download, export. |
| `src/drive/resumable.ts` | Resumable upload sessions, chunking, null-status recovery by md5+size lookup. |
| `src/drive/oauth.ts` | Loopback OAuth flow, token exchange, refresh, and the `files.list` query string escaping. |
| `src/main/index.ts` | App lifecycle, single-instance lock, window creation, IPC registration. |
| `src/main/window.ts` | BrowserWindow construction and native chrome. |
| `src/main/settings.ts` | Settings load/save, credential storage via `safeStorage`, env-var override. |
| `src/main/runner.ts` | Wires core + drive together; runs a sync; emits progress events. |
| `src/preload/index.ts` | The `contextBridge` API surface. |
| `src/renderer/index.html` | Renderer entry document. |
| `src/renderer/main.tsx` | React root. |
| `src/renderer/App.tsx` | Window shell, state subscription, layout. |
| `src/renderer/components/*.tsx` | `FolderCard`, `SummaryBar`, `ProgressPanel`, `LogView`, `SettingsDialog`, `GuardBanner`. |
| `src/renderer/styles.css` | Win11-flavoured light/dark styles. |
| `test/helpers/fixtures.ts` | Builders for `LocalTree`, `DriveTree`, `MirrorManifest` test doubles. |
| `test/helpers/fakeDrive.ts` | In-memory `DriveClient` that records every mutation by type. |

---

## Task 1: Project scaffold and canonical path utilities

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `canon(p: string): string`, `isWindowsReservedName(name: string): boolean`, `isRepresentableOnWindows(name: string): boolean`, `parentPath(p: string): string`, `baseName(p: string): string`, `sanitizePathSegment(seg: string): string`, `joinPath(...segments: string[]): string`.

- [ ] **Step 1: Write the failing test**

`test/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  canon, isWindowsReservedName, isRepresentableOnWindows,
  parentPath, baseName, sanitizePathSegment, joinPath,
} from '../src/core/paths'

describe('canon', () => {
  it('normalizes separators to forward slashes', () => {
    expect(canon('renders\\final\\scene.psd')).toBe('renders/final/scene.psd')
  })
  it('lowercases for case-insensitive matching', () => {
    expect(canon('Renders/Final/Scene.PSD')).toBe('renders/final/scene.psd')
  })
  it('normalizes to NFC', () => {
    expect(canon('café/x.psd')).toBe(canon('café/x.psd'))
  })
  it('treats a and A as the same key', () => {
    expect(canon('A.psd')).toBe(canon('a.psd'))
  })
})

describe('isWindowsReservedName', () => {
  it('rejects reserved device names', () => {
    for (const n of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
      expect(isWindowsReservedName(n)).toBe(true)
    }
  })
  it('rejects reserved names with an extension', () => {
    expect(isWindowsReservedName('CON.txt')).toBe(true)
  })
  it('accepts ordinary names', () => {
    expect(isWindowsReservedName('scene.psd')).toBe(false)
    expect(isWindowsReservedName('CONSOLE')).toBe(false)
  })
})

describe('isRepresentableOnWindows', () => {
  it('rejects names with illegal characters', () => {
    for (const n of ['a:b.psd', 'a*b.psd', 'a?b.psd', 'a"b.psd', 'a<b.psd', 'a>b.psd', 'a|b.psd']) {
      expect(isRepresentableOnWindows(n)).toBe(false)
    }
  })
  it('rejects names ending in a dot or space', () => {
    expect(isRepresentableOnWindows('scene.')).toBe(false)
    expect(isRepresentableOnWindows('scene ')).toBe(false)
  })
  it('rejects reserved device names', () => {
    expect(isRepresentableOnWindows('NUL')).toBe(false)
  })
  it('accepts ordinary names', () => {
    expect(isRepresentableOnWindows('scene.psd')).toBe(true)
    expect(isRepresentableOnWindows('render final v3.psd')).toBe(true)
  })
})

describe('path helpers', () => {
  it('returns the parent of a nested path', () => {
    expect(parentPath('renders/final/scene.psd')).toBe('renders/final')
  })
  it('returns an empty parent for a top-level path', () => {
    expect(parentPath('scene.psd')).toBe('')
  })
  it('returns the final segment', () => {
    expect(baseName('renders/final/scene.psd')).toBe('scene.psd')
  })
  it('joins and canonicalises segments', () => {
    expect(joinPath('renders', 'Final', 'Scene.PSD')).toBe('renders/final/scene.psd')
  })
})

describe('sanitizePathSegment', () => {
  it('replaces illegal characters with underscores', () => {
    expect(sanitizePathSegment('a:b*c?d')).toBe('a_b_c_d')
  })
  it('replaces control characters', () => {
    expect(sanitizePathSegment('a\u0001b')).toBe('a_b')
  })
  it('leaves a legal name untouched', () => {
    expect(sanitizePathSegment('scene.psd')).toBe('scene.psd')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/paths.test.ts`
Expected: FAIL — `Cannot find module '../src/core/paths'`.

- [ ] **Step 3: Write the scaffold and the implementation**

`package.json` — scripts exactly:

```json
{
  "name": "drive-mirror",
  "version": "1.0.0",
  "description": "Mirror four folders on E: up to Google Drive",
  "main": "./out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "dist": "npm run build && electron-builder --win"
  },
  "dependencies": {
    "google-auth-library": "11.3.1"
  },
  "devDependencies": {
    "@types/node": "24.19.2",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.2",
    "electron": "44.9.2",
    "electron-builder": "26.15.3",
    "electron-vite": "6.0.0",
    "react": "19.3.1",
    "react-dom": "19.3.1",
    "typescript": "5.9.3",
    "vite": "8.3.4",
    "vitest": "5.0.5"
  }
}
```

`react` and `react-dom` are runtime dependencies of the renderer but electron-vite bundles the renderer, so listing them under `devDependencies` is fine for an app that bundles its renderer. `google-auth-library` is used by the main process at runtime and is externalized by `externalizeDepsPlugin`, so it must be a real `dependency`.

`.gitignore` — ignore `node_modules/`, `out/`, `dist/`, `*.log`, and critically:

```
# Never commit OAuth credentials
*.client_secret*.json
client_secret*.json
.env
.env.*
```

`tsconfig.json` — references the two project configs so `tsc --noEmit` covers main/preload/core and renderer separately:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

`tsconfig.node.json` covers `src/core`, `src/drive`, `src/main`, `src/preload`, `test`, with `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"target": "ES2022"`, `"strict": true`, `"noUncheckedIndexedAccess": true`, `"types": ["node"]`, and `"composite": true`.

`tsconfig.web.json` covers `src/renderer` with `"jsx": "react-jsx"`, `"lib": ["ES2022","DOM","DOM.Iterable"]`, `"types": ["vite/client"]`, `"composite": true`, and `"noEmit": false` so the renderer build can emit.

`electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'src/main/index.ts' } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: 'src/preload/index.ts' } },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
})
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
```

`src/core/paths.ts` — implement `canon` exactly as `p.replace(/\\/g, '/').normalize('NFC').toLowerCase()`; `isWindowsReservedName` matching `/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i` against the base name; `isRepresentableOnWindows` rejecting `[:*?"<>|]`, a trailing dot or space, and reserved names; `sanitizePathSegment` replacing `[:*?"<>|\x00-\x1f]` with `_`.

- [ ] **Step 4: Run typecheck and tests to verify they pass**

Run: `npm install` then `npm run typecheck` then `npm test -- test/paths.test.ts`
Expected: typecheck clean; all `paths.test.ts` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig*.json electron.vite.config.ts vitest.config.ts .gitignore src/core/paths.ts test/paths.test.ts
git commit -m "chore: scaffold Electron app and add canonical path utilities"
```

---

## Task 2: Core domain types and the manifest store

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/manifest.ts`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Consumes: `canon` from `src/core/paths.ts` (Task 1).
- Produces:
  - `src/core/types.ts`: `LocalEntry`, `LocalTree`, `DriveFile`, `DriveNode`, `DriveTree`, `LiveEntry`, `RetiredState`, `RetiredRecord`, `MirrorManifest`, `Manifest`, `ManifestOp`, `JournalOp`, `Report`, `ReportCode`.
  - `src/core/manifest.ts`: `createManifestStore(dir: string): ManifestStore`, `emptyManifest(): Manifest`, `buildIndexes(m: MirrorManifest): { retiredByPath: Map<string, RetiredRecord[]>; retiredById: Map<string, RetiredRecord> }`, `applyManifestOp(m: MirrorManifest, op: ManifestOp): void`, `emptyMirror(root: string): MirrorManifest`.

- [ ] **Step 1: Write the failing test**

`test/manifest.test.ts` must cover, with assertions on exact values:

```ts
it('writes the manifest atomically', async () => {
  // store.write(m) then store.read() returns m; and no manifest.json.tmp remains
})

it('round-trips every manifest field through JSON', async () => {
  // a MirrorManifest with files, retired (all 8 states), lastCounts, dirs, rebase
  // survives write -> read with every field deep-equal
})

it('appends journal lines and replays them onto a checkpoint', async () => {
  // store.checkpoint(base); store.appendJournal(op); const replayed = await store.replayJournal(base)
  // replayed equals base with op applied
})

it('never prunes retired records', async () => {
  // apply a set-retired op, then a del-file op for the same path, then read
  // the retired record is still present with its state
})

it('refreshes at on every state transition', async () => {
  // set-retired with state 'trashed' then set-retired same id with state 'restored'
  // the resulting record's at is >= the original at
})

it('builds retiredByPath newest-first', () => {
  // three retired records at the same path with different `at` values
  // buildIndexes(...).retiredByPath.get(path)[0].id is the newest
})

it('builds retiredById keyed by drive file id', () => {
  // buildIndexes(...).retiredById.get('1XyZ') is that record
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/manifest.test.ts`
Expected: FAIL — `Cannot find module '../src/core/manifest'`.

- [ ] **Step 3: Implement `src/core/types.ts`**

Define these exactly:

```ts
export type LocalState = 'present' | 'absent' | 'unknown'

export interface LocalEntry {
  state: LocalState
  size?: number
  mtimeMs?: number
  md5?: string
}

export interface LocalTree {
  files: Map<string, LocalEntry>
  dirs: Set<string>
  unreadableDirs: Map<string, string>
  recursiveCounts: Record<string, number>
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: number
  md5?: string | null
  driveModifiedTime: string
  ambiguous: boolean
  unrepresentable: boolean
}

export interface DriveNode {
  entry: {
    id: string
    name: string
    mimeType: string
    size?: string
    md5Checksum?: string
    modifiedTime: string
    trashed: boolean
    parents: string[]
  }
  parentPath: string
}

export interface DriveTree {
  files: Map<string, DriveFile[]>
  dirs: Map<string, string>
  dirById: Map<string, string>
}

export interface LiveEntry {
  displayPath: string
  driveFileId: string
  driveMd5: string | null
  driveModifiedTime: string
  driveMimeType: string
  exportMime: string | null
  localPath: string
  localMd5: string | null
  localSize: number
  localMtimeMs: number
}

export type RetiredState =
  | 'trashed' | 'trashed-externally' | 'gone' | 'restored'
  | 'purged' | 'moved' | 'rebased' | 'resynced'

export interface RetiredRecord {
  path: string
  state: RetiredState
  at: string
  md5: string | null
  driveMimeType: string
  localPath: string | null
  prevLocalMd5?: string | null
}

export interface MirrorManifest {
  root: string
  driveFolderId?: string
  driveFolderName?: string
  lastSyncAt?: string
  lastCounts: Record<string, number>
  rebase: { pending: boolean; mergePolicy: 'local-wins' | 'drive-wins' } | null
  dirs: Record<string, { driveFolderId: string }>
  files: Record<string, LiveEntry>
  retired: Record<string, RetiredRecord>
}

export interface Manifest {
  version: number
  updatedAt: string
  volumes: Record<string, { dev: number; label?: string; checkedAt: string }>
  mirrors: Record<string, MirrorManifest>
}

export type ManifestOp =
  | { op: 'set-file'; path: string; entry: LiveEntry }
  | { op: 'del-file'; path: string }
  | { op: 'set-retired'; id: string; record: RetiredRecord }
  | { op: 'del-retired'; id: string }

export type JournalOp =
  | ManifestOp
  | { op: 'intent'; kind: 'create-upload' | 'untrash'; path: string; driveFileId?: string; parentId?: string; localMd5?: string; size?: number }

export type ReportCode =
  | 'restored-from-trash' | 'unbacked-up' | 'native-path-conflict'
  | 'native-no-export' | 'anomaly' | 'rebased-not-downloaded'
  | 'stale-export' | 'ambiguous' | 'unrepresentable' | 'deferred-trash'

export interface Report {
  code: ReportCode
  relPath: string
  message: string
}
```

`Manifest.version` is `10`. `emptyManifest()` returns `{ version: 10, updatedAt: new Date().toISOString(), volumes: {}, mirrors: {} }`.

- [ ] **Step 4: Implement `src/core/manifest.ts`**

`createManifestStore(dir)` returns:

```ts
export interface ManifestStore {
  read(): Promise<Manifest>
  write(m: Manifest): Promise<void>
  checkpoint(m: Manifest): Promise<void>
  appendJournal(op: JournalOp): Promise<void>
  readJournal(): Promise<JournalOp[]>
  replayJournal(base: Manifest): Promise<Manifest>
}
```

Implementation requirements, each of which a test asserts:

- `read()` returns `emptyManifest()` when `<dir>/manifest.json` does not exist.
- `write(m)` writes `<dir>/manifest.json.tmp`, `fsync`s it, then `rename`s it over `manifest.json`, and removes the tmp file if any error occurs. No `.tmp` file survives a successful write.
- `appendJournal(op)` appends one JSON line to `<dir>/journal.ndjson` and `fsync`s the file descriptor before returning.
- `readJournal()` parses each line as a `JournalOp`, skipping lines that fail to parse.
- `replayJournal(base)` returns a manifest with every non-`intent` op applied in order via `applyManifestOp`.
- `applyManifestOp(m, op)` implements the four ops. `set-retired` **replaces** the record but preserves the existing `at` only when the state is unchanged; a **state change** sets `at` to `new Date().toISOString()`. `set-retired` never deletes an existing record for the same id — it overwrites in place.
- `buildIndexes(m)` returns `retiredByPath` (canonical path → records sorted newest-first by `at`) and `retiredById` (id → record). Both are built fresh from `m.retired` on every call.
- `emptyMirror(root)` returns a mirror with empty `files`, `retired`, `dirs`, `lastCounts`, and `rebase: null`.

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` then `npm test -- test/manifest.test.ts`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/manifest.ts test/manifest.test.ts
git commit -m "feat(core): domain types and atomic manifest store with journal"
```

---

## Task 3: Local scanner with present/absent/unknown states

**Files:**
- Create: `src/core/localScan.ts`
- Test: `test/localScan.test.ts`

**Interfaces:**
- Consumes: `canon`, `parentPath`, `joinPath` from `src/core/paths.ts` (Task 1); `LocalTree`, `LocalEntry` from `src/core/types.ts` (Task 2).
- Produces: `scanLocal(opts: ScanOptions): Promise<LocalTree>` and `ScanOptions`.

- [ ] **Step 1: Write the failing test**

`test/localScan.test.ts` builds real temp directories under `os.tmpdir()` and asserts:

```ts
it('records readable files as present with size and mtime', async () => {
  // write a.txt (3 bytes) under root/dir/
  // scanLocal -> tree.files.get(canon('dir/a.txt')).state === 'present'
  //   .size === 3, .mtimeMs is a number > 0
})

it('marks a path absent when it does not exist', async () => {
  // knownPaths: ['gone.txt'] -> tree.files.get('gone.txt').state === 'absent'
})

it('marks an unreadable file unknown, not absent', async () => {
  // create a file, chmod 0o000, scan -> state === 'unknown'
  // (skip this assertion when running as an account that bypasses permissions;
  //  assert instead that the scanner reports it under unreadableDirs)
})

it('marks every path under an unreadable directory unknown', async () => {
  // chmod 0o000 a directory containing b.txt; knownPaths includes 'locked/b.txt'
  // -> tree.files.get('locked/b.txt').state === 'unknown'
  // -> tree.unreadableDirs has a key starting with 'locked'
})

it('never follows a symlink or junction', async () => {
  // create symlink link -> realDir; scan -> no path under 'link/' appears in tree.files
})

it('computes recursive counts per directory', async () => {
  // root/dir/a.txt, root/dir/sub/b.txt, root/c.txt
  // tree.recursiveCounts[''] === 3
  // tree.recursiveCounts['dir'] === 2
  // tree.recursiveCounts['dir/sub'] === 1
})

it('reports the root count as the total file count', async () => {
  // tree.recursiveCounts[''] equals the number of present files
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/localScan.test.ts`
Expected: FAIL — `Cannot find module '../src/core/localScan'`.

- [ ] **Step 3: Implement `src/core/localScan.ts`**

```ts
export interface ScanOptions {
  root: string
  knownPaths: string[]
}
export async function scanLocal(opts: ScanOptions): Promise<LocalTree>
```

Implementation requirements:

- Walk `root` recursively with `fs.promises.readdir(dir, { withFileTypes: true })`.
- For each entry use `lstat` semantics: if `entry.isSymbolicLink()`, **skip it entirely** — do not follow it, do not record it as a file. Record the skipped symlink's path in a `skipped` note on the tree's `unreadableDirs` map only if the scanner has no better place for it; the simplest conforming behaviour is to skip silently, since the spec only requires that symlinks are never followed.
- A file that cannot be read (`EACCES`, `EPERM`, `ENOENT` mid-walk, path too long) is recorded as `state: 'unknown'`.
- A directory that cannot be read (`readdir` rejects) is recorded in `unreadableDirs` with the error message, and **every `knownPaths` entry under that directory** is recorded in `files` with `state: 'unknown'`.
- Every `knownPaths` entry that is not found on disk and not under an unreadable directory is recorded with `state: 'absent'`. This is how a deleted file becomes visible to the diff.
- `md5` is **not** computed during the scan. The diff computes it lazily through the injected `md5Of` port.
- `recursiveCounts` counts only `present` files, keyed by canonical directory path, with the root keyed `''`. A directory's count includes every file beneath it.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test -- test/localScan.test.ts`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/localScan.ts test/localScan.test.ts
git commit -m "feat(core): three-state local scanner with recursive counts"
```

---

## Task 4: Drive tree, the listing discipline, and pagination

**Files:**
- Create: `src/core/driveTree.ts`
- Test: `test/driveTree.test.ts`, `test/listing.test.ts`

**Interfaces:**
- Consumes: `canon`, `isRepresentableOnWindows`, `parentPath`, `baseName` from `src/core/paths.ts` (Task 1); `DriveFile`, `DriveNode`, `DriveTree` from `src/core/types.ts` (Task 2).
- Produces: `buildDriveTree(nodes: DriveNode[]): DriveTree`, `buildListQuery(parentIds: string[]): string`, `isGoogleNativeMime(mimeType: string): boolean`.

- [ ] **Step 1: Write the failing test**

`test/listing.test.ts` — the query-builder tests, which pin the exact wire format:

```ts
it('always filters trashed files', () => {
  expect(buildListQuery(['abc'])).toBe("trashed = false and ('abc' in parents)")
})

it('parenthesises a multi-parent OR clause', () => {
  const q = buildListQuery(['abc', 'def'])
  expect(q.startsWith('trashed = false and (')).toBe(true)
  expect(q.endsWith(')')).toBe(true)
  expect(q).toContain("'abc' in parents or 'def' in parents")
})

it('rejects an empty parent list', () => {
  expect(() => buildListQuery([])).toThrow()
})
```

`test/driveTree.test.ts`:

```ts
it('groups files by canonical path', () => {
  // node { name: 'Scene.PSD', parentPath: '' } -> driveFiles.get('scene.psd') has one entry
})

it('marks two files with the same name in one folder ambiguous', () => {
  // two nodes, same parentPath '', same name 'a.psd' but different ids
  // -> files.get('a.psd').length === 2 and every entry has ambiguous === true
})

it('marks a case collision ambiguous', () => {
  // 'A.psd' and 'a.psd' in one folder -> both flagged ambiguous
})

it('flags a name that Windows cannot represent', () => {
  // node named 'a:b.psd' -> unrepresentable === true
})

it('maps folder ids to their canonical paths', () => {
  // folder node at parentPath 'renders' -> dirs.get('renders') === its id
  // and dirById.get(id) === 'renders'
})

it('resolves a node path from its parent path and name', () => {
  // node { name: 'Scene.PSD', parentPath: 'renders/final' } -> files key 'renders/final/scene.psd'
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/driveTree.test.ts test/listing.test.ts`
Expected: FAIL — `Cannot find module '../src/core/driveTree'`.

- [ ] **Step 3: Implement `src/core/driveTree.ts`**

`buildListQuery(parentIds)` returns exactly:

```
trashed = false and ('id1' in parents or 'id2' in parents)
```

with each id single-quoted. It throws on an empty array — an unfiltered whole-drive listing is never acceptable.

`buildDriveTree(nodes)` assembles the tree:

- Each node's canonical path is `joinPath(parentPath, name)` — but folders are recorded in `dirs`/`dirById`, not `files`.
- A node whose mimeType is `application/vnd.google-apps.folder` becomes a directory: `dirs.set(canonPath, node.entry.id)` and `dirById.set(node.entry.id, canonPath)`.
- Other nodes become file entries in `files.get(canonPath)`, pushed as an array so multiple files can share a path.
- After grouping, **every** entry at a key with more than one member gets `ambiguous = true`.
- Every entry whose name fails `isRepresentableOnWindows` gets `unrepresentable = true`.
- `md5` is taken from `md5Checksum`, `size` parsed from the string `size`, `driveModifiedTime` from `modifiedTime`.

`isGoogleNativeMime(mimeType)` returns true when the mimeType starts with `application/vnd.google-apps.`.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test -- test/driveTree.test.ts test/listing.test.ts`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/driveTree.ts test/driveTree.test.ts test/listing.test.ts
git commit -m "feat(core): Drive tree assembly and trashed=false listing discipline"
```

---

## Task 5: Claim index and the export-path planner

**Files:**
- Create: `src/core/claims.ts`
- Test: `test/claims.test.ts`

**Interfaces:**
- Consumes: `canon`, `joinPath` from `src/core/paths.ts` (Task 1); `DriveTree`, `MirrorManifest`, `LiveEntry`, `RetiredRecord` from `src/core/types.ts` (Task 2); `isGoogleNativeMime` from `src/core/driveTree.ts` (Task 4).
- Produces: `planExportPaths(drive: DriveTree, manifest: MirrorManifest, local: LocalTree): Map<string, string>` and `buildClaimIndex(manifest: MirrorManifest, plan: Map<string, string>): ClaimIndex`.

```ts
export interface ClaimIndex {
  claimedBy: Map<string, Set<string>>
  retiredClaims: Set<string>
}
```

- [ ] **Step 1: Write the failing test**

`test/claims.test.ts`:

```ts
it('plans the natural export path when it is free', () => {
  // native file 'Budget' at path 'budget'; no local file at 'budget.csv'
  // plan.get(<driveFileId>) === 'budget.csv'
})

it('falls back to "(export N)" when the natural path is taken on disk', () => {
  // native file 'Budget'; a local file 'Budget.csv' exists in the local tree
  // plan.get(<driveFileId>) === 'budget (export 1).csv'
})

it('increments the export suffix until it is free', () => {
  // local files 'Budget.csv' and 'Budget (export 1).csv' both exist
  // plan.get(<driveFileId>) === 'budget (export 2).csv'
})

it('avoids a path occupied by another Drive file', () => {
  // a Drive binary already at 'budget.csv' plus a native 'Budget'
  // plan.get(<driveFileId>) is not 'budget.csv'
})

it('avoids a path claimed by another native file', () => {
  // two native files whose natural export paths collide -> the second gets a suffix
})

it('reuses the recorded localPath of an existing native entry', () => {
  // manifest files['budget'].localPath === 'budget (export 1).csv' and that path is free
  // plan.get(<driveFileId>) === 'budget (export 1).csv'
})

it('claims a live entry localPath', () => {
  // manifest files['renders/scene.psd'].localPath === 'renders/scene.psd'
  // claimedBy.get('renders/scene.psd') contains 'renders/scene.psd'
})

it('claims a planned export path under the native file key', () => {
  // claimedBy.get('budget.csv') contains 'budget'
})

it('claims the export path of a retired native file', () => {
  // manifest retired['1XyZ'].localPath === 'budget.csv' and state 'gone'
  // retiredClaims has 'budget.csv'
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/claims.test.ts`
Expected: FAIL — `Cannot find module '../src/core/claims'`.

- [ ] **Step 3: Implement `src/core/claims.ts`**

`planExportPaths` processes native Drive files **in canonical path order** (so the plan is deterministic) and, for each, builds the candidate list:

1. the manifest entry's recorded `localPath`, if the manifest already tracks this Drive file id;
2. `joinPath(path, ext)` where `ext` is the export extension for the mime type;
3. `joinPath(path, '(export N).ext)` for `N = 1, 2, 3, …`.

A candidate is **taken** if it collides with another Drive file path, another manifest entry's `localPath`, another planned export path, or a local file present in the local tree. The first candidate whose recorded `localPath` belongs to this Drive file id wins immediately; otherwise the first untaken candidate wins. If every candidate is taken, use the first candidate and record a conflict.

The export extension comes from `googleMime.ts` (Task 6 will create it; if it does not exist yet, define the mapping locally in `claims.ts` and have Task 6 consolidate it). **Prefer creating `src/core/googleMime.ts` in this task** with:

```ts
export const NATIVE_EXPORT_MAP: Record<string, { exportMime: string; ext: string }> = {
  'application/vnd.google-apps.document':   { exportMime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet':{ exportMime: 'text/csv',  ext: '.csv' },
  'application/vnd.google-apps.presentation':{ exportMime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.drawing':   { exportMime: 'image/png', ext: '.png' },
}
export function exportInfoFor(mimeType: string): { exportMime: string; ext: string } | null
export function isGoogleNativeMime(mimeType: string): boolean
```

`buildClaimIndex(manifest, plan)` returns `claimedBy` (every live entry's `localPath` maps to its key; every planned export path maps to the native file's key) and `retiredClaims` (every retired record with a non-null `localPath`).

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test -- test/claims.test.ts`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/claims.ts src/core/googleMime.ts test/claims.test.ts
git commit -m "feat(core): claim index and native export-path planner"
```

---

## Task 6: The diff dispatch, and rule groups C and E

**Files:**
- Create: `src/core/diff.ts`
- Test: `test/diff.test.ts`

**Interfaces:**
- Consumes: `canon` from `paths.ts`; all types from `types.ts`; `buildDriveTree`, `isGoogleNativeMime` from `driveTree.ts`; `buildClaimIndex`, `planExportPaths` from `claims.ts`; `exportInfoFor` from `googleMime.ts`; `applyManifestOp` from `manifest.ts`.
- Produces:

```ts
export interface ProbeResult {
  status: 'missing' | 'trashed' | 'alive'
  currentPath?: string
}

export interface DiffIo {
  probe(driveFileId: string): Promise<ProbeResult>
  md5Of(relPath: string): Promise<string | null>
  readLocalBytes(relPath: string): Promise<Buffer | null>
  exportNative(driveFileId: string): Promise<Buffer | null>
}

export type SyncAction =
  | { kind: 'create-folder'; relPath: string }
  | { kind: 'upload'; relPath: string; localPath: string; md5: string; size: number }
  | { kind: 'replace-content'; relPath: string; localPath: string; driveFileId: string; md5: string; size: number }
  | { kind: 'download'; relPath: string; localPath: string; driveFileId: string; size: number }
  | { kind: 'export-native'; relPath: string; localPath: string; driveFileId: string; exportMime: string; size: number }
  | { kind: 'trash'; relPath: string; driveFileId: string }
  | { kind: 'untrash'; relPath: string; driveFileId: string }

export interface PlanStep {
  action: SyncAction | null
  report?: Report
  ops: ManifestOp[]
}

export interface SyncPlan {
  steps: PlanStep[]
  reports: Report[]
}

export interface DiffInput {
  local: LocalTree
  drive: DriveTree
  manifest: MirrorManifest
  io: DiffIo
  mergeOnly: boolean
  driveWins: boolean
}

export async function diffMirror(input: DiffInput): Promise<SyncPlan>
```

`PlanStep` carries exactly one of `action` or `report`. `ops` are the manifest operations to apply **after** the step succeeds.

- [ ] **Step 1: Write the failing test**

`test/diff.test.ts` — build a `DiffInput` from `test/helpers/fixtures.ts` and assert:

```ts
it('downloads a Drive-only file (C1)', async () => {
  // drive has 'renders/scene.psd', local has nothing, manifest empty
  // -> one step, action kind 'download', localPath 'renders/scene.psd'
  // -> ops contain set-file for 'renders/scene.psd'
})

it('adopts an identical file with no transfer (C2)', async () => {
  // local 'a.psd' md5 'm1', drive 'a.psd' md5 'm1'
  // -> no action step; a step with action null and ops set-file
})

it('uploads a local-only file (E1)', async () => {
  // local 'new.psd', drive empty, manifest empty
  // -> action kind 'upload', localPath 'new.psd', ops set-file
})

it('uploads a local-only file even when another path has a retired record', async () => {
  // retired record exists at a DIFFERENT path
  // -> still uploads
})

it('does not upload a local file claimed as a native export', async () => {
  // native 'Budget' planned export 'budget.csv'; local 'budget.csv' present
  // -> no upload action for 'budget.csv'
})

it('never trashes anything (no trash action in group C or E)', async () => {
  // run a case with local missing and drive present
  // -> no action of kind 'trash'
})

it('reports and skips an ambiguous Drive path', async () => {
  // two drive entries at 'a.psd'
  // -> report code 'ambiguous', no action
})

it('reports and skips an unrepresentable Drive path', async () => {
  // drive entry named 'a:b.psd'
  // -> report code 'unrepresentable', no action
})

it('skips an unreadable local path entirely', async () => {
  // local entry state 'unknown'
  // -> no action, no trash
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/diff.test.ts`
Expected: FAIL — `Cannot find module '../src/core/diff'`.

- [ ] **Step 3: Create `test/helpers/fixtures.ts`**

Export builders that later tasks reuse:

```ts
export function localTree(files: Record<string, Partial<LocalEntry> & { state: LocalState }>, dirs: string[] = []): LocalTree
export function driveTree(nodes: DriveNode[]): DriveTree
export function mirrorManifest(overrides?: Partial<MirrorManifest>): MirrorManifest
export function diffIo(overrides?: Partial<DiffIo>, local?: LocalTree): DiffIo
```

`diffIo` returns defaults where `probe` resolves `{ status: 'missing' }`, `md5Of` resolves null, `readLocalBytes` resolves null, and `exportNative` resolves null.

- [ ] **Step 4: Implement the dispatch skeleton and groups C and E**

`src/core/diff.ts` must implement the **normative** dispatch from spec §6.3, in this exact order:

```
P1  Drive key unusable (ambiguous or unrepresentable)  -> skip, report
P2  local path claimed by another key, or in retiredClaims -> skip (report if a Drive file is present)
P3  local state 'unknown'                             -> skip
P4  Drive file usable and its id is in retiredById with state != 'resynced' -> Group R
P5  Drive file usable and Google-native               -> Group N
P6  manifest entry is native and Drive file absent     -> Group N
P7  manifest entry exists                             -> Group B
P8  no manifest entry, Drive file usable              -> Group C
P9  no manifest entry, no Drive file, retired records  -> Group D
P10 no manifest entry, no Drive file, no retired       -> Group E
```

Steps P1–P3 and P8–P10 are implemented in this task. **P4, P5, P6, P7, P9 are declared but their rule groups are added in Tasks 7–10.** To keep the dispatch total from the start, implement the step order with a `notImplemented(step)` throw that names the step, and have the tests for this task only exercise P1–P3, P8, and P10.

Group C (spec §6.3):

- **C1** — `L(P)` is `absent`: **download** it into `E:`, keep the Drive copy. Action `download` with `relPath` and `localPath` both `P`, `driveFileId` the Drive id, `size` the Drive size. Ops: `set-file` for `P` with the LiveEntry built from the Drive metadata and the local path.
- **C2** — `L(P)` is `present` and the Drive `md5` equals the local `md5`: **no transfer**. The step's `action` is `null`; ops carry `set-file` for `P`.
- **C3** — `L(P)` is `present` and the content differs: **local wins**. Action `replace-content` with `driveFileId` the Drive id and the local `md5` and `size`. Ops: `set-file` for `P`.

When Drive provides **no** `md5`, C2 and C3 cannot be decided by content: fall back to comparing `size` and `modifiedTime`; if those are also inconclusive, treat it as C3 but **without archiving** (there is no older version to preserve — the executor is told not to archive when the action carries `md5: null`).

Group E:

- **E1** — `L(P)` is `present`: **upload**. Action `upload` with `localPath` `P`, the local `md5` and `size`. Ops: `set-file` for `P`.

Both groups produce `LiveEntry` objects whose `driveMd5` is the Drive checksum or `null`, whose `localMd5` is the computed local checksum or `null`, and whose `localSize`/`localMtimeMs` come from the local entry.

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` then `npm test -- test/diff.test.ts`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/diff.ts test/diff.test.ts test/helpers/fixtures.ts
git commit -m "feat(core): diff dispatch skeleton with rule groups C and E"
```

---

## Task 7: Rule group B — the live manifest entry, including the one trash rule

**Files:**
- Modify: `src/core/diff.ts`
- Modify: `test/diff.test.ts`

**Interfaces:**
- Consumes: everything Task 6 produces.
- Produces: rule group B in `src/core/diff.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/diff.test.ts`:

```ts
it('trashes the Drive copy when the local file is deleted (B0)', async () => {
  // manifest files['a.psd'] with driveFileId 'D1'; local 'a.psd' state 'absent'; drive 'a.psd' id 'D1'
  // -> exactly one action of kind 'trash' with driveFileId 'D1'
  // -> ops contain set-retired id 'D1' with state 'trashed'
  // -> ops contain del-file for 'a.psd'
})

it('never trashes when the local path is unreadable (B0 guard)', async () => {
  // same but local state 'unknown' -> no trash action, no report
})

it('does not trash during a rebase (B0 mergeOnly guard)', async () => {
  // same as the trash case but mergeOnly: true
  // -> no trash action AND no set-retired op with state 'trashed'
})

it('uploads local changes in place keeping the Drive id (B1 local-changed)', async () => {
  // manifest driveMd5 'm1'; local md5 'm2'; drive md5 'm1'
  // -> action 'replace-content' with driveFileId 'D1'
})

it('downloads Drive changes (B1 drive-changed)', async () => {
  // manifest driveMd5 'm1'; local md5 'm1'; drive md5 'm2'
  // -> action 'download'
})

it('uploads local changes when both changed (B1 both-changed)', async () => {
  // manifest driveMd5 'm1'; local md5 'm2'; drive md5 'm3'
  // -> action 'replace-content'
})

it('does nothing when neither side changed (B1 neither)', async () => {
  // -> no action of any kind
})

it('downloads the Drive version when driveWins and both changed', async () => {
  // driveWins: true, both changed -> action 'download', not 'replace-content'
})

it('re-adopts a Drive file that was merely missed by the listing (B2/B3 same-path)', async () => {
  // probe returns { status: 'alive', currentPath: 'a.psd' }
  // -> no transfer action; ops set-file for 'a.psd'
})

it('retires the tracked id as moved when the Drive file moved (B2)', async () => {
  // probe returns { status: 'alive', currentPath: 'b.psd' }
  // -> ops set-retired old id state 'moved'
  // -> action 'download' for 'b.psd' (the new file) when local 'b.psd' absent
})

it('reports an unbacked-up file when someone else trashed it (B3)', async () => {
  // probe returns { status: 'trashed' }
  // -> report code 'unbacked-up', NO upload action
  // -> ops set-retired state 'trashed-externally'
})

it('uploads a new Drive file when the old one is gone for good (B3 404)', async () => {
  // probe returns { status: 'missing' }
  // -> action 'upload'
})

it('retires both sides when the file is gone from both (B4)', async () => {
  // drive absent, local absent
  // -> ops set-retired state 'gone', del-file
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/diff.test.ts`
Expected: FAIL — the new assertions fail (the group is not implemented).

- [ ] **Step 3: Implement group B in `src/core/diff.ts`**

Implement spec §6.3's group B exactly: **B0** (the only trash), **B1** (the four-way compare), **B2** (id differs — probe, then treat the file at `P` as new-on-Drive), **B3** (Drive file absent, local present — probe, then upload or report), **B4** (both absent — retire as `gone`).

Every rule that retires a live entry must carry the entry's `localPath` into the retired record when that entry was Google-native. The `trashed-externally` and `gone` states are used exactly as the spec's §5.4 table prescribes; `trashed` is used only by B0.

B1's content comparison uses the local `md5` from `io.md5Of(relPath)`, comparing against the manifest's `driveMd5` and the Drive file's current `md5`. When the manifest has no `driveMd5` (no checksum available), fall back to size and `modifiedTime`; if that is inconclusive, treat the local side as changed.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test in the repo PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts test/diff.test.ts
git commit -m "feat(core): rule group B including the single trash rule"
```

---

## Task 8: Rule group D — the retired path

**Files:**
- Modify: `src/core/diff.ts`
- Modify: `test/diff.test.ts`

**Interfaces:**
- Consumes: everything Task 6 produces.
- Produces: rule group D in `src/core/diff.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it('restores a trashed Drive file and replaces its content (D1)', async () => {
  // retired['D1'] state 'trashed' at path 'a.psd'; local 'a.psd' present; drive absent
  // probe returns { status: 'trashed' }
  // -> action 'untrash' with driveFileId 'D1'
  // -> ops set-file for 'a.psd', set-retired 'D1' state 'resynced'
})

it('uploads a new file when the trashed Drive copy was purged (D1 404)', async () => {
  // probe returns { status: 'missing' }
  // -> action 'upload'
  // -> ops set-retired 'D1' state 'purged'
})

it('replaces content in place when the file was restored but not moved (D1 alive same path)', async () => {
  // probe returns { status: 'alive', currentPath: 'a.psd' }
  // -> action 'replace-content', no 'untrash' action
  // -> ops set-retired 'D1' state 'resynced'
})

it('uploads a new file when the file was restored AND moved (D1 alive moved)', async () => {
  // probe returns { status: 'alive', currentPath: 'b.psd' }
  // -> action 'upload'; ops set-retired 'D1' state 'moved'
})

it('does not re-upload a file someone else trashed (D2)', async () => {
  // retired['D1'] state 'trashed-externally' at 'a.psd'; local 'a.psd' present
  // -> NO upload action
  // -> report code 'unbacked-up'
})

it('uploads a new file when the old Drive copy is gone (D3)', async () => {
  // retired['D1'] state 'gone' at 'a.psd'; local present
  // -> action 'upload'
})

it('uploads a new file for a rebased path (D4)', async () => {
  // retired['D1'] state 'rebased' at 'a.psd'; local present
  // -> action 'upload'
})

it('does nothing when the path is absent locally (D5)', async () => {
  // retired record present, local absent
  // -> no action
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/diff.test.ts`
Expected: FAIL — the new assertions fail.

- [ ] **Step 3: Implement group D in `src/core/diff.ts`**

Implement spec §6.3's group D: **D1** (the four probe outcomes), **D2** (never re-upload an externally-trashed file), **D3**, **D4**, **D5**.

D1's `trashed` branch emits **two** actions in order: `untrash` first, then `replace-content`. The `untrash` step's ops include the `set-file` and the `resynced` transition so the manifest reflects the restored file even if the subsequent content replacement fails.

D1's `alive, same path` branch emits only `replace-content` — no `untrash`, because the file is already live.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts test/diff.test.ts
git commit -m "feat(core): rule group D for retired paths"
```

---

## Task 9: Rule group R — the retired id, the resurrection guard

**Files:**
- Modify: `src/core/diff.ts`
- Modify: `test/diff.test.ts`

**Interfaces:**
- Consumes: everything Task 6 produces; `buildIndexes` from `manifest.ts` (Task 2).
- Produces: rule group R in `src/core/diff.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it('does not download a file restored from Drive Trash (R1)', async () => {
  // retired['D1'] state 'trashed' at 'a.psd'; drive has 'a.psd' id 'D1'; local 'a.psd' absent
  // -> NO action of kind 'download'
  // -> report code 'restored-from-trash'
  // -> ops set-retired 'D1' state 'restored'
})

it('leaves a restored file alone forever (R2)', async () => {
  // retired['D1'] state 'restored'; drive 'a.psd' id 'D1'; local absent
  // -> no action, no report
})

it('reports a conflict when a restored file collides with a local file (R3)', async () => {
  // retired['D1'] state 'restored'; drive 'a.psd' id 'D1'; local 'a.psd' present
  // -> no action
  // -> report code 'native-path-conflict' or a dedicated restored-conflict report
})

it('leaves an impossible gone/purged record alone (R4)', async () => {
  // retired['D1'] state 'gone' but drive 'a.psd' id 'D1' exists
  // -> no action
  // -> report code 'anomaly'
})

it('downloads a moved file that is now at this path (R5)', async () => {
  // retired['D1'] state 'moved' at 'a.psd'; drive 'a.psd' id 'D1'; local absent
  // -> action 'download'
  // -> ops set-retired 'D1' state 'resynced'
})

it('replaces content in place for a moved file with a local collision (R6)', async () => {
  // retired['D1'] state 'moved'; drive 'a.psd' id 'D1'; local 'a.psd' present
  // -> action 'replace-content' keeping driveFileId 'D1'
})

it('does not download a rebased path that was empty locally (R8)', async () => {
  // retired['D1'] state 'rebased' at 'a.psd'; drive 'a.psd' id 'D1'; local absent
  // -> NO download action
  // -> report code 'rebased-not-downloaded'
  // -> the retired record stays 'rebased'
})

it('adopts a rebased file that came back unchanged (R9)', async () => {
  // retired['D1'] state 'rebased', prevLocalMd5 'm1', md5 'm1'; drive md5 'm1'; local md5 'm1'
  // -> no transfer action
  // -> ops set-file + set-retired 'D1' state 'resynced'
})

it('reconciles a rebased file that changed on Drive (R10)', async () => {
  // retired['D1'] state 'rebased', prevLocalMd5 'm1', md5 'm1'; drive md5 'm2'; local md5 'm1'
  // -> driveWins true -> action 'download'
  // -> ops set-retired 'D1' state 'resynced'
})

it('never trashes or uploads over a Google-native file in group R', async () => {
  // drive 'a.psd' is a Google-native file with id 'D1' and a retired record
  // -> no action of kind 'trash' and no action of kind 'replace-content'
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/diff.test.ts`
Expected: FAIL — the new assertions fail.

- [ ] **Step 3: Implement group R in `src/core/diff.ts`**

Implement spec §6.3's group R: **R1** (trashed/trashed-externally, local absent — report once, flip to `restored`), **R2** (restored, local absent — nothing, ever), **R3** (restored, local present — conflict, report), **R4** (gone/purged — anomaly, leave alone), **R5** (moved, local absent — download), **R6** (moved, local present — replace in place), **R7** (trashed/trashed-externally, local present — replace in place, keep the restored id), **R8** (rebased, local absent — never download), **R9** (rebased, both sides unchanged — adopt), **R10** (rebased, either side changed — reconcile).

Two rules carry extra weight and must be exactly right:

- **R1** must never produce a `download` action. The file is on Drive and the user restored it deliberately. The app reports it once and flips the record to `restored`; every later run is silent (R2).
- **R9 and R10** must both write `W-retire(id, "resynced", P)` so the path returns to the ordinary rules (B0/B1) on the next run. Leaving the record as `rebased` would pin the path in Group R forever, and a local deletion would never be trashed.

R10 compares **both** sides: the local `md5` against `rec.prevLocalMd5`, and the Drive file's current `md5` against `rec.md5`. R9 requires both to match. Otherwise R10 reconciles by the conflict principle — `drive-wins` during a rebase.

The Google-native guard on **R6**, **R7** and **R10** applies: when the Drive file at `P` is Google-native, the rule emits no Drive action and no local-wins upload — it reports and changes nothing.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts test/diff.test.ts
git commit -m "feat(core): rule group R guarding against resurrecting deleted files"
```

---

## Task 10: Rule group N — Google-native files

**Files:**
- Modify: `src/core/diff.ts`
- Modify: `test/diff.test.ts`

**Interfaces:**
- Consumes: everything Task 6 produces; `exportInfoFor` from `googleMime.ts` (Task 5).
- Produces: rule group N in `src/core/diff.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it('exports a first-sight native file to its planned path (N1)', async () => {
  // drive 'budget' is a Google Sheet; planned export 'budget.csv'; local has no 'budget.csv'
  // -> action 'export-native' with exportMime 'text/csv', localPath 'budget.csv'
})

it('adopts an identical existing export without writing it (N1 adopt)', async () => {
  // local 'budget.csv' exists and io.exportNative returns the same bytes
  // -> no export action; ops set-file with localPath 'budget.csv'
})

it('never overwrites an unrelated local file at the natural export path (N1)', async () => {
  // local 'budget.csv' exists with different bytes; planned export is 'budget (export 1).csv'
  // -> export action targets 'budget (export 1).csv'
  // -> the local 'budget.csv' is NOT read or written
})

it('re-exports when the Drive document changed (N2)', async () => {
  // manifest driveModifiedTime 't1'; drive modifiedTime 't2'
  // -> action 'export-native'
})

it('archives a user-edited export before overwriting it (N2)', async () => {
  // the local export bytes differ from the fresh export
  // -> the action carries a flag telling the executor to archive the local export first
})

it('regenerates a deleted export without trashing the Google Doc (N3)', async () => {
  // recorded localPath missing from disk
  // -> action 'export-native'
  // -> NO action of kind 'trash'
})

it('does nothing when the native file is unchanged and the export exists (N4)', async () => {
  // -> no action
})

it('retires the old id and exports the replacement (N5)', async () => {
  // manifest tracks native id 'D1' at 'budget'; drive 'budget' has native id 'D2'
  // -> ops set-retired 'D1'
  // -> action 'export-native' for 'D2'
})

it('never uploads over or trashes a native file (N6/N7)', async () => {
  // -> no action of kind 'upload', 'replace-content', or 'trash'
})

it('re-adopts a native file that was merely missed by the listing (N8)', async () => {
  // manifest tracks native id 'D1' at 'budget'; drive 'budget' absent from the listing
  // io.probe('D1') returns { status: 'alive', currentPath: 'budget' }
  // -> NO export action
  // -> ops set-file for 'budget'
})

it('retires a native file that was moved on Drive (N9)', async () => {
  // manifest tracks native id 'D1' at 'budget'; drive 'budget' absent from the listing
  // io.probe('D1') returns { status: 'alive', currentPath: 'archive/budget' }
  // -> ops set-retired 'D1' state 'moved'
  // -> NO export action at 'budget'
})

it('reports a native type that has no export (N11)', async () => {
  // drive 'form' has mimeType 'application/vnd.google-apps.form'
  // -> report code 'native-no-export'
  // -> no action
})

it('reports a local file occupying a native path (N10)', async () => {
  // native 'budget' and a local file at 'budget'
  // -> report code 'native-path-conflict'
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/diff.test.ts`
Expected: FAIL — the new assertions fail.

- [ ] **Step 3: Implement group N in `src/core/diff.ts`**

Implement spec §6.3's group N: **N1**–**N11**.

N1's "adopt an identical existing export" comparison uses `io.exportNative(driveFileId)` and `io.readLocalBytes(localPath)` and compares the byte buffers. When they differ, the export goes to the **planned** path from `planExportPaths`, which is guaranteed not to be the occupied path.

N5 must carry the retired entry's `localPath` into the retired record so the stale export is claimed and never uploaded.

N11 covers a native mime with no entry in `NATIVE_EXPORT_MAP`.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts test/diff.test.ts
git commit -m "feat(core): rule group N for Google-native files"
```

---

## Task 11: The exhaustiveness matrix

**Files:**
- Create: `test/exhaustiveness.test.ts`
- Modify: `src/core/diff.ts` (only if the matrix exposes a gap)

**Interfaces:**
- Consumes: `diffMirror` and every type from Task 6.
- Produces: a test that proves the dispatch is total and every invariant holds.

- [ ] **Step 1: Write the failing test**

`test/exhaustiveness.test.ts` enumerates the full cross-product of:

- `Dp` ∈ {usable, absent, unusable}
- `Dp.mimeType` ∈ {native, binary}
- `Mp` ∈ {exists, null}
- `Mp.driveMimeType` ∈ {native, binary}
- `Lp.state` ∈ {present, absent, unknown}
- `rec` ∈ {none} ∪ {trashed, trashed-externally, gone, restored, purged, moved, rebased, resynced}
- `Rt(P)` ∈ {empty, non-empty × the 8 states}
- `claimedBy(P)` ∈ {no foreign claim, claimed by K ≠ P, in retiredClaims}
- `mergeOnly` ∈ {true, false}
- `driveWins` ∈ {true, false}
- `Dp.id == Mp.driveFileId` ∈ {true, false}

and asserts the spec's §11.1 invariants:

```ts
it('every combination resolves to exactly one rule or an enumerated no-op', () => {
  // for each combination, diffMirror must not throw 'notImplemented'
  // and the number of action steps must be 0 or 1 (plus the D1 two-step untrash+replace)
})

it('INV-2 upload completeness: every present local file reaches Drive', () => {
  // for every combination where Lp.state is 'present' and the path is not claimed
  // and not an enumerated no-op, the plan contains an 'upload' or 'replace-content' action
  //   OR the path has a live manifest entry
})

it('INV-3 download completeness: every usable non-retired Drive file is adopted', () => {
  // every usable Drive file with no retired id ends with a live manifest entry or a report
})

it('INV-4: no two rules match the same combination', () => {
  // for each combination, collect the set of matching rule ids via the exported matchRule()
  // and assert the set has at most one member
})

it('INV-5: every retired state is consumed by at least one rule', () => {
  // assert each of the 8 states appears in a rule's condition
  // and that 'resynced' is excluded from the P4 step
})

it('INV-6 native safety: no upload-over and no trash for a native Drive file', () => {
  // for every combination where Dp.mimeType is 'native',
  // assert no action of kind 'trash', 'upload' onto that path, or 'replace-content'
})

it('INV-7: no destructive action without an archive', () => {
  // every 'trash' and 'replace-content' action must carry an archive requirement
})

it('every rule in the table is reachable', () => {
  // assert matchRule returns a non-empty rule id for at least one combination
  // for each rule id the table defines
  // (a rule no combination can reach is dead code and will drift out of sync with the spec)
})

it('the resynced state is excluded from step P4', () => {
  // a combination with a resynced retired record must resolve to the ordinary
  // live-entry rule, not to a group R rule
})
```

To make INV-4 checkable, `src/core/diff.ts` must export a helper:

```ts
export function matchRule(input: DiffInput, path: string): string[]
```

returning the ids of every rule whose condition matches, in dispatch order.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/exhaustiveness.test.ts`
Expected: FAIL — `matchRule` is not exported, or some combination throws `notImplemented`.

- [ ] **Step 3: Export `matchRule` and close every gap the matrix finds**

Refactor the dispatch so each rule's condition is a named predicate that `matchRule` can evaluate without performing I/O. The `io` calls (`probe`, `md5Of`, `exportNative`) must be injectable as **pre-computed values** for the matrix — add an optional `precomputed` field to `DiffInput`:

```ts
export interface DiffInput {
  // ...existing fields
  precomputed?: {
    probe?: (driveFileId: string) => ProbeResult
    md5Of?: (relPath: string) => string | null
  }
}
```

When `precomputed` is present it takes precedence over `io`. This keeps `matchRule` synchronous and side-effect free, and lets the matrix evaluate thousands of combinations instantly.

For each combination the matrix reports, fix the underlying gap in `src/core/diff.ts` until every combination resolves to exactly one rule or one of the enumerated no-ops: P1, P2 (all three forms), P3, D5, R2, R4, and the native guards on R6/R7/R10.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS, including the exhaustiveness matrix.

- [ ] **Step 5: Commit**

```bash
git add src/core/diff.ts test/exhaustiveness.test.ts
git commit -m "test(core): exhaustiveness matrix over the full dispatch"
```

---

## Task 12: Safety guards

**Files:**
- Create: `src/core/guards.ts`
- Test: `test/guards.test.ts`

**Interfaces:**
- Consumes: `LocalTree`, `MirrorManifest` from `types.ts` (Task 2); `canon` from `paths.ts` (Task 1).
- Produces:

```ts
export interface CountDropHit { dir: string; last: number; current: number }
export interface GuardResult {
  blocked: boolean
  reason?: 'missing-root' | 'volume-changed' | 'count-drop'
  hits: CountDropHit[]
  message?: string
}
export function checkCountDrop(
  lastCounts: Record<string, number>,
  currentCounts: Record<string, number>,
  threshold: number,
): CountDropHit[]
export function checkVolumeFingerprint(
  recorded: { dev: number } | undefined,
  current: { dev: number },
): boolean
export function rebaseMirror(m: MirrorManifest, now: string): MirrorManifest
```

- [ ] **Step 1: Write the failing test**

`test/guards.test.ts`:

```ts
it('does not trip when exactly half the files remain', () => {
  expect(checkCountDrop({ '': 10 }, { '': 5 }, 5)).toEqual([])
})

it('trips when more than half the files are gone', () => {
  const hits = checkCountDrop({ '': 10 }, { '': 4 }, 5)
  expect(hits).toHaveLength(1)
  expect(hits[0].dir).toBe('')
  expect(hits[0].last).toBe(10)
  expect(hits[0].current).toBe(4)
})

it('trips on a complete wipe of a small directory', () => {
  expect(checkCountDrop({ 'renders': 3 }, { 'renders': 0 }, 5)).toHaveLength(1)
})

it('does not trip on a small directory that lost one file', () => {
  expect(checkCountDrop({ 'renders': 3 }, { 'renders': 2 }, 5)).toEqual([])
})

it('trips on a directory that disappeared entirely', () => {
  // lastCounts has 'renders': 12; currentCounts has no 'renders' key at all
  const hits = checkCountDrop({ 'renders': 12 }, {}, 5)
  expect(hits).toHaveLength(1)
  expect(hits[0].current).toBe(0)
})

it('does not trip on a new directory with no baseline', () => {
  expect(checkCountDrop({}, { 'brand-new': 7 }, 5)).toEqual([])
})

it('detects a changed volume serial', () => {
  expect(checkVolumeFingerprint({ dev: 404660920 }, { dev: 404660920 })).toBe(false)
  expect(checkVolumeFingerprint({ dev: 404660920 }, { dev: 999999 })).toBe(true)
})

it('does not detect a change when there is no recorded fingerprint', () => {
  expect(checkVolumeFingerprint(undefined, { dev: 1 })).toBe(false)
})

it('rebase converts live entries into rebased retired records', () => {
  // a mirror with one live file
  // rebaseMirror -> files is empty, retired has the id with state 'rebased'
  // and prevLocalMd5 set from the live entry's localMd5
})

it('rebase preserves existing retired records', () => {
  // a mirror with a retired 'trashed' record
  // rebaseMirror keeps that record with state 'trashed'
})

it('rebase clears counts and dirs but keeps the root', () => {
  expect(rebaseMirror(m, 'now').lastCounts).toEqual({})
  expect(rebaseMirror(m, 'now').dirs).toEqual({})
  expect(rebaseMirror(m, 'now').root).toBe(m.root)
})

it('rebase sets the rebase pending flag with drive-wins', () => {
  expect(rebaseMirror(m, 'now').rebase).toEqual({ pending: true, mergePolicy: 'drive-wins' })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/guards.test.ts`
Expected: FAIL — `Cannot find module '../src/core/guards'`.

- [ ] **Step 3: Implement `src/core/guards.ts`**

`checkCountDrop(lastCounts, currentCounts, threshold)`:

- The comparison set is the **union** of the keys of `lastCounts` and `currentCounts`.
- For each key `d`: `last = lastCounts[d] ?? 0`, `current = currentCounts[d] ?? 0`.
- Trip when `(last >= threshold && current < last * 0.5)` **or** `(last >= 1 && current === 0)`.
- A key present only in `currentCounts` has `last = 0` and never trips.
- Returns every tripping directory as `{ dir, last, current }`.

`checkVolumeFingerprint(recorded, current)` returns `true` when the volume changed. A missing `recorded` returns `false` — the first run has nothing to compare against.

`rebaseMirror(m, now)`:

- Every live entry in `files` becomes a retired record with `state: 'rebased'`, `path` the entry's key, `at: now`, `md5` the entry's `driveMd5`, `driveMimeType` the entry's `driveMimeType`, `localPath` the entry's `localPath`, and `prevLocalMd5` the entry's `localMd5`.
- A `rebased` record **replaces** any existing retired record for the same id, so a stale `resynced` record cannot survive the rebase.
- Existing retired records for ids with no live entry are kept untouched.
- `files`, `dirs` and `lastCounts` are cleared. `root` is kept.
- `rebase` becomes `{ pending: true, mergePolicy: 'drive-wins' }`.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/guards.ts test/guards.test.ts
git commit -m "feat(core): count-drop guard, volume fingerprint, and rebase conversion"
```

---

## Task 13: The plan executor

**Files:**
- Create: `src/core/sync.ts`
- Create: `src/core/logger.ts`
- Create: `src/drive/client.ts`
- Test: `test/sync.test.ts`
- Test: `test/helpers/fakeDrive.ts`

**Interfaces:**
- Consumes: `SyncPlan`, `PlanStep`, `SyncAction`, `ManifestOp` from `diff.ts` (Task 6); `ManifestStore`, `applyManifestOp` from `manifest.ts` (Task 2); `canon`, `sanitizePathSegment` from `paths.ts` (Task 1).
- Produces:

```ts
// src/drive/client.ts
export interface DriveClient {
  listChildren(folderId: string): Promise<DriveNode[]>
  getFile(fileId: string): Promise<DriveNode | null>
  createFolder(name: string, parentId: string): Promise<{ id: string }>
  createFile(name: string, parentId: string, body: Readable, opts: { md5: string; size: number; mimeType?: string }): Promise<{ id: string }>
  updateContent(fileId: string, body: Readable, opts: { md5: string; size: number }): Promise<void>
  downloadTo(fileId: string, destPath: string): Promise<void>
  exportTo(fileId: string, destPath: string, mimeType: string): Promise<void>
  trash(fileId: string): Promise<void>
  untrash(fileId: string): Promise<void>
}

// src/core/sync.ts
export interface SyncRunResult {
  uploaded: number
  replaced: number
  downloaded: number
  exported: number
  trashed: number
  untrashed: number
  errors: Array<{ relPath: string; message: string }>
  reports: Report[]
  manifest: MirrorManifest
}
export interface ExecutorContext {
  client: DriveClient
  store: ManifestStore
  manifest: MirrorManifest
  root: string
  archiveDir: string
  onProgress?: (event: ProgressEvent) => void
}
export async function executePlan(plan: SyncPlan, ctx: ExecutorContext): Promise<SyncRunResult>
```

- [ ] **Step 1: Write the failing test**

`test/helpers/fakeDrive.ts` implements `DriveClient` in memory and records every call:

```ts
export interface DriveCall {
  op: 'list' | 'get' | 'createFolder' | 'createFile' | 'updateContent'
     | 'download' | 'export' | 'trash' | 'untrash'
  id?: string
  name?: string
}
export class FakeDrive implements DriveClient {
  calls: DriveCall[]
  // ...
}
```

`test/sync.test.ts`:

```ts
it('runs folders before uploads, uploads before downloads, downloads before trashes', async () => {
  // a plan containing one of each action
  // -> fakeDrive.calls order is createFolder, createFile, download, trash
})

it('archives the Drive bytes before trashing', async () => {
  // -> a file exists under archiveDir for the trashed path before the trash call
})

it('skips the trash when the archive write fails', async () => {
  // make the archive directory unwritable
  // -> no 'trash' call in fakeDrive.calls
  // -> the result carries an error for that path
})

it('skips the content replacement when the archive write fails', async () => {
  // -> no 'updateContent' call
})

it('continues after a per-file failure', async () => {
  // make one createFile reject
  // -> the other files still sync
  // -> result.errors has one entry naming the failed path
})

it('writes the intent before a create-upload', async () => {
  // -> the journal contains an intent op before the createFile call
})

it('writes the intent before an un-trash', async () => {
  // -> the journal contains an intent op with kind 'untrash' before the untrash call
})

it('applies manifest ops only after the step succeeds', async () => {
  // make a step fail
  // -> its ops are not applied
})

it('never issues a delete call', async () => {
  // the fake records every op; assert no op outside the listed set exists
})

it('counts uploads, downloads, trashes and errors separately', async () => {
  // -> result.uploaded / .downloaded / .trashed / .errors match
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/sync.test.ts`
Expected: FAIL — `Cannot find module '../src/core/sync'`.

- [ ] **Step 3: Implement `src/drive/client.ts` and `src/core/logger.ts`**

`client.ts` holds only the interface above plus the `DriveNode` import from `types.ts`. It contains no implementation and no network calls.

`logger.ts` exports:

```ts
export interface LogEvent { at: string; level: 'info' | 'warn' | 'error'; message: string; relPath?: string }
export function createLogger(dir: string): { log(e: Omit<LogEvent,'at'>): void; events(): LogEvent[]; flush(): Promise<void> }
```

The logger appends one JSON line per event to `<dir>/app.log` and keeps the events in memory for the UI.

- [ ] **Step 4: Implement `src/core/sync.ts`**

`executePlan(plan, ctx)` runs the steps in this phase order, regardless of the order they appear in the plan:

1. `create-folder`
2. `upload`, `replace-content`, `untrash`
3. `download`, `export-native`
4. `trash`

Within a phase, steps run in plan order.

For each step:

- **Archive first, for `trash` and `replace-content`.** The archive writes the current Drive bytes to
  `<archiveDir>/<MirrorName>/<sanitized relPath>/<timestamp>-<md5prefix><ext>`.
  The `MirrorName` segment comes from the mirror's root basename. If the archive write **fails**, skip the step's Drive action entirely, record an error, and do not apply its ops. This is fail-closed.
  The `replace-content` action must also archive the **local** bytes when the action says the local side is being replaced by a download; the archive path is the same shape.
- **Write an intent before a `create-upload`.** A `upload` action appends `{ op: 'intent', kind: 'create-upload', path, driveFileId?, parentId?, localMd5, size }` to the journal and `fsync`s it **before** calling `client.createFile`. An `untrash` action appends `{ op: 'intent', kind: 'untrash', path, driveFileId }` before calling `client.untrash`.
- **Perform the Drive action**, then **apply the step's manifest ops** through `store.appendJournal(op)` for each op.
- **Isolate failures.** A rejected action is caught, recorded in `result.errors` as `{ relPath, message }`, and the run continues with the next step. The step's ops are not applied.
- **Never trash before uploads and downloads have run.** The phase ordering guarantees it.

`result.manifest` is the mirror manifest after applying every applied op.

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/sync.ts src/core/logger.ts src/drive/client.ts test/sync.test.ts test/helpers/fakeDrive.ts
git commit -m "feat(core): plan executor with fail-closed archiving and write-ahead intents"
```

---

## Task 14: The Drive REST client and resumable uploads

**Files:**
- Create: `src/drive/httpClient.ts`
- Create: `src/drive/resumable.ts`
- Test: `test/httpClient.test.ts`

**Interfaces:**
- Consumes: `DriveClient`, `DriveNode` from `client.ts` / `types.ts` (Tasks 13, 2); `buildListQuery` from `driveTree.ts` (Task 4); `canon` from `paths.ts` (Task 1).
- Produces:

```ts
export interface DriveHttpOptions {
  fetchImpl?: typeof fetch
  baseUrl?: string
}
export function createDriveClient(
  getAccessToken: () => Promise<string>,
  opts?: DriveHttpOptions,
): DriveClient

// src/drive/resumable.ts
export interface ResumableResult { fileId: string | null; verifiedByLookup: boolean }
export async function uploadResumable(
  fetchImpl: typeof fetch,
  accessToken: string,
  endpoint: string,          // 'https://www.googleapis.com/upload/drive/v3/files'
  metadata: Record<string, unknown>,
  body: Readable,
  opts: { md5: string; size: number; parentId: string; fileName: string },
): Promise<ResumableResult>
```

- [ ] **Step 1: Write the failing test**

`test/httpClient.test.ts` uses a stub `fetch` that records every request:

```ts
it('every list request carries trashed = false', async () => {
  // stub fetch returns one page
  // -> the recorded URL's q parameter contains 'trashed = false'
})

it('a batched list parenthesises its OR clause', async () => {
  // -> q === "trashed = false and ('a' in parents or 'b' in parents)"
})

it('requests pageSize 1000 and follows nextPageToken', async () => {
  // first response has nextPageToken 'tok2'
  // -> two list requests were made, the second carries pageToken=tok2
})

it('trashes with a PATCH setting trashed true, never a delete', async () => {
  // -> method 'PATCH', body { trashed: true }
  // -> no request with method 'DELETE' is ever made
})

it('untrashes with a PATCH setting trashed false', async () => {
  // -> method 'PATCH', body { trashed: false }
})

it('exports a native file through the export endpoint', async () => {
  // -> URL contains '/export?mimeType=text%2Fcsv'
})

it('downloads through alt=media', async () => {
  // -> URL contains 'alt=media'
})

it('escapes single quotes in Drive query strings', async () => {
  // a file named "Bob's.psd"
  // -> the q parameter contains "Bob\\'s.psd"
})

it('retries a 401 once after refreshing the token', async () => {
  // first response 401, second 200
  // -> two requests, and getAccessToken was called twice
})
```

Resumable tests:

```ts
it('uploads in 8 MB chunks', async () => { /* asserts Content-Range headers */ })

it('does not retry when the final chunk returns an empty body', async () => {
  // the final chunk returns 200 with an empty body
  // -> exactly one upload session was opened, and no second createFile happened
})

it('recovers the file id by matching md5 and size', async () => {
  // the final chunk returns an empty body
  // -> a list lookup happens with q matching name and parent and trashed = false
  // -> the candidate whose md5Checksum matches the uploaded md5 is chosen
})

it('does not adopt a candidate whose md5 differs', async () => {
  // -> the candidate with a different md5 is rejected; the result reports fileId null
})

it('retries the verification lookup for about five seconds', async () => { /* ... */ })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/httpClient.test.ts`
Expected: FAIL — `Cannot find module '../src/drive/httpClient'`.

- [ ] **Step 3: Implement `src/drive/httpClient.ts`**

- `listChildren(folderId)` pages through `GET /drive/v3/files?q=<buildListQuery([folderId])>&fields=id,name,mimeType,size,md5Checksum,modifiedTime,trashed,parents&pageSize=1000&pageToken=…`, following `nextPageToken` until absent. Each returned item becomes a `DriveNode` with `parentPath: ''` — the caller assembles paths.
- `getFile(fileId)` issues `GET /drive/v3/files/{id}?fields=…`; a 404 resolves `null`.
- `createFolder(name, parentId)` issues `POST /drive/v3/files` with `{ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }`.
- `createFile(...)` delegates to `uploadResumable` with endpoint `https://www.googleapis.com/upload/drive/v3/files` and metadata `{ name, parents: [parentId], mimeType }`.
- `updateContent(fileId, ...)` delegates to `uploadResumable` with endpoint `https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=resumable` and `PATCH`.
- `downloadTo(fileId, destPath)` streams `GET /drive/v3/files/{id}?alt=media` to `destPath` through a temporary file, then renames.
- `exportTo(fileId, destPath, mimeType)` streams `GET /drive/v3/files/{id}/export?mimeType=<encoded>` the same way.
- `trash(fileId)` issues `PATCH /drive/v3/files/{id}` with `{ trashed: true }`.
- `untrash(fileId)` issues `PATCH /drive/v3/files/{id}` with `{ trashed: false }`.
- A `401` triggers exactly one token refresh and one retry.
- A `403` with `rateLimitExceeded` or `userRateLimitExceeded` honours `Retry-After`, else backs off exponentially with jitter.
- A `5xx` or network error is retried up to three times.

**No code path in this file issues a `DELETE` request.**

- [ ] **Step 4: Implement `src/drive/resumable.ts`**

`uploadResumable` opens a session with `POST <endpoint>?uploadType=resumable` and a JSON metadata body, reads the `Location` header for the session URI, then `PUT`s the body in **8 MB chunks** with `Content-Range: bytes a-b/total`.

If the final response body is empty or unparseable, the function **does not re-upload**. It instead performs a verification lookup:

```
GET https://www.googleapis.com/upload/drive/v3/files
  ?q=name = '<escaped>' and '<parentId>' in parents and trashed = false
  &fields=id,name,size,md5Checksum
```

and selects the candidate whose `md5Checksum` equals the uploaded `md5` **and** whose `size` matches. It retries the lookup for about five seconds before giving up. If nothing matches, it returns `{ fileId: null, verifiedByLookup: true }` — the caller records a per-file error and the run continues. The function never opens a second upload session.

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/drive/httpClient.ts src/drive/resumable.ts test/httpClient.test.ts
git commit -m "feat(drive): REST client, resumable uploads, and null-status recovery"
```

---

## Task 15: OAuth loopback flow and credential storage

**Files:**
- Create: `src/drive/oauth.ts`
- Create: `src/main/settings.ts`
- Test: `test/oauth.test.ts`

**Interfaces:**
- Consumes: `canon` from `paths.ts` (Task 1).
- Produces:

```ts
// src/drive/oauth.ts
export interface OAuthTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
  scope: string
  token_type: string
}
export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string
export function escapeDriveQuery(value: string): string
export async function exchangeCode(
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  fetchImpl?: typeof fetch,
): Promise<OAuthTokens>
export async function refreshAccessToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl?: typeof fetch,
): Promise<{ access_token: string; expiry_date: number }>

// src/main/settings.ts
export interface Settings {
  clientId: string
  clientSecretSet: boolean
  manifestPath: string
  backupPath: string
  supersededPath: string
  guardThreshold: number
}
export interface CredentialStore {
  getClientId(): string | null
  getClientSecret(): string | null
  setCredentials(clientId: string, clientSecret: string): Promise<void>
  clear(): Promise<void>
}
export function createCredentialStore(file: string): CredentialStore
export function createSettingsStore(file: string): { read(): Promise<Settings>; write(s: Settings): Promise<void> }
```

- [ ] **Step 1: Write the failing test**

`test/oauth.test.ts`:

```ts
it('builds an auth URL with the drive scope and offline access', () => {
  const url = buildAuthUrl('CID', 'http://localhost:53219', 'st8')
  expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth')
  expect(url).toContain('scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive'))
  expect(url).toContain('access_type=offline')
  expect(url).toContain('prompt=consent')
  expect(url).toContain('redirect_uri=' + encodeURIComponent('http://localhost:53219'))
  expect(url).toContain('state=st8')
})

it('escapes single quotes and backslashes in Drive query strings', () => {
  expect(escapeDriveQuery("Bob's.psd")).toBe("Bob\\'s.psd")
  expect(escapeDriveQuery('a\\b.psd')).toBe('a\\\\b.psd')
})

it('exchanges the code for a refresh token', async () => {
  // stub fetch returns { access_token, refresh_token, expires_in, scope, token_type }
  // -> tokens.refresh_token === 'RT'
})

it('refreshes an access token', async () => {
  // stub fetch returns { access_token, expires_in }
  // -> returns { access_token: 'AT', expiry_date: <number> }
})
```

Credential-store tests assert the secret is **never** written in plain text: after `setCredentials`, the file on disk does not contain the literal secret string, and `getClientSecret()` returns it back.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/oauth.test.ts`
Expected: FAIL — `Cannot find module '../src/drive/oauth'`.

- [ ] **Step 3: Implement `src/drive/oauth.ts`**

`buildAuthUrl` produces:

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=<cid>
  &redirect_uri=<encoded>&response_type=code&scope=<encoded drive scope>
  &access_type=offline&prompt=consent&include_granted_scopes=true&state=<state>
```

`escapeDriveQuery` escapes `\` → `\\` and `'` → `\'`.

`exchangeCode` POSTs to `https://oauth2.googleapis.com/token` with `code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`. `refreshAccessToken` POSTs with `refresh_token`, `grant_type=refresh_token`.

Neither function logs or stores the secret.

- [ ] **Step 4: Implement `src/main/settings.ts`**

- `createCredentialStore(file)` stores the client id and secret **encrypted** via Electron's `safeStorage.encryptString`, base64-encoded into the file. `safeStorage.isEncryptionAvailable()` is checked first; if it is unavailable, the store throws rather than writing plaintext.
- Because `safeStorage` only exists inside Electron, `createCredentialStore` takes the `safeStorage` implementation as an injected argument so the test can supply a fake:

```ts
export function createCredentialStore(
  file: string,
  safeStorage: { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string },
): CredentialStore
```

- `createSettingsStore(file)` reads and writes `%LOCALAPPDATA%\DriveMirror\settings.json`. Defaults: `manifestPath` = `%LOCALAPPDATA%\DriveMirror\manifest.json`, `backupPath` = `E:\.drive-mirror-backup\`, `supersededPath` = `%LOCALAPPDATA%\DriveMirror\superseded\`, `guardThreshold` = 5.

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/drive/oauth.ts src/main/settings.ts test/oauth.test.ts
git commit -m "feat(auth): loopback OAuth flow and encrypted credential storage"
```

---

## Task 16: Electron main process, IPC, and the sync runner

**Files:**
- Create: `src/main/index.ts`, `src/main/window.ts`, `src/main/ipc.ts`, `src/main/runner.ts`
- Modify: `src/preload/index.ts` (create it here if not already present)
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: everything from `core/`; `createDriveClient` from `httpClient.ts`; `createCredentialStore`, `createSettingsStore` from `settings.ts`; `buildAuthUrl`, `exchangeCode`, `refreshAccessToken` from `oauth.ts`.
- Produces: the IPC contract that Task 17's renderer consumes.

```ts
// src/main/ipc.ts
export interface MirrorCard {
  name: string
  localRoot: string
  drivePath: string
  fileCount: number
  lastSyncedAt: string | null
  status: 'idle' | 'syncing' | 'skipped' | 'attention' | 'error'
  counts: { uploaded: number; updated: number; downloaded: number; trashed: number; errors: number }
}
export interface RunSummary {
  startedAt: string
  finishedAt: string
  uploaded: number
  updated: number
  downloaded: number
  trashed: number
  errors: number
  mirrors: Array<{ name: string; counts: MirrorCard['counts'] }>
  changed: Array<{ mirror: string; relPath: string; action: string }>
  reports: Report[]
}
export interface AppState {
  mirrors: MirrorCard[]
  running: boolean
  phase: string
  lastRun: RunSummary | null
  accountEmail: string | null
  needsAuth: boolean
}
export type AppEvent =
  | { type: 'state'; state: AppState }
  | { type: 'progress'; mirror: string; relPath: string; phase: string; done: number; total: number }
  | { type: 'finished'; summary: RunSummary }
  | { type: 'guard'; mirror: string; reason: string; message: string; canOverride: boolean }
  | { type: 'error'; message: string }
```

- [ ] **Step 1: Write the failing test**

`test/runner.test.ts` drives the runner against a `FakeDrive` and temp directories:

```ts
it('uploads a new local file', async () => { /* ... */ })

it('trashes a Drive file when the local file was deleted', async () => { /* ... */ })

it('skips a mirror whose root is missing and reports it', async () => { /* ... */ })

it('blocks a mirror whose volume serial changed and reports a rebase', async () => { /* ... */ })

it('emits a finished event with the five counts', async () => { /* ... */ })

it('emits nothing but a quiet summary when nothing changed', async () => {
  // -> summary.uploaded === 0 && summary.downloaded === 0 && summary.trashed === 0
  // -> no 'progress' event names a file
})

it('does not update the count baseline when a guard skips the mirror', async () => {
  // a mirror whose volume serial changed
  // -> the manifest's lastCounts for that mirror is byte-identical to what it was before the run
})

it('updates the count baseline after a Sync anyway override', async () => {
  // a mirror that tripped the count-drop guard, then ran with the override
  // -> the manifest's lastCounts reflects the post-deletion counts
})

it('writes only inside the resolved mirror folder', async () => {
  // after a run, every id the fake Drive recorded as written is a descendant of the
  // resolved mirror folder id
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/runner.test.ts`
Expected: FAIL — `Cannot find module '../src/main/runner'`.

- [ ] **Step 3: Implement `src/main/runner.ts`**

`createRunner(deps)` returns:

```ts
export interface RunnerDeps {
  client: DriveClient
  store: ManifestStore
  settings: Settings
  emit: (event: AppEvent) => void
}
export interface Runner {
  syncNow(mirrorName?: string): Promise<RunSummary>
  state(): AppState
}
```

`createRunner` runs the full pipeline for one mirror:

1. `scanLocal` the mirror root, passing the manifest's known paths so deleted files appear as `absent`.
2. **Guard 1** — root missing → emit a `guard` event, mark the mirror `skipped`, continue to the next mirror.
3. **Guard 2** — compare `fs.statSync(root).dev` with the manifest's recorded volume serial. On mismatch → emit a `guard` event with `canOverride: true`, mark the mirror `skipped`, and **do not proceed**.
4. **Guard 3** — `checkCountDrop` over the manifest's `lastCounts` and the scan's `recursiveCounts`. On a hit → emit a `guard` event naming every tripped directory, mark the mirror `skipped`, and **do not proceed**.
5. **Guard 4** — resolve the Drive folder by name under `My Drive`; more than one match → emit a `guard` event, mark the mirror `skipped`. The resolved folder id and every id beneath it is the **only** thing this run may write to; a mirror whose root cannot be resolved unambiguously writes nothing at all.
6. Build the Drive tree by BFS from the resolved folder using `buildListQuery`, page through with `client.listChildren`, and assemble with `buildDriveTree`.
7. `planExportPaths`, `buildClaimIndex`, then `diffMirror`.
8. `executePlan`.
9. Merge the resulting counts into the manifest, update `lastCounts` from the scan, set `lastSyncAt`, and checkpoint.

**Baseline update semantics (spec §8.3).** `lastCounts` is updated **only when the mirror ran to completion**. A mirror skipped by any guard keeps its previous counts untouched. This is not cosmetic: if a skipped mirror's counts were rewritten to the post-deletion values, the next run would compare `0` against `0`, would not trip, and would proceed to trash the deleted subtree — the guard would defeat itself after a single use. A mirror that ran under a **"Sync anyway"** override **does** update its counts, which is what makes the override permanent for the affected directories.

A **"Sync anyway"** override is an argument on `syncNow` that bypasses **only** Guard 3 for that mirror, and it is recorded in the summary.

- [ ] **Step 4: Implement `src/main/window.ts`, `src/main/ipc.ts`, `src/main/index.ts`**

- `window.ts` creates the `BrowserWindow` at 1180×760 with `titleBarStyle: 'default'`, `backgroundColor: '#1b1b1f'`, and `webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }`. It loads `src/renderer/index.html` in dev and `out/renderer/index.html` in production, and follows the OS theme.
- `ipc.ts` registers handlers for:

```
drive-mirror:get-state        -> AppState
drive-mirror:sync-now         (mirrorName?: string) -> RunSummary
drive-mirror:override-guard   (mirrorName: string) -> RunSummary
drive-mirror:rebase           (mirrorName: string) -> void
drive-mirror:get-settings    -> Settings
drive-mirror:save-settings    (partial: Partial<Settings>) -> Settings
drive-mirror:set-credentials  (clientId: string, clientSecret: string) -> { ok: boolean }
drive-mirror:authenticate     -> { ok: boolean; email?: string }
drive-mirror:sign-out         -> void
drive-mirror:open-log-folder  -> void
drive-mirror:show-manifest    -> void
drive-mirror:reveal-superseded -> void
drive-mirror:prune-superseded -> { freedBytes: number }
```

- `index.ts` acquires the single-instance lock, creates the window, registers IPC, and starts the loopback OAuth server on an ephemeral port when `authenticate` is called. The server is closed immediately after the callback.

- [ ] **Step 5: Implement `src/preload/index.ts`**

```ts
export interface DriveMirrorApi {
  getState(): Promise<AppState>
  syncNow(mirrorName?: string): Promise<RunSummary>
  overrideGuard(mirrorName: string): Promise<RunSummary>
  rebase(mirrorName: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  setCredentials(clientId: string, clientSecret: string): Promise<{ ok: boolean }>
  authenticate(): Promise<{ ok: boolean; email?: string }>
  signOut(): Promise<void>
  openLogFolder(): Promise<void>
  showManifest(): Promise<void>
  revealSuperseded(): Promise<void>
  pruneSuperseded(): Promise<{ freedBytes: number }>
  onEvent(cb: (event: AppEvent) => void): () => void
}
```

`contextBridge.exposeInMainWorld('driveMirror', api)` — only those members, each wrapped so a rejected promise becomes a rejected promise rather than an unhandled rejection.

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck` then `npm test`
Expected: typecheck clean; every test PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main src/preload test/runner.test.ts
git commit -m "feat(app): Electron main process, IPC bridge, and sync runner"
```

---

## Task 17: The renderer UI

**Files:**
- Create: `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`
- Create: `src/renderer/components/FolderCard.tsx`, `SummaryBar.tsx`, `ProgressPanel.tsx`, `LogView.tsx`, `SettingsDialog.tsx`, `GuardBanner.tsx`

**Interfaces:**
- Consumes: `DriveMirrorApi`, `AppState`, `AppEvent`, `MirrorCard`, `RunSummary`, `Settings` from the preload bridge (Task 16).
- Produces: the `window.driveMirror` global typed as `DriveMirrorApi`.

- [ ] **Step 1: Write the build and typecheck verification**

There is no component test suite. The verification for this task is that the renderer compiles and renders the four cards. Add to `src/renderer/main.tsx`:

```ts
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 2: Implement the renderer**

`App.tsx` holds the state, subscribes to events, and lays out the window:

```tsx
export function App(): JSX.Element
```

It renders, top to bottom: a header with the app name, the signed-in account, a **Settings** button, and the **Sync now** button; a row of four `FolderCard`s in a responsive grid; a `GuardBanner` slot below the cards when a guard fires; a `ProgressPanel` while a run is in progress; and a `SummaryBar` with the last run's five counts plus an expandable `LogView`.

`FolderCard` props:

```tsx
export interface FolderCardProps {
  mirror: MirrorCard
  onSync: (name: string) => void
}
```

It shows the mirror name, the local root, the Drive destination, the live file count, the relative last-synced time, the status chip, and the five last-run counts.

`SummaryBar` shows `Uploaded`, `Updated`, `Downloaded`, `Trashed`, `Errors`. When all five are zero it renders the muted line **"Everything is up to date — no changes."** and **no modal, toast, sound, or scroll change**.

`ProgressPanel` shows the overall bar plus the current file and a running total.

`GuardBanner` props:

```tsx
export interface GuardBannerProps {
  guard: { mirror: string; reason: string; message: string; canOverride: boolean }
  onOverride: (mirror: string) => void
  onRebase: (mirror: string) => void
  onDismiss: () => void
}
```

`canOverride` shows a **"Sync anyway"** button; the volume-changed reason shows a **"Re-approve E:"** button instead.

`SettingsDialog` shows the client id and a masked secret field, a **"Test connection"** button, the manifest / backup / superseded paths, and the **Minimum files before the guard applies** number input defaulting to 5. The secret is only sent to the main process and is never read back into the UI.

`LogView` lists the run's changed files and reports, grouped by mirror.

- [ ] **Step 3: Write `src/renderer/index.html` and `src/renderer/styles.css`**

`index.html` declares `<div id="root">`, sets `lang="en"`, and loads `/main.tsx`.

`styles.css` defines light and dark themes via `prefers-color-scheme`, using the Win11 accent `#0067C0`, a 4px–8px corner radius, and the system font stack. The body has no scroll jump: the summary area reserves its height so an expanding log does not shift the cards.

- [ ] **Step 4: Verify the renderer builds and the app launches**

Run: `npm run typecheck` then `npm run build`
Expected: typecheck clean; `electron-vite build` produces `out/main/index.js`, `out/preload/index.js`, and `out/renderer/index.html`.

Then run `npm run dev` and confirm the window opens showing four cards named `Medicine`, `graphicDesign`, `videoEditing`, `whoami`, each with a file count of 43, 43, 113, and 55 respectively, and a **Sync now** button. Close the window afterwards.

- [ ] **Step 5: Commit**

```bash
git add src/renderer
git commit -m "feat(ui): renderer with folder cards, progress, summary, and guard banner"
```

---

## Task 18: Packaging and the live smoke test

**Files:**
- Create: `electron-builder.yml`
- Create: `README.md`
- Modify: `package.json` (add the `build` key)

**Interfaces:**
- Consumes: everything from Tasks 1–17.
- Produces: a packaged `.exe` and a verified live sync against the user's real Drive.

- [ ] **Step 1: Write `electron-builder.yml`**

```yaml
appId: com.drivemirror.app
productName: Drive Mirror
directories:
  output: dist
  buildResources: build
files:
  - out/**/*
  - package.json
win:
  target:
    - target: nsis
      arch: [x64]
  artifactName: Drive-Mirror-${version}-Setup.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: Drive Mirror
```

Add to `package.json`:

```json
"build": { "extends": null }
```

(electron-builder reads `electron-builder.yml` from the project root by default, so no `build` key is strictly needed; add it only if the CLI does not pick the file up.)

- [ ] **Step 2: Write `README.md`**

Cover: what the app does, the four mirrors, the OAuth setup steps (create a **Desktop app** OAuth client, enable the Google Drive API, set the consent screen to **In production**, paste the client id and secret into Settings), where the manifest and logs live, what the four guards do, and how to recover a file (Drive Trash holds it for 30 days).

State plainly: **the OAuth client secret is entered in the app and stored encrypted with DPAPI on this machine; it is never written to the repository.** Add the secret's file name to `.gitignore` if it was ever copied into the project.

- [ ] **Step 3: Build and package**

Run: `npm run typecheck` then `npm test` then `npm run dist`
Expected: typecheck clean; every test PASS; `dist\Drive-Mirror-1.0.0-Setup.exe` exists.

- [ ] **Step 4: Run the live smoke test**

Set the environment and run a single-mirror sync against the real Drive:

```bash
DRIVE_MIRROR_CLIENT_ID=429010975839-tud3c8c7fl9i91ieo7u2upk0os4np6eg.apps.googleusercontent.com \
DRIVE_MIRROR_CLIENT_SECRET=<your client secret> \
npm run dev
```

In the app: open **Settings**, confirm the client id and secret are populated, press **"Test connection"**, complete the browser sign-in, then press **Sync now** on **Medicine** only.

Verify, in order:

1. The sign-in completes and the account email appears in the header.
2. The first sync reports the two mirrors' Drive folders being created or adopted, and the file counts settle at 43 for `Medicine`.
3. `My Drive/Medicine` in the browser contains the expected folder structure, with **43 files** and the correct subfolder names `incision` and `researchs`.
4. Running **Sync now** a second time reports **"Everything is up to date — no changes."** and changes nothing.
5. Delete one file from `E:\Medicine`, sync again, and confirm the summary shows `Trashed 1` and that the file is in the Drive Trash — **not** deleted.
6. Restore that file from the Drive Trash in the browser, sync again, and confirm the app **reports** the restore but **does not** re-download it into `E:\Medicine` (§13 item 5).
7. Delete the restored file from `E:\Medicine` again and sync, confirming the manifest now treats it as a fresh local deletion.

**If any step behaves differently from the spec, stop and fix the code before continuing.** Do not proceed to the next step on a failing check.

- [ ] **Step 5: Verify the guards manually**

- Temporarily rename `E:\Medicine` to `E:\Medicine-moved`, press **Sync now**, and confirm the app **skips** the mirror and reports it rather than trashing the Drive copy. Restore the name.
- Confirm `E:\.drive-mirror-backup\` contains a copy of `manifest.json` after a run.

- [ ] **Step 6: Commit**

```bash
git add electron-builder.yml README.md package.json .gitignore
git commit -m "build: package the Windows installer and document setup"
```

- [ ] **Step 7: Report the result**

State plainly which of the seven live checks passed, which did not, and what the manifest and log locations are. Do not claim the app works if any check failed.

---

## Self-Review

**Spec coverage.** Every section of the spec maps to tasks: §5.1–§5.5 → Tasks 2, 12; §6.1–§6.8 → Tasks 6–11; §7 → Task 13; §8 → Tasks 12, 16; §9 → Tasks 14, 15; §10 → Task 17; §11 → Tasks 3–14; §13's approved decisions → Global Constraints. §12's risk table is addressed by: the trashed-file filter (Task 4), the global retired-id check (Task 9), the `rebased` release (Tasks 9, 12), the three-state local tree (Task 3), the distinct `trashed`/`trashed-externally` states (Tasks 7, 8), the native guards (Tasks 10, 11), the `drive-wins` inversion (Task 9), the B4 probe (Task 7), the write-ahead intents (Task 13), the md5-matched upload verification (Task 14), the archive fail-closed rule (Task 13), and the `lastCounts` baseline semantics (Task 12).

**Step scan.** No step says "handle edge cases" or names an undefined function. Every code step names an exact file and either a signature or the values it must produce. Where the spec pins an algorithm — the dispatch order, the guard's trip condition, the export-path planner's candidate order — the plan gives the algorithm.

**Type consistency.** `LiveEntry`, `RetiredRecord`, `MirrorManifest` and `Manifest` are defined once in Task 2 and used verbatim thereafter. `DriveFile` / `DriveNode` / `DriveTree` are defined in Task 2 and consumed in Tasks 4, 5, 6. `SyncAction`, `PlanStep`, `SyncPlan`, `ProbeResult`, `DiffIo` and `DiffInput` are defined in Task 6 and used in Tasks 7–11 and 13. `DriveClient` is defined in Task 13 and implemented in Task 14. `MirrorCard`, `RunSummary`, `AppState`, `AppEvent` are defined in Task 16 and consumed in Task 17. `Settings` and `CredentialStore` are defined in Task 15 and consumed in Tasks 16, 17.

**Review Focus.** All five lines are pinned: line 1 by Task 4's `listing.test.ts` and Task 11; line 2 by Task 3's `localScan.test.ts` and Task 7's B0 guard test; line 3 by Task 9's R1/R2 tests; line 4 by Task 12's `checkVolumeFingerprint` test and Task 18's manual guard check; line 5 by Task 6's E1 test and Task 11's INV-2.

**Proportion.** The plan is roughly the same length as the spec's normative sections. It carries signatures, test names, and pinned values — not implementations. The only bodies included are ones where the spec fixes the exact output (the listing query string, the auth URL shape, the electron-builder YAML), because those are wire formats and config, not logic.
