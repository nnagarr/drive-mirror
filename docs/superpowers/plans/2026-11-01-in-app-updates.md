# In-App Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Drive Mirror to detect new GitHub releases, notify installed desktop users, and download and apply updates via an in-app banner and Settings panel.

**Architecture:** A main-process `UpdateManager` wraps `electron-updater` behind an abstract `UpdaterBackend` to manage the update lifecycle, safely handles dev-mode vs packaged execution, persists an `autoCheckUpdates` user setting, and exposes IPC endpoints (`check-for-updates`, `download-update`, `install-update`, `get-update-status`) and event streaming to the React renderer. A GitHub Actions workflow automatically builds and publishes release installers on version tag pushes.

**Tech Stack:** TypeScript, Electron, `electron-updater`, `electron-builder`, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-in-app-updates-design.md`

## Global Constraints
- Target Windows x64 NSIS installer packages (`dist/Drive-Mirror-*-Setup.exe`).
- Do not break existing zero-dependency production runtime constraints unnecessarily; add only `electron-updater` as a dependency.
- Development mode (`!app.isPackaged`) must never crash or throw unhandled exceptions during update checks.
- All existing tests (489 tests) and typechecks must pass cleanly at each step.

## Review Focus
1. Running in development mode (`!app.isPackaged`): update checks must cleanly report development status or query GitHub safely without attempting to run NSIS differential updates.
2. Network offline or GitHub API rate limiting: network errors during update checks must transition to an informative error state without unhandled promise rejections.
3. Concurrent check or download requests: calling `checkForUpdates` or `downloadUpdate` while an operation is already active must return the current state instead of spawning duplicate network streams.
4. Download errors: failed update downloads must reset to error state allowing manual retry rather than locking the UI in a perpetual "downloading" state.
5. Auto-check disabled: when `autoCheckUpdates: false` is configured, launching the app must not trigger an automated background update check.

---

### Task 1: Add `electron-updater` dependency and `electron-builder` publish config

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.yml:1-10`

**Interfaces:**
- Consumes: `package.json`, `electron-builder.yml`
- Produces: `electron-updater` in `dependencies`, GitHub publish configuration in `electron-builder.yml`

- [ ] **Step 1: Update `package.json` to include `electron-updater` in dependencies**

Add `"dependencies"` block to `package.json`:
```json
"dependencies": {
  "electron-updater": "^6.8.12"
}
```

- [ ] **Step 2: Add `publish` block to `electron-builder.yml`**

Add publish configuration:
```yaml
publish:
  provider: github
  owner: nnagarr
  repo: drive-mirror
  releaseType: release
```

- [ ] **Step 3: Install dependency and verify package-lock**

Run: `npm install`
Expected: `added 1 package` (or similar) with exit code 0.

