# Drive Mirror v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Drive Mirror from a tool hardcoded to one person's four `E:` folders into a public, general app: the user picks their own folders, the app syncs on a schedule, the app has a real icon, and the user can clear and replace the Google connection.

**Architecture:** The core (`src/core/`) stays free of Electron and of the network. New pure modules — `mirrorConfig.ts`, `schedule.ts`, `drivePath.ts` — hold the logic that can be tested without a screen. Everything the user configures lives in `settings.json` (configuration); everything the app has observed lives in `manifest.json` (history) and is never destroyed by a configuration change. The manifest gains an account binding so a Google account switch can be detected and blocked instead of silently producing a broken mirror.

**Tech Stack:** Electron 44.9.2, React 19.3.1, TypeScript 5.9.3, electron-vite 6.0.0, electron-builder 26.15.3, Vitest 5.0.5. No new runtime dependencies. Windows only.

**Spec:** `docs/superpowers/specs/2026-10-21-drive-mirror-v2-design.md`

---

## Global Constraints

- Nothing is ever permanently deleted from Drive. Trash only.
- Nothing is ever written to a Drive location outside a configured mirror's `drivePath`.
- The manifest is never destroyed by a connection reset, an account change, or an uninstall.
- A failed backup write never fails a sync.
- No test ever writes to a path outside its own temp directory.
- No literal `E:` appears in `src/` after Task 5.
- The mirror list is configuration and lives in `settings.json`. The manifest is history and lives in `manifest.json`. Changing one never touches the other.
- A mirror's `name` is the manifest key. Names are unique case-insensitively. The manifest is **not** re-keyed.
- A removed mirror is forgotten entirely 30 days after removal, retired records included. This is the one carve-out from the base spec's never-prune rule.
- New core modules import nothing from `electron` and nothing from `node:`.
- Every task ends with a commit. Commits are small and each one leaves the tree green.

## Review Focus

Five input classes the spec implies but no single task's tests obviously cover. Each line is pinned to a task's test step below.

1. **A mirror's Drive destination already exists as a file, not a folder** (e.g. someone made a file called `Photos`). → reported as an error, the mirror is skipped, nothing is clobbered. → Task 6.
2. **A scheduled run firing as the app is closing, or while the machine was asleep.** → no double run, no silently lost run, the next slot still fires. → Task 11.
3. **A Drive file the user deleted by hand, outside the app.** → treated as gone, never re-uploaded as a duplicate, and never trashed. → Task 6.
4. **Two mirrors whose names differ only by case** (`Docs` and `docs`). → refused at add time as a duplicate. → Task 2.
5. **A deeply nested Drive destination** (`Archive/2026/Photos`). → intermediate folders are created parents-first, and a failure at any level leaves the ones already created harmless. → Task 6.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/core/mirrorConfig.ts` | The `MirrorConfig` type, the pre-seeded defaults, and every validation rule for adding a mirror. Pure. |
| `src/core/schedule.ts` | `ScheduleShape`, `ScheduleConfig`, `nextFireAt`, `isRunMissed`. Pure. |
| `src/core/drivePath.ts` | `resolveMirrorPath`, `driveFolderNameOf`, `splitDrivePath`, `isValidDrivePath`. Talks to a `DriveClient`, nothing else. |
| `src/main/taskScheduler.ts` | Builds and runs the `schtasks.exe` commands. The only file that knows Windows Task Scheduler exists. |
| `src/main/scheduler.ts` | The in-app timer, the resume hook, and the `--sync-once` entry point. |
| `src/main/notice.ts` | Writes and clears `pendingNotice`. |
| `src/renderer/components/AddMirrorDialog.tsx` | The add/edit mirror form. |
| `src/renderer/components/SchedulePanel.tsx` | The schedule settings. |
| `src/renderer/components/SetupWizard.tsx` | The first-run OAuth guide. |
| `src/renderer/components/RecoveredPanel.tsx` | The "Download to E:" list. |
| `build/icon.ico`, `build/icon.png` | The app icon. |
| `build/installer.nsh` | The NSIS macro that removes the scheduled task on uninstall. |

**Modified files**

| File | Change |
|---|---|
| `src/main/settings.ts` | New `Settings` shape; atomic write; deep merge; `defaultSettings()`. |
| `src/core/types.ts` | `Manifest.accountEmail`, `MirrorManifest.drivePath`, `ProgressEvent` counters. |
| `src/core/manifest.ts` | `MANIFEST_VERSION` 10 → 11; read a v10 manifest. |
| `src/core/sync.ts` | Progress events carry real counters. |
| `src/main/runner.ts` | Single-flight guard; `try`/`finally`; mirrors from settings; destination path; account check; `downloadRestored`; `removeMirror`; `setMirrorDestination`; `pruneRemovedMirrors`. |
| `src/main/index.ts` | `--sync-once`; `app.setAppUserModelId`; the scheduler; the account email; `autoLaunch`. |
| `src/main/ipc.ts` | The new channels. |
| `src/preload/index.ts` | The new methods, including `openExternal`. |
| `src/drive/client.ts` | `moveFolder`, `getAccountEmail`. |
| `src/drive/httpClient.ts` | The two new calls. |
| `src/renderer/App.tsx` | The add-folder button, the new panels. |
| `src/renderer/components/FolderCard.tsx` | The pause toggle, the edit and remove actions. |
| `src/renderer/components/SettingsDialog.tsx` | The schedule, the backups, the connection section. |
| `electron-builder.yml` | `win.icon`, `extraResources`, `nsis.include`. |
| `test/helpers/fakeDrive.ts` | The two new client methods. |

---

### Task 1: The settings store, rebuilt

The mirror list, the schedule, the backup copies and the pending notice all live in `settings.json`. Today it is written with a plain `writeFile` and read back with a shallow spread, which cannot carry a list safely.

**Files:**
- Modify: `src/main/settings.ts:19-67` (the `Settings` type and `defaultSettings`), `src/main/settings.ts:137-170` (the store)
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface MirrorConfig {
    name: string
    root: string
    drivePath: string
    enabled: boolean
    removedAt?: string
  }
  export type ScheduleShape =
    | { kind: 'every-hours'; everyHours: number }
    | { kind: 'daily'; at: string }
    | { kind: 'every-days'; everyDays: number }
    | { kind: 'weekly'; day: number; at: string }
  export interface ScheduleConfig {
    enabled: boolean
    shape: ScheduleShape
    mechanism: 'in-app' | 'windows-task'
    lastRunAt: string | null
    nextRunAt: string | null
  }
  export interface Settings {
    clientId: string
    clientSecretSet: boolean
    manifestPath: string
    backupPaths: string[]
    supersededPath: string
    guardThreshold: number
    mirrors: MirrorConfig[]
    schedule: ScheduleConfig
    startWithWindows: boolean
    pendingNotice: { message: string; at: string } | null
  }
  export function appDataDir(): string
  export function defaultSettings(): Settings
  export function createSettingsStore(file: string): {
    read(): Promise<Settings>
    write(s: Settings): Promise<void>
    patch(patch: Partial<Settings>): Promise<Settings>
  }
  ```

- [ ] **Step 1: Write the failing test**

  `test/settings.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { createSettingsStore, defaultSettings } from '../src/main/settings'

  describe('the settings store', () => {
    it('returns the defaults when there is no file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
      const store = createSettingsStore(join(dir, 'settings.json'))
      const s = await store.read()
      expect(s.mirrors).toEqual([])
      expect(s.schedule.enabled).toBe(false)
      expect(s.schedule.mechanism).toBe('in-app')
      expect(s.backupPaths.length).toBeGreaterThan(0)
      expect(s.startWithWindows).toBe(false)
      expect(s.pendingNotice).toBeNull()
    })

    it('keeps every field through a round trip', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
      const file = join(dir, 'settings.json')
      const store = createSettingsStore(file)
      const s = defaultSettings()
      s.mirrors = [{ name: 'Docs', root: 'D:\\Docs', drivePath: 'Docs', enabled: true }]
      s.schedule = { enabled: true, shape: { kind: 'daily', at: '02:00' }, mechanism: 'in-app', lastRunAt: null, nextRunAt: null }
      await store.write(s)
      const back = await store.read()
      expect(back.mirrors).toEqual(s.mirrors)
      expect(back.schedule).toEqual(s.schedule)
    })

    it('merges a patch without losing the fields it does not mention', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
      const store = createSettingsStore(join(dir, 'settings.json'))
      const s = defaultSettings()
      s.mirrors = [{ name: 'Docs', root: 'D:\\Docs', drivePath: 'Docs', enabled: true }]
      await store.write(s)
      const next = await store.patch({ startWithWindows: true })
      expect(next.startWithWindows).toBe(true)
      expect(next.mirrors).toHaveLength(1)
    })

    it('writes atomically, so a half-written file is never left behind', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
      const file = join(dir, 'settings.json')
      const store = createSettingsStore(file)
      await store.write(defaultSettings())
      const text = await readFile(file, 'utf8')
      expect(text.endsWith('\n')).toBe(false)
      expect(JSON.parse(text).guardThreshold).toBe(defaultSettings().guardThreshold)
    })

    it('falls back to the defaults when the file is damaged', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
      const file = join(dir, 'settings.json')
      await writeFile(file, '{ not json', 'utf8')
      const store = createSettingsStore(file)
      const s = await store.read()
      expect(s.guardThreshold).toBe(defaultSettings().guardThreshold)
    })
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/settings.test.ts`
  Expected: FAIL — `createSettingsStore` has no `patch`, and `Settings` has no `mirrors`.