- [ ] **Step 4: Run typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json electron-builder.yml
git commit -m "build: add electron-updater and configure github release publishing"
```

---

### Task 2: Extend `AppSettings` with `autoCheckUpdates`

**Files:**
- Modify: `src/main/settings.ts:85-115`
- Modify: `src/main/settings.ts:240-270`
- Modify: `test/settings.test.ts`

**Interfaces:**
- Consumes: None
- Produces: `AppSettings.autoCheckUpdates: boolean`

- [ ] **Step 1: Write failing test in `test/settings.test.ts`**

Add test verifying `defaultAppSettings.autoCheckUpdates` is `true` and saving `autoCheckUpdates: false` persists and reloads:
```ts
it('defaults autoCheckUpdates to true and persists changes', async () => {
  const store = createSettingsStore(join(dir, 'settings.json'))
  const initial = await store.read()
  expect(initial.autoCheckUpdates).toBe(true)

  await store.patch({ autoCheckUpdates: false })
  const updated = await store.read()
  expect(updated.autoCheckUpdates).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL with property undefined or assertion error.

- [ ] **Step 3: Implement `autoCheckUpdates` in `src/main/settings.ts`**

In `src/main/settings.ts`:
- Add `autoCheckUpdates: boolean` to `interface AppSettings`.
- Set `autoCheckUpdates: true` in `defaultAppSettings`.
- Set `autoCheckUpdates: true` in `withLegacyDefaults`.
- In `mergeValue`, preserve `autoCheckUpdates` boolean if present in parsed data.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/settings.ts test/settings.test.ts
git commit -m "feat(settings): add autoCheckUpdates preference"
```

---

### Task 3: Implement `UpdateManager` and unit tests

**Files:**
- Create: `src/main/updater.ts`
- Create: `test/updater.test.ts`

**Interfaces:**
- Consumes: `AppSettings`
- Produces:
  - `UpdateState` type: `'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'`
  - `UpdateInfo` interface
  - `UpdaterBackend` interface
  - `createUpdateManager(deps: UpdateManagerDeps): UpdateManager`

- [ ] **Step 1: Write failing tests in `test/updater.test.ts`**

Write tests using a mock `UpdaterBackend`:
- Test 1: returns initial idle state with currentVersion.
- Test 2: checking for update transitions to `checking` then `available` when backend finds a release.
- Test 3: checking when no update exists transitions to `not-available`.
- Test 4: download progress events update `progress` (0-100) and status to `downloading`.
- Test 5: update-downloaded event transitions status to `downloaded`.
- Test 6: backend error transitions status to `error` with the error message.
- Test 7: concurrent `checkForUpdates` calls do not trigger duplicate checks.
- Test 8: `installUpdate` calls backend's `quitAndInstall`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/updater.test.ts`
Expected: FAIL with `Cannot find module '../src/main/updater'`

- [ ] **Step 3: Implement `src/main/updater.ts`**

Define types:
```ts
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateInfo {
  status: UpdateState
  currentVersion: string
  availableVersion?: string
  releaseDate?: string
  releaseNotes?: string
  progress?: number
  transferred?: number
  total?: number
  error?: string
}

export interface UpdaterBackend {
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
  on(event: string, listener: (...args: any[]) => void): this
}
```
Implement `createUpdateManager`:
- Tracks current `UpdateInfo`.
- Subscribes to backend events (`checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `error`).
- Notifies listener callback `onChange(info)`.
- Handles dev mode flag (`isPackaged`): if `!isPackaged`, can return `not-available` with a development notice or bypass cleanly.
- Export `ElectronAutoUpdaterBackend` implementing `UpdaterBackend` by wrapping `electron-updater`'s `autoUpdater`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/updater.ts test/updater.test.ts
git commit -m "feat(updater): implement UpdateManager with event lifecycle"
```

---

### Task 4: Expose Update IPC Channels and Preload API

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `test/ipc.test.ts`

**Interfaces:**
- Consumes: `UpdateManager`, `UpdateInfo` from `src/main/updater.ts`
- Produces:
  - `AppEvent` variant: `{ type: 'update-status'; status: UpdateInfo }`
  - IPC channels: `drive-mirror:get-update-status`, `drive-mirror:check-for-updates`, `drive-mirror:download-update`, `drive-mirror:install-update`
  - Preload `DriveMirrorApi`:
    - `getUpdateStatus(): Promise<UpdateInfo>`
    - `checkForUpdates(): Promise<UpdateInfo>`
    - `downloadUpdate(): Promise<void>`
    - `installUpdate(): Promise<void>`

- [ ] **Step 1: Write failing test in `test/ipc.test.ts`**

Add tests asserting that updater IPC channels are registered and delegate to `UpdateManager`:
```ts
it('handles update check and download IPC requests', async () => { ... })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ipc.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `src/main/ipc.ts` and `src/preload/index.ts`**

In `src/main/ipc.ts`:
- Add `updater: UpdateManager` to `IpcDeps`.
- Add `{ type: 'update-status'; status: UpdateInfo }` to `AppEvent`.
- Register handlers for `drive-mirror:get-update-status`, `drive-mirror:check-for-updates`, `drive-mirror:download-update`, and `drive-mirror:install-update`.

In `src/preload/index.ts`:
- Add the methods to `DriveMirrorApi` and expose them through `ipcRenderer.invoke`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ipc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts test/ipc.test.ts
git commit -m "feat(ipc): expose update management channels through preload"
```

---

### Task 5: Integrate `UpdateManager` into Application Startup Lifecycle

**Files:**
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `createUpdateManager`, `ElectronAutoUpdaterBackend` from `src/main/updater.ts`
- Produces: Lifecycle integration of automatic update checking on app startup

- [ ] **Step 1: Update `src/main/index.ts` to instantiate `UpdateManager`**

- Instantiate `updateManager = createUpdateManager({ ... })` with `autoUpdater` backend, logger, and `app.getVersion()`.
- Listen to `updateManager.onChange` and emit `{ type: 'update-status', status }` to `mainWindow`.
- Pass `updater: updateManager` into `registerIpc(deps)`.

- [ ] **Step 2: Add startup update check**

In `app.whenReady()`, after the window is created and file counts are primed:
```ts
const settings = await currentSettings()
if (settings.autoCheckUpdates !== false && app.isPackaged) {
  setTimeout(() => {
    void updateManager.checkForUpdates().catch((err) => {
      logger.log({ level: 'warn', message: `auto-update check failed: ${err.message}` })
    })
  }, 5000)
}
```

- [ ] **Step 3: Run typecheck and existing tests**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): wire update manager into main process lifecycle"
```

---

### Task 6: UI - Add Update Notification Banner and Settings Tab Section

**Files:**
- Modify: `src/renderer/components/settings/AppSettings.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles/components.css`
- Modify: `src/renderer/styles/shell.css`

**Interfaces:**
- Consumes: `window.driveMirror.getUpdateStatus`, `checkForUpdates`, `downloadUpdate`, `installUpdate`, `onEvent`
- Produces:
  - Updates section in `AppSettingsTab` showing current version, auto-check toggle, check button, and download/restart actions.
  - In-app notification banner in `App.tsx` when an update is available or ready to install.

- [ ] **Step 1: Add Updates Section to `AppSettings.tsx`**

In `AppSettingsTab`:
- Accept props or manage local state for `updateInfo` and `onSaveSettings({ autoCheckUpdates })`.
- Render "Updates" card:
  - Displays "Drive Mirror v{currentVersion}".
  - Checkbox: "Check for updates automatically".
  - "Check for updates" button (disabled while checking or downloading).
  - Status messages:
    - Checking: "Checking for new releases..."
    - Not available: "You are on the latest version."
    - Available: "Version v{availableVersion} is available." + "Download update" button.
    - Downloading: Progress bar and "{progress}% downloaded".
    - Downloaded: "Update ready to install." + "Restart and install" button.
    - Error: Display error message in error styling.

- [ ] **Step 2: Add Update Banner to `App.tsx`**

In `App.tsx`:
- Track `updateInfo: UpdateInfo | null`.
- On mount, query `window.driveMirror.getUpdateStatus()`.
- Listen for `event.type === 'update-status'` and update state.
- If `updateInfo.status === 'available'` or `updateInfo.status === 'downloaded'`:
  - Show a banner above or below the title bar / main view.
  - Button to "Download" or "Restart & Install", plus dismiss button.

- [ ] **Step 3: Add CSS styles for update card and progress bar**

In `components.css` / `shell.css`:
- Add `.update-banner`, `.update-progress-bar`, `.update-progress-fill`.

- [ ] **Step 4: Verify typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/AppSettings.tsx src/renderer/App.tsx src/renderer/styles/components.css src/renderer/styles/shell.css
git commit -m "feat(ui): add update banner and settings tab update controls"
```

---

### Task 7: GitHub Actions Release Workflow and Documentation

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: GitHub tag push `v*`
- Produces: Automated release build with Windows NSIS installer and `latest.yml` update manifest.

- [ ] **Step 1: Create `.github/workflows/release.yml`**

Workflow configured to run on tag pushes matching `v*` and manual `workflow_dispatch`:
- Checks out code.
- Installs Node 24.
- Runs `npm ci`.
- Runs `npm run typecheck` and `npm test`.
- Builds and packages Windows installer: `npm run dist -- --publish always` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.

- [ ] **Step 2: Update `README.md`**

Document the update mechanism:
- How in-app updates work.
- How to release a new version (updating `package.json` version, pushing git tag `vX.Y.Z`).

- [ ] **Step 3: Run full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "ci: add github actions release workflow and documentation"
```