- [ ] **Step 3: Implement the new `Settings` and the store in `src/main/settings.ts`**

  Replace the `Settings` interface with the one in the Interfaces block. `defaultSettings()` returns:

  ```ts
  {
    clientId: '',
    clientSecretSet: false,
    manifestPath: join(dir, 'manifest.json'),
    backupPaths: [join(dir, 'backups')],
    supersededPath: join(dir, 'superseded'),
    guardThreshold: 5,
    mirrors: [],
    schedule: {
      enabled: false,
      shape: { kind: 'every-hours', everyHours: 6 },
      mechanism: 'in-app',
      lastRunAt: null,
      nextRunAt: null,
    },
    startWithWindows: false,
    pendingNotice: null,
  }
  ```

  `createSettingsStore` writes atomically: write to `file + '.tmp'`, then `rename` over `file`. `patch(patch)` reads, spreads, writes, and returns the new settings. `read()` keeps returning the defaults when the file is missing or unreadable.

  **Two rules from spec §12 A11:**
  - `write()` and `patch()` **strip `clientId` before writing**. The client id lives only in `credentials.json`; `Settings.clientId` is a read-only projection of it. `src/main/index.ts`'s `currentSettings()` is where the value comes from.
  - `read()` **migrates the old shape**: a file that has `backupPath` but no `backupPaths` becomes `backupPaths = [join(appDataDir(), 'backups'), oldBackupPath]`, de-duplicated. This is how the author's own `E:\.drive-mirror-backup\` safety net survives the upgrade without a literal `E:` in the source.

  Add a test for the migration:

  ```ts
  it('keeps the old backup path when the settings file is upgraded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(file, JSON.stringify({ backupPath: 'E:\\.drive-mirror-backup\\' }), 'utf8')
    const s = await createSettingsStore(file).read()
    expect(s.backupPaths).toContain('E:\\.drive-mirror-backup\\')
    expect(s.backupPaths[0]).toContain('backups')
  })
  ```

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/settings.test.ts`
  Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite to check nothing broke**

  Run: `npm test`
  Expected: PASS. `test/oauth.test.ts` asserts `settings.backupPath` contains `.drive-mirror-backup` — that assertion is **changed in this task** to assert `settings.backupPaths` is a non-empty array of strings.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/settings.ts test/settings.test.ts test/oauth.test.ts
  git commit -m "feat(settings): carry the mirror list, the schedule and the backup copies"
  ```

---

### Task 2: Mirror configuration and its rules

**Files:**
- Create: `src/core/mirrorConfig.ts`
- Test: `test/mirrorConfig.test.ts`

**Interfaces:**
- Consumes: `MirrorConfig` from `src/main/settings.ts` (Task 1). Because `src/core/` must not import from `src/main/`, **`MirrorConfig` is declared in `src/core/mirrorConfig.ts` and `src/main/settings.ts` re-exports it.** Move the interface in this task and add the re-export.
- Produces:
  ```ts
  export interface MirrorConfig {
    name: string
    root: string
    drivePath: string
    enabled: boolean
    removedAt?: string
  }
  export interface MirrorProblem { field: 'name' | 'root' | 'drivePath'; message: string }
  export function defaultMirrors(): MirrorConfig[]
  export function isValidMirrorName(name: string): boolean
  export function isValidDrivePath(drivePath: string): boolean
  export function overlaps(rootA: string, rootB: string): boolean
  export function validateMirror(
    candidate: { name: string; root: string; drivePath: string },
    existing: MirrorConfig[],
  ): MirrorProblem[]
  export function suggestDrivePath(name: string): string
  ```

- [ ] **Step 1: Write the failing test**

  `test/mirrorConfig.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { defaultMirrors, isValidDrivePath, isValidMirrorName, overlaps, suggestDrivePath, validateMirror } from '../src/core/mirrorConfig'

  describe('mirror configuration', () => {
    it('seeds the four trees the app was built for', () => {
      const mirrors = defaultMirrors()
      expect(mirrors.map((m) => m.name)).toEqual(['Medicine', 'graphicDesign', 'videoEditing', 'whoami'])
      expect(mirrors.every((m) => m.enabled)).toBe(true)
      expect(mirrors[0]!.drivePath).toBe('Medicine')
    })

    it('refuses a name that differs only by case from an existing one', () => {
      const existing = [{ name: 'Docs', root: 'D:\\Docs', drivePath: 'Docs', enabled: true }]
      const problems = validateMirror({ name: 'docs', root: 'E:\\Other', drivePath: 'docs' }, existing)
      expect(problems.map((p) => p.field)).toContain('name')
    })

    it('refuses a root that sits inside another mirror', () => {
      const existing = [{ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs', enabled: true }]
      const problems = validateMirror({ name: 'Notes', root: 'E:\\Docs\\Notes', drivePath: 'Notes' }, existing)
      expect(problems.map((p) => p.field)).toContain('root')
    })

    it('refuses a root that contains another mirror', () => {
      const existing = [{ name: 'Notes', root: 'E:\\Docs\\Notes', drivePath: 'Notes', enabled: true }]
      const problems = validateMirror({ name: 'Docs', root: 'E:\\Docs', drivePath: 'Docs' }, existing)
      expect(problems.map((p) => p.field)).toContain('root')
    })

    it('does not treat a sibling folder as an overlap', () => {
      expect(overlaps('E:\\Docs', 'E:\\Docs2')).toBe(false)
      expect(overlaps('E:\\Docs', 'E:\\Docs\\Notes')).toBe(true)
      expect(overlaps('E:\\Docs\\Notes', 'E:\\Docs')).toBe(true)
    })

    it('refuses a Drive path with an empty segment or a dot dot', () => {
      expect(isValidDrivePath('Photos')).toBe(true)
      expect(isValidDrivePath('Archive/2026/Photos')).toBe(true)
      expect(isValidDrivePath('')).toBe(false)
      expect(isValidDrivePath('/Photos')).toBe(false)
      expect(isValidDrivePath('Photos/')).toBe(false)
      expect(isValidDrivePath('Photos//Archive')).toBe(false)
      expect(isValidDrivePath('../Photos')).toBe(false)
    })

    it('refuses a name with a character Windows cannot use in a folder name', () => {
      expect(isValidMirrorName('My Photos')).toBe(true)
      expect(isValidMirrorName('a/b')).toBe(false)
      expect(isValidMirrorName('a:b')).toBe(false)
      expect(isValidMirrorName('')).toBe(false)
    })

    it('suggests a Drive path from the name', () => {
      expect(suggestDrivePath('Photos')).toBe('Photos')
      expect(suggestDrivePath('Archive/Photos')).toBe('Archive/Photos')
    })
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/mirrorConfig.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/core/mirrorConfig.ts`**

  `isValidMirrorName` rejects the empty string, `.` and `..`, and any of `< > : " / \ | ? *` plus the control characters 0–31. `isValidDrivePath` splits on `/` and requires every segment to be non-empty, to contain no `\`, no `.` or `..`, and no illegal filename characters.

  `overlaps(a, b)` normalises both roots to forward slashes, lowercases them, strips a trailing slash, and then tests whether `a` starts with `b + '/'` or `b` starts with `a + '/'`. A path that equals the other is an overlap.

  `validateMirror(candidate, existing)` returns an array of problems — empty means valid. It checks the name against `isValidMirrorName`, checks the name against every existing mirror's name case-insensitively, checks the root against every existing root with `overlaps`, and checks `drivePath` with `isValidDrivePath`.

  `defaultMirrors()` returns the four trees with their roots, `drivePath` equal to the name, and `enabled: true`.

  In `src/main/settings.ts`, delete the local `MirrorConfig` interface and add `export type { MirrorConfig } from '../core/mirrorConfig'`.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/mirrorConfig.test.ts`
  Expected: PASS, 8 tests.

- [ ] **Step 5: Run the type check**

  Run: `npm run typecheck`
  Expected: clean. `Settings.mirrors` now refers to the re-exported type.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/mirrorConfig.ts src/main/settings.ts test/mirrorConfig.test.ts
  git commit -m "feat(mirrors): the rules for which folders can be mirrored"
  ```

---

### Task 3: The manifest gains an account and a destination

**Files:**
- Modify: `src/core/types.ts:124-156`, `src/core/manifest.ts:27-64`
- Test: `test/manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Manifest {
    version: number          // 11
    updatedAt: string
    volumes: Record<string, { dev: number; label?: string; checkedAt: string }>
    mirrors: Record<string, MirrorManifest>
    accountEmail: string | null
  }
  export interface MirrorManifest {
    root: string
    drivePath?: string
    driveFolderId?: string
    driveFolderName?: string
    lastSyncAt?: string
    lastCounts: Record<string, number>
    rebase: { pending: boolean; mergePolicy: 'local-wins' | 'drive-wins' } | null
    dirs: Record<string, { driveFolderId: string }>
    files: Record<string, LiveEntry>
    retired: Record<string, RetiredRecord>
  }
  export const MANIFEST_VERSION: number   // 11
  ```

- [ ] **Step 1: Write the failing test**

  Add to `test/manifest.test.ts`:

  ```ts
  it('reads a version 10 manifest and keeps every mirror in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-manifest-'))
    const file = join(dir, 'manifest.json')
    await writeFile(file, JSON.stringify({
      version: 10,
      updatedAt: '2026-01-01T00:00:00.000Z',
      volumes: {},
      mirrors: { Medicine: { root: 'E:\\Medicine', lastCounts: { '': 43 }, rebase: null, dirs: {}, files: {}, retired: {} } },
    }), 'utf8')
    const store = createManifestStore(dir)
    const m = await store.read()
    expect(m.mirrors.Medicine?.root).toBe('E:\\Medicine')
    expect(m.accountEmail).toBeNull()
  })

  it('writes version 11', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-manifest-'))
    const store = createManifestStore(dir)
    const m = await store.read()
    expect(m.version).toBe(11)
    expect(m.accountEmail).toBeNull()
  })

  it('keeps the account through a round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-manifest-'))
    const store = createManifestStore(dir)
    const m = await store.read()
    m.accountEmail = 'someone@example.com'
    await store.write(m)
    expect((await store.read()).accountEmail).toBe('someone@example.com')
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/manifest.test.ts`
  Expected: FAIL — `version` is 10 and `accountEmail` does not exist.

- [ ] **Step 3: Implement the changes in `src/core/types.ts` and `src/core/manifest.ts`**

  Add `accountEmail: string | null` to `Manifest` and `drivePath?: string` to `MirrorManifest`. Set `MANIFEST_VERSION = 11`. `emptyManifest()` returns `accountEmail: null`. `read()` in `createManifestStore` merges the parsed file over the defaults, so a version 10 file read by a version 11 build gains `accountEmail: null` and keeps every mirror.

  `test/manifest.test.ts` has an assertion `expect(emptyManifest().version).toBe(10)` — **change it to 11**.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/manifest.test.ts`
  Expected: PASS.

- [ ] **Step 5: Run the whole suite**

  Run: `npm test`
  Expected: FAIL in `test/exhaustiveness.test.ts` if it pins the version. Fix the pin to 11 — but **read the failure first**; do not change the invariant being checked.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/types.ts src/core/manifest.ts test/manifest.test.ts
  git commit -m "feat(manifest): record the Google account and the Drive destination"
  ```

---

### Task 4: Backups that cannot fail a sync, and cannot eat the user's backup

This fixes **B1**: the test suite currently overwrites the real backup at `E:\.drive-mirror-backup\manifest.json`.

**Files:**
- Modify: `src/main/runner.ts:492-500` (`writeBackup`)
- Test: `test/backup.test.ts`

**Interfaces:**
- Consumes: `Settings.backupPaths` (Task 1).
- Produces:
  ```ts
  // src/main/runner.ts
  export async function writeBackups(
    paths: string[],
    manifest: Manifest,
    log?: (message: string) => void,
  ): Promise<{ written: string[]; failed: string[] }>
  ```

- [ ] **Step 1: Write the failing test**

  `test/backup.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import { emptyManifest } from '../src/core/manifest'
  import { writeBackups } from '../src/main/runner'

  describe('writing the backup', () => {
    it('writes a copy to every path it is given', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
      const a = join(dir, 'a'); const b = join(dir, 'b')
      const result = await writeBackups([a, b], emptyManifest())
      expect(result.failed).toEqual([])
      expect(result.written).toHaveLength(2)
      expect(JSON.parse(await readFile(join(a, 'manifest.json'), 'utf8')).version).toBe(11)
    })

    it('does not throw when a path cannot be written, and still writes the others', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
      const bad = join(dir, 'nope', 'deep', 'deeper')
      const good = join(dir, 'good')
      const result = await writeBackups([bad, good], emptyManifest())
      expect(result.failed).toEqual([bad])
      expect(result.written).toEqual([good])
    })

    it('never writes outside the paths it was given', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dm-backup-'))
      const result = await writeBackups([join(dir, 'one')], emptyManifest())
      expect(result.written.every((p) => p.startsWith(dir))).toBe(true)
    })
  })
  ```

  And in `test/runner.test.ts`, change the store's settings so the backup path is inside the test's temp directory:

  ```ts
  const settings = { ...defaultSettings(), backupPaths: [join(dir, 'backup')] }
  ```

  Then add this guard test to `test/runner.test.ts`:

  ```ts
  it('writes the backup inside the test directory and nowhere else', async () => {
    const box = await makeBox()
    await runner.syncNow()
    const written = await readdir(join(box.dir, 'backup'))
    expect(written).toContain('manifest.json')
    expect(box.dir).toContain('dm-runner-')
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/backup.test.ts`
  Expected: FAIL — `writeBackups` does not exist.

- [ ] **Step 3: Implement `writeBackups` in `src/main/runner.ts`**

  Replace `writeBackup` with:

  ```ts
  export async function writeBackups(
    paths: string[],
    manifest: Manifest,
    log?: (message: string) => void,
  ): Promise<{ written: string[]; failed: string[] }> {
    const written: string[] = []
    const failed: string[] = []
    for (const path of paths) {
      try {
        await mkdir(path, { recursive: true })
        await writeFile(
          join(path, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
          'utf8',
        )
        written.push(path)
      } catch (err) {
        failed.push(path)
        log?.(`the backup copy at ${path} could not be written: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { written, failed }
  }
  ```

  The two call sites in `runner.ts` (lines 416 and 457) become `await writeBackups(deps.settings.backupPaths, manifest, ...)`. **Neither call site may throw.**

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/backup.test.ts test/runner.test.ts`
  Expected: PASS.

- [ ] **Step 5: Prove the old bug is gone**

  Run: `npm test`
  Expected: PASS. Then confirm the real backup is untouched:

  ```bash
  node -e "const m=require('fs').readFileSync(process.env.LOCALAPPDATA+'/../Local/DriveMirror/manifest.json','utf8');console.log('app manifest ok')"
  ```

  And check that `E:\.drive-mirror-backup\manifest.json` no longer changes when the tests run: record its timestamp, run `npm test`, compare.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/runner.ts test/backup.test.ts test/runner.test.ts
  git commit -m "fix(backup): a backup that cannot be written never fails a sync"
  ```

---

### Task 5: The runner gets a mutex, survives errors, and stops assuming `E:`

Fixes **B2**, **B3** and **B4**.

**Files:**
- Modify: `src/main/runner.ts:419-465` (`syncNow`), `src/main/runner.ts:517-521` (`driveLetterOf`)
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // src/main/runner.ts
  export function driveLetterOf(root: string): string | null   // null when there is no drive letter
  ```

- [ ] **Step 1: Write the failing test**

  Add to `test/runner.test.ts`:

  ```ts
  it('runs once when two syncs are asked for at the same time', async () => {
    const box = await makeBox()
    const drive = new FakeDrive()
    let calls = 0
    const counting = { listChildren: (...a: Parameters<FakeDrive['listChildren']>) => { calls++; return drive.listChildren(...a) } }
    // simpler: count uploads instead
    const [a, b] = await Promise.all([runner.syncNow(), runner.syncNow()])
    expect(a.uploaded).toBe(b.uploaded)
    expect(a.uploaded).toBe(1)
  })

  it('does not stay stuck on syncing after a failure', async () => {
    const box = await makeBox()
    const broken = { ...client, listChildren: async () => { throw new Error('boom') } }
    const r = createRunner({ client: broken, store, settings, emit })
    await expect(r.syncNow()).rejects.toThrow()
    expect(r.state().running).toBe(false)
    expect(r.state().phase).toBe('idle')
  })

  it('reports no drive letter for a UNC path instead of guessing E:', () => {
    expect(driveLetterOf('\\\\server\\share\\Docs')).toBeNull()
    expect(driveLetterOf('E:\\Docs')).toBe('E:')
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/runner.test.ts`
  Expected: FAIL — `driveLetterOf` returns `'E:'` for a UNC path, and the two concurrent syncs both upload.

- [ ] **Step 3: Implement the three fixes in `src/main/runner.ts`**

  **The mutex.** In `createRunner`, add a closure variable `let inFlight: Promise<RunSummary> | null = null`. Rename the body of `syncNow` to an inner function `runSync(mirrorName?, options?)`. Then:

  **The cross-process lock** (spec §12 A3). The in-process mutex does not stop a `--sync-once` process and the GUI from writing the manifest at the same time. Add to `src/main/runner.ts`:

  ```ts
  export async function acquireSyncLock(lockPath: string, now: Date): Promise<boolean>
  export async function releaseSyncLock(lockPath: string): Promise<void>
  ```

  `acquireSyncLock` creates the file with the exclusive-create flag. If the file already exists, read its `mtime`: older than six hours means stale, so delete it and try once more; otherwise return false. `releaseSyncLock` deletes the file. The lock is held **for the duration of a run**, not for the app's lifetime, so a scheduled run still happens while the app is open and idle.

  `runSync` takes the lock first. If it cannot, it logs "another sync was already running" and returns the current state without running. It releases the lock in a `finally`.

  **The settings getter** (spec §12 A9). `RunnerDeps.settings` changes from a value to `() => Promise<Settings>`. `runSync` awaits it at the start and derives the mirror list from `settings.mirrors` each run, so a folder added in the interface is synced by the next run without a restart. `Runner.state()` becomes `async state(): Promise<AppState>` and rebuilds the cards from the settings each time, so a new card appears the moment it is added. `src/main/ipc.ts`'s `get-state` handler awaits it.

  ```ts
  async syncNow(mirrorName?: string, options?: { overrideGuard?: boolean }) {
    if (inFlight) return inFlight
    inFlight = runSync(mirrorName, options).finally(() => { inFlight = null })
    return inFlight
  }
  ```

  **The error handling.** Inside `runSync`, wrap the whole body in `try { ... } finally { running.value = false; phase.value = 'idle' }`. The manifest checkpoint stays inside the `try`, after the mirror loop, so a successful run always checkpoints.

  **The drive letter.** `driveLetterOf` returns `null` when the path has no drive letter. In `runMirror`, the volume check becomes:

  ```ts
  const driveLetter = driveLetterOf(spec.root)
  const driveDev = driveLetter ? volumeDevOf(driveLetter) : null
  if (driveLetter) {
    const recorded = manifest.volumes[driveLetter]
    if (checkVolumeFingerprint(recorded, { dev: driveDev ?? rootStat.dev })) { ...skip... }
    if (driveDev !== null && driveDev !== rootStat.dev) { ...skip... }
  }
  ```

  A path with no drive letter has no letter to check, so only the root's own device is used.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/runner.test.ts`
  Expected: PASS.

- [ ] **Step 5: Confirm no `E:` survives in `src/`**

  Run: `git grep -n "E:" -- src`
  Expected: no matches, or only matches that are not a hardcoded drive letter.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/runner.ts test/runner.test.ts
  git commit -m "fix(runner): one run at a time, and no guessing which drive it is on"
  ```

---

### Task 6: Drive destinations are paths, and a folder can be moved

**Files:**
- Create: `src/core/drivePath.ts`
- Modify: `src/drive/client.ts`, `src/drive/httpClient.ts`, `test/helpers/fakeDrive.ts`
- Test: `test/drivePath.test.ts`, `test/httpClient.test.ts`

**Interfaces:**
- Consumes: `DriveClient` from `src/drive/client.ts`.
- Produces:
  ```ts
  // src/core/drivePath.ts
  export function splitDrivePath(drivePath: string): string[]
  export function driveFolderNameOf(drivePath: string): string
  export interface ResolvedDestination { id: string; name: string; created: string[] }
  export async function resolveMirrorPath(
    client: DriveClient,
    drivePath: string,
    myDriveId: string,
    storedId?: string,
  ): Promise<ResolvedDestination | { ambiguous: true; segment: string }>

  // src/drive/client.ts
  export interface DriveClient {
    ...existing...
    moveFolder(fileId: string, newParentId: string, newName?: string): Promise<void>
    getAccountEmail(): Promise<string | null>
  }
  ```

- [ ] **Step 1: Write the failing test**

  `test/drivePath.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { FakeDrive } from './helpers/fakeDrive'
  import { driveFolderNameOf, resolveMirrorPath, splitDrivePath } from '../src/core/drivePath'

  describe('resolving a Drive destination', () => {
    it('splits a path into its segments', () => {
      expect(splitDrivePath('Archive/2026/Photos')).toEqual(['Archive', '2026', 'Photos'])
      expect(driveFolderNameOf('Archive/2026/Photos')).toBe('Photos')
    })

    it('creates the folders that do not exist, parents first', async () => {
      const drive = new FakeDrive()
      const result = await resolveMirrorPath(drive, 'Archive/2026/Photos', 'root')
      expect(result).not.toHaveProperty('ambiguous')
      const created = (result as { created: string[] }).created
      expect(created).toEqual(['Archive', '2026', 'Photos'])
      const tree = await drive.listChildren('root')
      expect(tree.map((n) => n.entry.name)).toEqual(['Archive'])
    })

    it('finds a destination that already exists instead of creating a second one', async () => {
      const drive = new FakeDrive()
      await drive.createFolder('Photos', 'root')
      const first = await resolveMirrorPath(drive, 'Photos', 'root')
      const second = await resolveMirrorPath(drive, 'Photos', 'root')
      expect((first as { id: string }).id).toBe((second as { id: string }).id)
      expect((second as { created: string[] }).created).toEqual([])
    })

    it('reports an ambiguous destination rather than guessing', async () => {
      const drive = new FakeDrive()
      await drive.createFolder('Photos', 'root')
      await drive.createFolder('Photos', 'root')
      const result = await resolveMirrorPath(drive, 'Photos', 'root')
      expect(result).toHaveProperty('ambiguous', true)
    })

    it('does not clobber a file that already sits where a folder should go', async () => {
      const drive = new FakeDrive()
      await drive.createFile('Photos', 'root', undefined as never, { md5: 'x', size: 1 })
      const result = await resolveMirrorPath(drive, 'Photos', 'root')
      expect(result).toHaveProperty('ambiguous', true)
    })
  })
  ```

  In `test/httpClient.test.ts`, add:

  ```ts
  it('moves a folder by patching its parents', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return new Response(JSON.stringify({ id: 'f1', name: 'Photos', parents: ['new'] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const client = createDriveClient(async () => 'token', fetchImpl as never)
    await client.moveFolder('f1', 'new')
    expect(calls.some((c) => c.startsWith('PATCH') && c.includes('f1'))).toBe(true)
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/drivePath.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/core/drivePath.ts`**

  **The stored id wins** (spec §12 A6). `resolveMirrorPath` takes an optional `storedId`. When it is given, probe it first: if the file is alive, return it, whatever its current name is — the user's manual rename in the Drive browser is respected, and the caller updates `driveFolderName` to the name that is actually there. Only when the stored id is missing or trashed does the path walk run.

  The walk visits each segment in turn. For each one it lists the parent's children and:

  - folders whose name matches the segment case-insensitively → if more than one, return `{ ambiguous: true, segment }`; if exactly one, use it;
  - a **file** whose name matches the segment → return `{ ambiguous: true, segment }` (a file is sitting where a folder must go; the app must not clobber it);
  - nothing → `client.createFolder(segment, parentId)` and record the name in `created`.

  The last segment is the mirror's folder. The result is `{ id, name, created }` where `name` is the last segment.

  Add a test that the stored id short-circuits the walk:

  ```ts
  it('uses the stored folder id even when the folder was renamed on Drive', async () => {
    const drive = new FakeDrive()
    const created = await drive.createFolder('Photos', 'root')
    const renamed = await drive.createFolder('Pictures', 'root')
    await drive.moveFolder(renamed.id, 'root', 'Holidays')
    const result = await resolveMirrorPath(drive, 'Photos', 'root', created.id)
    expect((result as { id: string }).id).toBe(created.id)
  })
  ```

- [ ] **Step 4: Implement `moveFolder` and `getAccountEmail` in `src/drive/httpClient.ts`**

  `moveFolder(fileId, newParentId, newName?)` issues **one** `PATCH https://www.googleapis.com/drive/v3/files/{fileId}` with the body `{ parents: [newParentId] }`, plus `name: newName` when a name is given, and `addParents=true`. A destination change that renames the folder as well as moving it is still a single request.

  `getAccountEmail()` issues `GET https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)` and returns `user.emailAddress` or null.

  Add both to `src/drive/client.ts`'s interface, and implement them in `test/helpers/fakeDrive.ts` (`moveFolder` updates the node's parent and name; `getAccountEmail` returns `'test@example.com'`).

- [ ] **Step 5: Run the test to verify it passes**

  Run: `npx vitest run test/drivePath.test.ts test/httpClient.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/drivePath.ts src/drive/client.ts src/drive/httpClient.ts test/helpers/fakeDrive.ts test/drivePath.test.ts test/httpClient.test.ts
  git commit -m "feat(drive): destinations are paths, and a folder can be moved"
  ```

---

### Task 7: The manifest belongs to one Google account

**Files:**
- Modify: `src/main/runner.ts` (the account check inside `runMirror`, or before the loop)
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `DriveClient.getAccountEmail()` (Task 6), `Manifest.accountEmail` (Task 3).
- Produces: `RunnerDeps.accountEmail: () => Promise<string | null>` — already in the interface, now actually used.

- [ ] **Step 1: Write the failing test**

  Add to `test/runner.test.ts`:

  ```ts
  it('blocks the run when the signed-in account is not the one that owns the manifest', async () => {
    const box = await makeBox()
    const manifest = await store.read()
    manifest.accountEmail = 'someone-else@example.com'
    await store.write(manifest)
    const r = createRunner({ client, store, settings, emit, accountEmail: async () => 'me@example.com' })
    const summary = await r.syncNow()
    expect(summary.errors).toBe(1)
    expect(summary.reports[0]?.message).toContain('someone-else@example.com')
    expect(summary.reports[0]?.message).toContain('me@example.com')
  })

  it('records the account on the first run and does not block it', async () => {
    const box = await makeBox()
    const r = createRunner({ client, store, settings, emit, accountEmail: async () => 'me@example.com' })
    await r.syncNow()
    expect((await store.read()).accountEmail).toBe('me@example.com')
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/runner.test.ts`
  Expected: FAIL — nothing checks the account.

- [ ] **Step 3: Implement the check in `src/main/runner.ts`**

  At the top of `runSync`, before the mirror loop:

  ```ts
  const signedIn = await deps.accountEmail()
  if (signedIn && manifest.accountEmail && manifest.accountEmail !== signedIn) {
    const message = `this manifest belongs to ${manifest.accountEmail}, but you are signed in as ${signedIn}. Start a new manifest for this account before syncing.`
    deps.emit({ type: 'error', message })
    summary.errors = 1
    summary.reports.push({ code: 'anomaly', relPath: '', message })
    return summary
  }
  if (signedIn && !manifest.accountEmail) {
    manifest.accountEmail = signedIn
  }
  ```

  `src/main/index.ts:281` changes `accountEmail: () => null` to `accountEmail: async () => { const tokens = await loadTokens(); if (!tokens) return null; try { return await client.getAccountEmail() } catch { return null } }`.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/runner.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/runner.ts src/main/index.ts test/runner.test.ts
  git commit -m "feat(account): a manifest belongs to one Google account"
  ```

---

### Task 8: The progress bar moves

Fixes **B5**.

**Files:**
- Modify: `src/core/sync.ts` (the progress event type), `src/main/runner.ts` (the `onProgress` handler)
- Test: `test/sync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProgressEvent {
    relPath: string
    phase: string
    kind: string
    status: string
    message?: string
    /** How many files are done, and how many there are in total. */
    done: number
    total: number
  }
  ```

- [ ] **Step 1: Write the failing test**

  Add to `test/sync.test.ts`:

  ```ts
  it('reports progress with real counters', async () => {
    const events: ProgressEvent[] = []
    await executePlan(plan, { client, store, manifest, root, archiveDir, onProgress: (e) => events.push(e) })
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]!.total).toBeGreaterThan(0)
    expect(events[events.length - 1]!.done).toBe(events[events.length - 1]!.total)
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/sync.test.ts`
  Expected: FAIL — `ProgressEvent` has no counters.

- [ ] **Step 3: Implement the counters**

  Add `done` and `total` to `ProgressEvent`. In `executePlan`, count the steps in the plan up front (`total = plan.steps.length`) and increment `done` as each step finishes. Emit `total` on every event and the running `done`.

  In `src/main/runner.ts`, the `onProgress` handler passes `done: event.done, total: event.total` instead of the hardcoded zeros.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/sync.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/sync.ts src/main/runner.ts test/sync.test.ts
  git commit -m "fix(progress): the progress bar actually moves"
  ```

---

### Task 9: When is the next run?

**Files:**
- Create: `src/core/schedule.ts`
- Test: `test/schedule.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScheduleShape =
    | { kind: 'every-hours'; everyHours: number }
    | { kind: 'daily'; at: string }
    | { kind: 'every-days'; everyDays: number }
    | { kind: 'weekly'; day: number; at: string }
  export function nextFireAt(shape: ScheduleShape, from: Date, lastRunAt: string | null): Date
  export function intervalMs(shape: ScheduleShape): number
  export function isRunMissed(shape: ScheduleShape, lastRunAt: string | null, now: Date): boolean
  export function isValidShape(shape: ScheduleShape): boolean
  ```

- [ ] **Step 1: Write the failing test**

  `test/schedule.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { intervalMs, isRunMissed, isValidShape, nextFireAt } from '../src/core/schedule'

  describe('the schedule', () => {
    it('adds the hours for an every-hours shape', () => {
      const from = new Date('2026-03-01T10:00:00')
      expect(nextFireAt({ kind: 'every-hours', everyHours: 6 }, from, null).toISOString())
        .toBe('2026-03-01T16:00:00.000Z')
    })

    it('anchors an every-hours shape on the last run, not on now', () => {
      const from = new Date('2026-03-01T12:00:00')
      const next = nextFireAt({ kind: 'every-hours', everyHours: 6 }, from, '2026-03-01T08:00:00.000Z')
      expect(next.getHours()).toBe(14)
      expect(next.getDate()).toBe(1)
    })

    it('advances past a slot that has already gone', () => {
      const from = new Date('2026-03-01T20:00:00')
      const next = nextFireAt({ kind: 'every-hours', everyHours: 6 }, from, '2026-03-01T02:00:00.000Z')
      expect(next.getHours()).toBe(8)
      expect(next.getDate()).toBe(2)
    })

    it('finds the next occurrence of a time of day', () => {
      const from = new Date('2026-03-01T10:00:00')
      expect(nextFireAt({ kind: 'daily', at: '02:00' }, from, null).getHours()).toBe(2)
      expect(nextFireAt({ kind: 'daily', at: '02:00' }, from, null).getDate()).toBe(2)
    })

    it('finds the next occurrence of a weekday', () => {
      const from = new Date('2026-03-01T10:00:00')  // a Sunday
      const next = nextFireAt({ kind: 'weekly', day: 3, at: '03:00' }, from, null)
      expect(next.getDay()).toBe(3)
      expect(next.getHours()).toBe(3)
    })

    it('adds the days for an every-days shape', () => {
      const from = new Date('2026-03-01T10:00:00')
      expect(nextFireAt({ kind: 'every-days', everyDays: 3 }, from, null).getDate()).toBe(4)
    })

    it('crosses a month boundary', () => {
      const from = new Date('2026-01-30T10:00:00')
      const next = nextFireAt({ kind: 'every-days', everyDays: 3 }, from, null)
      expect(next.getMonth()).toBe(1)
    })

    it('knows when a run was missed', () => {
      const shape = { kind: 'every-hours', everyHours: 6 } as const
      const now = new Date('2026-03-01T20:00:00')
      expect(isRunMissed(shape, '2026-03-01T10:00:00.000Z', now)).toBe(true)
      expect(isRunMissed(shape, '2026-03-01T18:00:00.000Z', now)).toBe(false)
      expect(isRunMissed(shape, null, now)).toBe(true)
    })

    it('rejects a shape it cannot run', () => {
      expect(isValidShape({ kind: 'every-hours', everyHours: 0 })).toBe(false)
      expect(isValidShape({ kind: 'every-hours', everyHours: 24 })).toBe(false)
      expect(isValidShape({ kind: 'every-hours', everyHours: 6 })).toBe(true)
      expect(isValidShape({ kind: 'daily', at: '99:99' })).toBe(false)
      expect(isValidShape({ kind: 'daily', at: '02:00' })).toBe(true)
      expect(isValidShape({ kind: 'weekly', day: 9, at: '02:00' })).toBe(false)
    })

    it('gives the length of one interval', () => {
      expect(intervalMs({ kind: 'every-hours', everyHours: 6 })).toBe(6 * 3600_000)
      expect(intervalMs({ kind: 'every-days', everyDays: 3 })).toBe(3 * 24 * 3600_000)
    })
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/schedule.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/core/schedule.ts`**

  **The anchor** (spec §12 A10). `every-hours` and `every-days` anchor on the **last run**: `lastRunAt + n units`, advanced in a loop until the result is strictly after `from`. With no `lastRunAt` they anchor on `from`. `daily` and `weekly` anchor on the **wall clock**: the next occurrence of the time after `from`, in local time.

  `isValidShape` checks the ranges: `everyHours` 1–23, `everyDays` 1–31, `day` 0–6, and the time is `HH:MM` between 00:00 and 23:59.

  `intervalMs` returns 24 hours for `daily` and 7 days for `weekly`.

  `isRunMissed(shape, lastRunAt, now)` is true when `lastRunAt` is null or `now - lastRunAt > intervalMs(shape)`.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/schedule.test.ts`
  Expected: PASS, 8 tests.

- [ ] **Step 5: Move the shared types**

  `ScheduleShape` is declared in `src/core/schedule.ts` and re-exported from `src/main/settings.ts`, exactly as `MirrorConfig` was in Task 2. Remove the duplicate declaration in `settings.ts`.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/schedule.ts src/main/settings.ts test/schedule.test.ts
  git commit -m "feat(schedule): work out when the next run is due"
  ```

---

### Task 10: The Windows task

**Files:**
- Create: `src/main/taskScheduler.ts`
- Test: `test/schtasks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TASK_NAME = 'Drive Mirror Sync'
  export function buildSchtasksArgs(shape: ScheduleShape, exePath: string, nextRunAt: Date): string[]
  export function buildDeleteArgs(): string[]
  export async function registerTask(shape: ScheduleShape, exePath: string, nextRunAt: Date): Promise<void>
  export async function unregisterTask(): Promise<void>
  export async function taskExists(): Promise<boolean>
  ```

- [ ] **Step 1: Write the failing test**

  `test/schtasks.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { TASK_NAME, buildDeleteArgs, buildSchtasksArgs } from '../src/main/taskScheduler'

  describe('the Windows scheduled task', () => {
    const exe = 'C:\\Program Files\\Drive Mirror\\Drive Mirror.exe'

    it('asks for an hourly task', () => {
      const args = buildSchtasksArgs({ kind: 'every-hours', everyHours: 6 }, exe, new Date('2026-03-01T10:00:00'))
      expect(args).toContain('/SC'); expect(args).toContain('HOURLY')
      expect(args).toContain('/MO'); expect(args).toContain('6')
    })

    it('asks for a daily task at a time', () => {
      const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, new Date('2026-03-01T10:00:00'))
      expect(args).toContain('DAILY')
      expect(args).toContain('02:00')
    })

    it('asks for a task every n days', () => {
      const args = buildSchtasksArgs({ kind: 'every-days', everyDays: 3 }, exe, new Date('2026-03-01T10:00:00'))
      expect(args).toContain('DAILY')
      expect(args).toContain('3')
    })

    it('asks for a weekly task on a day', () => {
      const args = buildSchtasksArgs({ kind: 'weekly', day: 3, at: '03:00' }, exe, new Date('2026-03-01T10:00:00'))
      expect(args).toContain('WEEKLY')
      expect(args).toContain('WED')
    })

    it('runs the app in the user session, without a stored password', () => {
      const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, new Date('2026-03-01T10:00:00'))
      expect(args).toContain('/IT')
      expect(args).not.toContain('/RP')
      expect(args).not.toContain('/RU')
    })

    it('quotes the command so a path with spaces works', () => {
      const args = buildSchtasksArgs({ kind: 'daily', at: '02:00' }, exe, new Date('2026-03-01T10:00:00'))
      const tr = args[args.indexOf('/TR') + 1]!
      expect(tr).toContain('"--sync-once"')
      expect(tr).toContain('Drive Mirror.exe')
    })

    it('deletes by the same name it creates', () => {
      expect(buildDeleteArgs()).toContain(TASK_NAME)
      expect(buildDeleteArgs()).toContain('/Delete')
    })
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/schtasks.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/main/taskScheduler.ts`**

  `buildSchtasksArgs` returns the argument list for `schtasks.exe /Create`:

  ```
  /TN "Drive Mirror Sync"
  /TR "\"C:\Program Files\Drive Mirror\Drive Mirror.exe\" --sync-once"
  /SC HOURLY /MO 6
  /F /IT
  ```

  The `/TR` value is the exe path in double quotes, followed by ` --sync-once`, wrapped so that the whole thing survives as one argument. The weekday map is `['SUN','MON','TUE','WED','THU','FRI','SAT']`.

  `registerTask`, `unregisterTask` and `taskExists` run `schtasks.exe` with `execFile` and reject with the stderr text when the exit code is not 0 — except `unregisterTask`, which resolves when the task simply does not exist.

- [ ] **Step 4: Run the test to verify it passes**

  Run: `npx vitest run test/schtasks.test.ts`
  Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/taskScheduler.ts test/schtasks.test.ts
  git commit -m "feat(task): drive the Windows scheduled task"
  ```

---

### Task 11: The scheduler runs the syncs

**Files:**
- Create: `src/main/scheduler.ts`
- Modify: `src/main/index.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes: `nextFireAt`, `isRunMissed` (Task 9); `registerTask`, `unregisterTask`, `taskExists` (Task 10); `Runner.syncNow` (Task 5).
- Produces:
  ```ts
  export interface SchedulerDeps {
    settings(): Promise<Settings>
    saveSettings(patch: Partial<Settings>): Promise<Settings>
    runSync(): Promise<RunSummary>
    now(): Date
    registerTask(shape: ScheduleShape, exePath: string, nextRunAt: Date): Promise<void>
    unregisterTask(): Promise<void>
    taskExists(): Promise<boolean>
    exePath(): string
    setTimer(fn: () => void, ms: number): unknown
    clearTimer(handle: unknown): void
    onResume(fn: () => void): () => void
    notify(title: string, body: string): void
  }
  export function createScheduler(deps: SchedulerDeps): {
    start(): Promise<void>
    stop(): void
    runNow(): Promise<void>
    nextRunAt(): string | null
  }
  ```

- [ ] **Step 1: Write the failing test**

  `test/scheduler.test.ts`:

  ```ts
  import { describe, expect, it, vi } from 'vitest'
  import { createScheduler } from '../src/main/scheduler'
  import { defaultSettings } from '../src/main/settings'

  describe('the scheduler', () => {
    it('does not run at once when it is switched on', async () => {
      const settings = { ...defaultSettings(), schedule: { enabled: true, shape: { kind: 'daily', at: '02:00' } as const, mechanism: 'in-app' as const, lastRunAt: null, nextRunAt: null } }
      const runSync = vi.fn(async () => ({ uploaded: 0 } as never))
      const s = createScheduler({ settings: async () => settings, saveSettings: async (p) => ({ ...settings, ...p }), runSync, now: () => new Date('2026-03-01T10:00:00'), ...stub })
      await s.start()
      expect(runSync).not.toHaveBeenCalled()
    })

    it('runs once when a run was missed', async () => {
      const settings = { ...defaultSettings(), schedule: { enabled: true, shape: { kind: 'every-hours', everyHours: 6 } as const, mechanism: 'in-app' as const, lastRunAt: '2026-03-01T00:00:00.000Z', nextRunAt: null } }
      const runSync = vi.fn(async () => ({ uploaded: 0 } as never))
      const s = createScheduler({ settings: async () => settings, saveSettings: async (p) => ({ ...settings, ...p }), runSync, now: () => new Date('2026-03-01T20:00:00'), ...stub })
      await s.start()
      expect(runSync).toHaveBeenCalledTimes(1)
    })

    it('does not start a second run while one is in flight', async () => {
      let resolve: (v: never) => void = () => {}
      const runSync = vi.fn(() => new Promise((r) => { resolve = r as never }))
      const s = createScheduler({ ...deps, runSync })
      await Promise.all([s.runNow(), s.runNow()])
      expect(runSync).toHaveBeenCalledTimes(1)
    })

    it('arms the timer for the next slot', async () => {
      let armed = 0
      const s = createScheduler({ ...deps, setTimer: () => { armed++; return 1 }, now: () => new Date('2026-03-01T10:00:00') })
      await s.start()
      expect(armed).toBe(1)
    })
  })
  ```

  The `stub` object supplies `registerTask`, `unregisterTask`, `taskExists`, `exePath`, `setTimer`, `clearTimer`, `onResume` and `notify`.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/scheduler.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/main/scheduler.ts`**

  `start()`:
  1. Reads the settings. If the schedule is off, does nothing.
  2. If the mechanism is `windows-task` and the task does not exist, registers it.
  3. If `isRunMissed(shape, lastRunAt, now)`, runs **once** now, then arms the timer. This applies to **both** mechanisms (spec §12 A10): if the machine was off, the Windows task missed its slot too.
  4. If the mechanism is `windows-task`, the app does not arm a timer; the Windows task does that.
  5. Saves `lastRunAt` after the run and `nextRunAt` after arming.

  **A manual "Sync now" also updates `lastRunAt`** (spec §12 A10). The runner writes it after every run, not just a scheduled one. The consequence is that a manual sync resets the missed-slot clock, which is correct: the user just synced, so there is nothing to catch up on.

  `runNow()` is single-flight: a second call while a run is in flight returns the same promise.

  The `onResume` hook re-checks the clock and runs immediately if a slot passed while the machine slept.

- [ ] **Step 4: Wire it into `src/main/index.ts`**

  After `app.whenReady()`:

  ```ts
  app.setAppUserModelId('com.drivemirror.app')
  ```

  and, in the same block where `runner.prime()` is called:

  ```ts
  await scheduler.start()
  ```

  The scheduler's `runSync` calls `runner.syncNow()`. Its `setTimer` is Node's `setTimeout`. Its `onResume` is `powerMonitor.on('resume', ...)`.

  **The `--sync-once` mode.** At the very top of the main script:

  ```ts
  const syncOnce = process.argv.includes('--sync-once')
  ```

  When it is set: create no window, run one sync, write the summary to the log, show a toast if the run failed or a guard tripped, and `app.quit()`.

  **`--sync-once` does not take the single-instance lock** (spec §12 A3). The lock is what makes a second launch quit, and a scheduled run must not quit just because the app happens to be open. In `--sync-once` mode the single-instance lock is skipped entirely and the run is protected by the **lock file** instead, which is held only for the duration of a run. So a scheduled run happens while the app is open and idle, and is skipped only when a sync is genuinely in progress.

  The `--sync-once` branch must come **before** `createMainWindow()` and before the single-instance lock, both of which are in `src/main/index.ts`.

- [ ] **Step 5: Run the test to verify it passes**

  Run: `npx vitest run test/scheduler.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/scheduler.ts src/main/index.ts test/scheduler.test.ts
  git commit -m "feat(schedule): run the syncs on a timer, or on a Windows task"
  ```

---

### Task 12: Telling the user when a run they did not watch went wrong

**Files:**
- Create: `src/main/notice.ts`
- Modify: `src/main/runner.ts`, `src/main/index.ts`
- Test: `test/notice.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function setPendingNotice(settings: Settings, message: string, now: Date): Promise<Settings>
  export async function clearPendingNotice(settings: Settings): Promise<Settings>
  ```

- [ ] **Step 1: Write the failing test**

  `test/notice.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { clearPendingNotice, setPendingNotice } from '../src/main/notice'
  import { defaultSettings } from '../src/main/settings'

  describe('a notice the user did not see', () => {
    it('is set and then cleared', async () => {
      const s = defaultSettings()
      const withNotice = setPendingNotice(s, 'the sync failed', new Date('2026-03-01T10:00:00'))
      expect(withNotice.pendingNotice?.message).toBe('the sync failed')
      expect(clearPendingNotice(withNotice).pendingNotice).toBeNull()
    })

    it('does not mutate the settings it was given', () => {
      const s = defaultSettings()
      setPendingNotice(s, 'x', new Date())
      expect(s.pendingNotice).toBeNull()
    })
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/notice.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/main/notice.ts`**

  Both functions return a **new** `Settings` object; neither mutates its argument.

- [ ] **Step 4: Wire the notice and the toast**

  In `src/main/runner.ts`, when a mirror is skipped by a guard, or when a run throws, the runner records the message. In `src/main/index.ts`, after a run that the user did not start (a scheduled run), if `summary.errors > 0` or any mirror was skipped, the app:

  1. shows a toast through Electron's `Notification`, and
  2. saves `pendingNotice` through `setPendingNotice`.

  The renderer reads `settings.pendingNotice` when it loads and shows a banner, then calls `clearPendingNotice`.

- [ ] **Step 5: Run the test to verify it passes**

  Run: `npx vitest run test/notice.test.ts`
  Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/notice.ts src/main/runner.ts src/main/index.ts test/notice.test.ts
  git commit -m "feat(notice): tell the user when a run they did not watch went wrong"
  ```

---

### Task 13: The new IPC surface

**Files:**
- Modify: `src/main/ipc.ts`, `src/preload/index.ts`
- Test: `test/ipc.test.ts`

**Interfaces:**
- Produces — the new channels, all following `drive-mirror:<verb>`:

  | Channel | Argument | Result |
  |---|---|---|
  | `drive-mirror:choose-folder` | none | `string \| null` — the chosen local path |
  | `drive-mirror:add-mirror` | `{ name, root, drivePath }` | `{ ok: true } \| { ok: false; message: string }` |
  | `drive-mirror:update-mirror` | `{ name, drivePath? }` | `{ ok: true } \| { ok: false; message: string }` |
  | `drive-mirror:remove-mirror` | `{ name }` | `{ ok: true }` |
  | `drive-mirror:set-mirror-enabled` | `{ name, enabled }` | `{ ok: true }` |
  | `drive-mirror:get-schedule` | none | `ScheduleConfig` |
  | `drive-mirror:save-schedule` | `Partial<ScheduleConfig>` | `ScheduleConfig` |
  | `drive-mirror:reset-connection` | none | `{ ok: true }` |
  | `drive-mirror:start-fresh-manifest` | none | `{ ok: true }` |
  | `drive-mirror:download-restored` | `{ mirror, driveFileId }` | `{ ok: true, path } \| { ok: false, message }` |
  | `drive-mirror:open-external` | `url` | `void` — **already registered in main, now exposed in the preload** |

- [ ] **Step 1: Write the failing test**

  `test/ipc.test.ts`:

  ```ts
  import { describe, expect, it, vi } from 'vitest'
  import { registerIpc } from '../src/main/ipc'

  describe('the IPC surface', () => {
    it('registers every channel the preload exposes', () => {
      const handlers = new Map<string, unknown>()
      vi.mock('electron', () => ({ ipcMain: { handle: (c: string, h: unknown) => handlers.set(c, h) } }))
      registerIpc({ runner, getSettings, saveSettings, setCredentials, authenticate, signOut, openLogFolder, showManifest, revealSuperseded, pruneSuperseded, ... })
      for (const channel of [
        'drive-mirror:get-state', 'drive-mirror:sync-now', 'drive-mirror:override-guard', 'drive-mirror:rebase',
        'drive-mirror:get-settings', 'drive-mirror:save-settings', 'drive-mirror:set-credentials',
        'drive-mirror:authenticate', 'drive-mirror:sign-out', 'drive-mirror:open-log-folder',
        'drive-mirror:show-manifest', 'drive-mirror:reveal-superseded', 'drive-mirror:prune-superseded',
        'drive-mirror:choose-folder', 'drive-mirror:add-mirror', 'drive-mirror:update-mirror',
        'drive-mirror:remove-mirror', 'drive-mirror:set-mirror-enabled', 'drive-mirror:get-schedule',
        'drive-mirror:save-schedule', 'drive-mirror:reset-connection', 'drive-mirror:start-fresh-manifest',
        'drive-mirror:download-restored', 'drive-mirror:open-external',
      ]) {
        expect(handlers.has(channel)).toBe(true)
      }
    })
  })
  ```

  The `vi.mock` must be hoisted above the import of `../src/main/ipc`.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/ipc.test.ts`
  Expected: FAIL — the new channels are not registered.

- [ ] **Step 3: Implement the handlers in `src/main/ipc.ts`**

  `choose-folder` calls `dialog.showOpenDialog(window, { properties: ['openDirectory'] })` and returns the first path or null.

  `add-mirror` validates with `validateMirror` from `src/core/mirrorConfig.ts` against the current settings' mirrors, and appends to `settings.mirrors`.

  `update-mirror` changes the destination. If the mirror has files and the destination changed, the runner moves the Drive folder (`client.moveFolder`). If the move fails, the handler returns `{ ok: false, message }` and **the old destination is kept**.

  `remove-mirror` sets `removedAt` on the config and removes it from the active list. It **never** touches Drive.

  `reset-connection` clears the tokens and the credential store, and **touches nothing else** — not the mirrors, not the schedule, not the manifest.

  `start-fresh-manifest` copies the current manifest to `manifest-archive/manifest-<timestamp>.json` and writes an empty manifest. The archive directory is **its own** (`%LOCALAPPDATA%\DriveMirror\manifest-archive\`), not `superseded/` — the existing **Prune superseded copies** action deletes everything under `superseded/`, and that archive is the only way back from an account switch (spec §12 A8).

  `MirrorCard` gains `recovered: Array<{ driveFileId: string; path: string; at: string }>` (spec §12 A13), filled by the runner from the manifest's retired records whose state is `restored`. `Report` gains an optional `mirror?: string`, set by the runner, so a report can be attributed to a mirror.

- [ ] **Step 4: Expose the new methods in `src/preload/index.ts`**

  Every new channel gets a method on the `DriveMirrorApi` interface and an implementation. `openExternal` is added, which fixes **B6**.

- [ ] **Step 5: Run the test to verify it passes**

  Run: `npx vitest run test/ipc.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/ipc.ts src/preload/index.ts test/ipc.test.ts
  git commit -m "feat(ipc): channels for mirrors, the schedule and the connection"
  ```

---

### Task 14: The interface

**Files:**
- Modify: `src/renderer/App.tsx`, `src/renderer/components/FolderCard.tsx`, `src/renderer/components/SettingsDialog.tsx`
- Create: `src/renderer/components/AddMirrorDialog.tsx`, `src/renderer/components/SchedulePanel.tsx`, `src/renderer/components/SetupWizard.tsx`, `src/renderer/components/RecoveredPanel.tsx`
- Test: none. The renderer has no test setup — `vitest.config.ts` uses `environment: 'node'` and there is no jsdom. Do not add one in this task.

**Interfaces:**
- Consumes: the preload API from Task 13.
- Produces: the four new components, plus the changed `FolderCard` and `SettingsDialog`.

- [ ] **Step 1: `AddMirrorDialog.tsx`**

  Follows the `SettingsDialog` pattern exactly: `<div className="dialog" role="dialog" aria-modal="true">`, a `<div className="dialog__panel">`, escape-to-close, `<section className="dialog__section">` blocks, `<div className="dialog__row">` for actions.

  Contents: a "Choose folder" button that calls `chooseFolder()`, a "Name" input, a "Drive folder" input, a Save button, and a `<p className="dialog__status">` for the validation message. When `chooseFolder()` returns a path, the name input is pre-filled with the folder's basename and the Drive folder input with the same name — but only if the user has not already typed a name.

- [ ] **Step 2: `FolderCard.tsx`**

  Add a pause toggle, an "Edit" button that opens the add dialog in edit mode, and a "Remove" button. Removing asks for confirmation and states that the Drive copy is left alone.

- [ ] **Step 3: `SchedulePanel.tsx`**

  A section inside the Settings dialog: an on/off toggle, a shape picker (every N hours / daily / every N days / weekly), the numbers and times for the chosen shape, a mechanism picker (run while the app is open / run even when it is closed), the next run time, and a "Run now" button.

  The mechanism picker must state the constraint in the UI: *"A Windows task runs only while you are signed in."*

- [ ] **Step 4: `SetupWizard.tsx`**

  Shown when there is no client id. Five numbered steps, each with a button that calls `openExternal` on the right Google Cloud console URL:

  1. `https://console.cloud.google.com/` — create or pick a project
  2. `https://console.cloud.google.com/apis/library` — enable the Google Drive API
  3. `https://console.cloud.google.com/apis/credentials` — create an OAuth client id, **application type Desktop app**
  4. `https://console.cloud.google.com/apis/console` — set the consent screen to **In production**
  5. copy the client id and the client secret into the fields

  The wizard has a "I have these" button that opens the ordinary client-id and secret fields.

- [ ] **Step 5: `RecoveredPanel.tsx`**

  Lists the retired records in state `restored`, with the path and a "Download to E:" button per row. The button calls `downloadRestored`. The panel is shown when a mirror has something to recover.

- [ ] **Step 6: `App.tsx` and `SettingsDialog.tsx`**

  `App.tsx` gets an "Add folder" button in the top bar, the new dialogs, the pending-notice banner, and the account email in the top bar.

  `SettingsDialog.tsx` gets the schedule panel, the backup paths (editable, one per line), the "Sign out of Google" and "Reset connection" buttons, and the "How do I get these?" link that opens the setup wizard.

- [ ] **Step 7: Run the type check and the build**

  Run: `npm run typecheck` then `npm run build`
  Expected: clean, and `out/renderer/index.html` plus `out/main/index.js` are produced.

- [ ] **Step 8: Commit**

  ```bash
  git add src/renderer
  git commit -m "feat(ui): add a folder, a schedule, a guide and a way to recover a file"
  ```

---

### Task 15: The icon

**Files:**
- Create: `build/icon.ico`, `build/icon.png` — **already generated; commit them**
- Modify: `electron-builder.yml`, `src/main/window.ts`, `src/renderer/App.tsx`, `src/renderer/styles.css`
- Test: `test/icon.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/main/window.ts
  export function appIconPath(): string
  ```

- [ ] **Step 1: Write the failing test**

  `test/icon.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { readFile } from 'node:fs/promises'
  import { join } from 'node:path'

  describe('the app icon', () => {
    it('is a valid ico with the sizes Windows asks for', async () => {
      const b = await readFile(join(process.cwd(), 'build', 'icon.ico'))
      expect(b.readUInt16LE(0)).toBe(0)
      expect(b.readUInt16LE(2)).toBe(1)
      const count = b.readUInt16LE(4)
      expect(count).toBe(6)
      const sizes: number[] = []
      for (let i = 0; i < count; i++) {
        const o = 6 + i * 16
        sizes.push(b.readUInt8(o) || 256)
        const off = b.readUInt32LE(o + 12)
        expect(b.slice(off, off + 8).toString('hex')).toBe('89504e470d0a1a0a')
      }
      expect(sizes.sort((a, b2) => a - b2)).toEqual([16, 32, 48, 64, 128, 256])
    })

    it('has a 512 pixel png as the source', async () => {
      const b = await readFile(join(process.cwd(), 'build', 'icon.png'))
      expect(b.slice(1, 4).toString('ascii')).toBe('PNG')
      expect(b.readUInt32BE(16)).toBe(512)
      expect(b.readUInt32BE(20)).toBe(512)
    })
  })
  ```

- [ ] **Step 2: Run the test to verify it passes**

  Run: `npx vitest run test/icon.test.ts`
  Expected: PASS — the assets are already in `build/`.

- [ ] **Step 3: Wire the icon into the build and the window**

  `electron-builder.yml` gets:

  ```yaml
  win:
    icon: build/icon.ico
    target: ...
  extraResources:
    - from: build/icon.png
      to: icon.png
  nsis:
    include: build/installer.nsh
  ```

  `src/main/window.ts` gets:

  ```ts
  export function appIconPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'build', 'icon.png')
  }
  ```

  and the `BrowserWindow` options gain `icon: appIconPath()`.

  `src/renderer/App.tsx` shows the icon at 20px next to the title. The PNG is loaded from the packaged resource path via a `file://` URL, or from `build/icon.png` in development.

- [ ] **Step 4: Write `build/installer.nsh`**

  ```nsis
  !macro customUnInstall
    nsExec::Exec 'schtasks /Delete /TN "Drive Mirror Sync" /F'
  !macroend
  ```

- [ ] **Step 5: Run the test and the build**

  Run: `npm test` then `npm run build`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add build electron-builder.yml src/main/window.ts src/renderer test/icon.test.ts
  git commit -m "feat(icon): the app has an icon again"
  ```

---

### Task 16: The mirror list, the removal, and the thirty-day forgetting

**Files:**
- Modify: `src/main/runner.ts`
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `MirrorConfig` (Task 2), `ScheduleConfig` (Task 9).
- Produces, on the `Runner` interface:

  ```ts
  setMirrors(mirrors: MirrorConfig[]): void
  removeMirror(name: string): Promise<void>
  setMirrorEnabled(name: string, enabled: boolean): Promise<void>
  pruneRemovedMirrors(): Promise<number>
  downloadRestored(mirror: string, driveFileId: string): Promise<
    { ok: true; path: string } | { ok: false; message: string }
  >
  ```

- [ ] **Step 1: Write the failing test**

  Add to `test/runner.test.ts`:

  ```ts
  it('forgets a removed mirror thirty days later, and not before', async () => {
    const box = await makeBox()
    const manifest = await store.read()
    manifest.mirrors.Old = { root: 'E:\\Old', lastCounts: {}, rebase: null, dirs: {}, files: {}, retired: {} }
    await store.write(manifest)
    const settings29 = { ...settings, mirrors: [{ name: 'Old', root: 'E:\\Old', drivePath: 'Old', enabled: true, removedAt: new Date(Date.now() - 29 * 86400_000).toISOString() }] }
    const s29 = createRunner({ client, store, settings: settings29, emit })
    expect(await s29.pruneRemovedMirrors()).toBe(0)
    expect((await store.read()).mirrors.Old).toBeDefined()

    const settings31 = { ...settings, mirrors: [{ name: 'Old', root: 'E:\\Old', drivePath: 'Old', enabled: true, removedAt: new Date(Date.now() - 31 * 86400_000).toISOString() }] }
    const s31 = createRunner({ client, store, settings: settings31, emit })
    expect(await s31.pruneRemovedMirrors()).toBe(1)
    expect((await store.read()).mirrors.Old).toBeUndefined()
  })

  it('never forgets a mirror that is still configured', async () => {
    const manifest = await store.read()
    manifest.mirrors.Kept = { root: 'E:\\Kept', lastCounts: {}, rebase: null, dirs: {}, files: {}, retired: {} }
    await store.write(manifest)
    const s = createRunner({ client, store, settings, emit })
    await s.pruneRemovedMirrors()
    expect((await store.read()).mirrors.Kept).toBeDefined()
  })

  it('removes a mirror without touching Drive', async () => {
    const box = await makeBox()
    const before = await client.listChildren('root')
    await runner.removeMirror('Medicine')
    expect(await client.listChildren('root')).toEqual(before)
  })

  it('refuses to re-add a removed mirror under a different root', async () => {
    // The mass-trash hole: a different root would inherit the old
    // baseline, and every old path would read as absent.
    const manifest = await store.read()
    manifest.mirrors.Docs = { root: 'E:\\OldDocs', lastCounts: { '': 10 }, rebase: null, dirs: {}, files: {}, retired: {} }
    await store.write(manifest)
    const settingsWithRemoved = { ...settings, mirrors: [{ name: 'Docs', root: 'E:\\OldDocs', drivePath: 'Docs', enabled: false, removedAt: new Date().toISOString() }] }
    const problems = validateMirror({ name: 'Docs', root: 'E:\\NewDocs', drivePath: 'Docs' }, settingsWithRemoved.mirrors)
    expect(problems.map((p) => p.field)).toContain('root')
  })

  it('keeps the superseded copies when a removed mirror is forgotten', async () => {
    const box = await makeBox()
    const manifest = await store.read()
    manifest.mirrors.Old = { root: 'E:\\Old', lastCounts: {}, rebase: null, dirs: {}, files: {}, retired: {} }
    await store.write(manifest)
    await mkdir(join(box.dir, 'superseded', 'Old'), { recursive: true })
    await writeFile(join(box.dir, 'superseded', 'Old', 'a.bin'), 'bytes')
    const settings31 = { ...settings, mirrors: [{ name: 'Old', root: 'E:\\Old', drivePath: 'Old', enabled: true, removedAt: new Date(Date.now() - 31 * 86400_000).toISOString() }] }
    const s31 = createRunner({ client, store, settings: settings31, emit })
    expect(await s31.pruneRemovedMirrors()).toBe(1)
    expect(existsSync(join(box.dir, 'superseded', 'Old', 'a.bin'))).toBe(true)
  })
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npx vitest run test/runner.test.ts`
  Expected: FAIL — the methods do not exist.

- [ ] **Step 3: Implement the four methods in `src/main/runner.ts`**

  `setMirrors(mirrors)` replaces the closure's mirror list and rebuilds the cards.

  `removeMirror(name)` removes the mirror from the **active** list only. It does not call the Drive client at all.

  `setMirrorEnabled(name, enabled)` flips the flag.

  `pruneRemovedMirrors()` finds the mirrors whose `removedAt` is more than 30 days old, deletes their **manifest entry** — the file list, the retired records, the counts — checkpoints the manifest, and returns how many were pruned. A mirror with no `removedAt` is never pruned. **The superseded copies under `superseded\<mirror>\` are left alone** (spec §12 A5): they are the only local copies of bytes the app replaced, and silently deleting gigabytes because a mirror was forgotten is not something a backup tool should do on its own. They stay until the user runs the existing **Prune superseded copies** action.

  The 30 days is `30 * 24 * 60 * 60 * 1000`.

  **Re-adding a removed mirror** (spec §12 A4) is handled by `validateMirror`, which compares the root as well as the name. The same name with the **same** root re-adopts the history. The same name with a **different** root is refused, and the message names both roots.

  **Downloading a restored file** (spec §12 A12). `downloadRestored(mirror, driveFileId)`:

  1. Finds the retired record by `driveFileId` in `manifest.mirrors[mirror].retired`. If it is not in state `restored`, refuse with "that file is not waiting to be recovered".
  2. The target path is `root` + the record's `localPath` when it has one (a Google-native file's export path), otherwise `root` + the record's `path`.
  3. If a file already sits at the target path, compare the md5 of the bytes about to be written with the md5 of that file. Equal → continue. Different → **refuse** with "something is already at that path". A retired record's own md5 is the hash *at retirement* and is not the right comparison, because the Drive file may have been edited after the restore.
  4. Downloads through `client.downloadTo`, or `client.exportTo` when the file is Google-native and the record carries an export mime type.
  5. Reads the Drive file's metadata with `client.getFile(driveFileId)` to get `driveModifiedTime` and the mime type, stats the written file for `localSize` and `localMtimeMs`, and writes the live entry into `manifest.mirrors[mirror].files` under the canonical path.
  6. Flips the retired record's state to `resynced`.

  A failure at any step leaves the record in state `restored` and returns the reason.

- [ ] **Step 4: Amend the exhaustiveness invariant**

  `test/exhaustiveness.test.ts` INV-5 asserts that every retired state is consumed. **Add a carve-out and state it in the test file**, not silently:

  ```ts
  // A mirror the user removed is forgotten entirely after thirty days,
  // retired records included. That is the one carve-out from the
  // never-prune rule; see the v2 spec, section 8, amendment A1.
  ```

  The test keeps its assertion for every mirror that is still configured.

- [ ] **Step 5: Run the test to verify it passes**

  Run: `npx vitest run test/runner.test.ts test/exhaustiveness.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/runner.ts test/runner.test.ts test/exhaustiveness.test.ts
  git commit -m "feat(mirrors): add, pause, remove and forget a mirror"
  ```

---

### Task 17: The docs and the README

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`
- Test: none.

- [ ] **Step 1: Rewrite the README's "what it mirrors" section**

  The four `E:` trees are no longer the product. They are the defaults. The README must show a user how to add their own folder, how to set a schedule, and where the settings live.

- [ ] **Step 2: Add the schedule and the connection sections to the README**

  Cover: the four schedule shapes, the one-mechanism rule, the signed-in constraint, the two disconnect buttons, and what "Reset connection" does and does not touch.

- [ ] **Step 3: Update `CONTRIBUTING.md`**

  Record the new modules, the rule that no test may write outside its temp directory, and the rule that no literal drive letter appears in `src/`.

- [ ] **Step 4: Check the docs are true**

  Run: `git grep -n "E:" -- src README.md CONTRIBUTING.md`
  Expected: no hardcoded drive letter in `src/`. `README.md` may still mention `E:` as an example.

- [ ] **Step 5: Commit**

  ```bash
  git add README.md CONTRIBUTING.md
  git commit -m "docs: the app mirrors the folders you choose, on a schedule"
  ```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: §6.1 settings → Task 1; §6.2 manifest → Task 3; §6.3 account → Task 7; §7.1 add folder → Tasks 2 and 14; §7.2 destination paths → Task 6; §7.3 change destination → Tasks 6 and 13; §7.4 remove and forget → Task 16; §7.5 scheduling → Tasks 9, 10, 11; §7.6 mutex → Task 5; §7.7 notifications → Task 12; §7.8 connection → Tasks 7 and 13; §7.9 uninstall → Task 15; §7.10 icon → Task 15; §7.11 download to E: → Task 14; §8 amendments → Tasks 3 and 16; §9 bugs B1–B7 → Tasks 4, 5, 7, 8, 13, 15; §10 testing → every task.

**Gap found.** The spec's §7.11 "Download to E:" needs a place in the runner, not only in the renderer. Task 14 builds the panel; the IPC handler in Task 13 calls the runner. The runner method `downloadRestored(mirror, driveFileId)` is named in Task 13's table but its implementation is not given a task. **It is folded into Task 16**, whose step list must also implement `downloadRestored`: it downloads through `client.downloadTo` (or `client.exportTo` for a Google-native file), refuses when the target path holds a file with different content, and flips the retired record to `resynced`.

**Type consistency.** `MirrorConfig` and `ScheduleShape` are each declared once — in `src/core/` — and re-exported from `src/main/settings.ts` (Tasks 2 and 9). `writeBackups` is used by the runner and tested directly (Task 4). `nextFireAt` and `isRunMissed` are produced by Task 9 and consumed by Task 11. `buildSchtasksArgs` is produced by Task 10 and consumed by Task 11.

**Proportion.** The plan is shorter than the code it describes. Steps give test names, exact signatures and exact values; bodies are given only where the algorithm is not determined by the signature.
