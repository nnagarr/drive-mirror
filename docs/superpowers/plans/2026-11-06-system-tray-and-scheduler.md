# System Tray & Background Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow scheduled syncs to run continuously in the background by minimizing to the Windows System Tray on close ('X'), removing the external Windows Task Scheduler mechanism, and supporting silent auto-start at Windows login.

**Architecture:** CLI parsing is extended with `--hidden` for headless background startup. A focused `tray.ts` module manages the system tray icon, click-to-restore, and tray context menu. `window.ts` and `index.ts` intercept the close event to hide the window rather than terminating the process unless explicit quit is triggered. `SchedulePanel.tsx` and `scheduler.ts` remove the `windows-task` mechanism, and app startup cleans up legacy scheduled tasks from Windows Task Scheduler.

**Tech Stack:** Electron (`Tray`, `Menu`, `app`, `BrowserWindow`), React, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-system-tray-and-scheduler-design.md`

## Global Constraints
- Native Electron implementation: no extra third-party tray or daemon npm dependencies.
- Window 'X' hides window to system tray; minimize ('-') keeps window in Windows taskbar.
- Process termination only happens when user selects "Quit Drive Mirror" from the tray menu or via OS shutdown.
- All scheduled syncs run via the in-app scheduler timer while the process lives in the tray.
- Legacy Windows Scheduled Tasks created by earlier versions are purged on startup.

## Review Focus
- **Tray double-click / click response**: Clicking the tray icon when the window is hidden restores visibility and brings the window to focus.
- **Quit cleanly without being blocked by close interception**: When "Quit Drive Mirror" is selected, the window must close and the app process must terminate cleanly.
- **Second instance wakeup**: If the user launches the app shortcut while the app is already hidden in the tray, it must un-hide and focus the window instead of launching a second process.
- **Silent launch with `--hidden`**: Launching with `--hidden` (e.g. from Windows startup) must not flicker or show the main window until user interacts with the tray.
- **Schedule continues firing when hidden**: In-app timers continue to trigger sync runs while the window is hidden in the tray.

---

### Task 1: CLI `--hidden` Flag Support

**Files:**
- Modify: `src/main/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface CliOptions {
    syncOnce: boolean
    accountId: string | null
    hidden: boolean
  }
  export function parseCli(argv: string[]): CliOptions
  ```

- [ ] **Step 1: Write failing test in `test/cli.test.ts`**

```typescript
it('recognizes the --hidden flag', () => {
  const options = parseCli(['node', 'app', '--hidden'])
  expect(options.hidden).toBe(true)
})

it('defaults hidden to false when not provided', () => {
  const options = parseCli(['node', 'app'])
  expect(options.hidden).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL due to `options.hidden` being undefined.

- [ ] **Step 3: Implement `hidden` option in `src/main/cli.ts`**

Update `parseCli` to check for `arg === '--hidden'` and set `hidden = true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/cli.ts test/cli.test.ts
git commit -m "feat(cli): add --hidden flag support"
```

---

### Task 2: System Tray Module

**Files:**
- Create: `src/main/tray.ts`
- Test: `test/tray.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface TrayDeps {
    iconPath: string
    onOpen: () => void
    onSyncNow: () => void
    onQuit: () => void
  }

  export interface TrayLike {
    setToolTip(toolTip: string): void
    setContextMenu(menu: unknown): void
    destroy(): void
  }

  export function createAppTray(
    deps: TrayDeps,
    trayFactory?: (icon: string) => TrayLike,
    menuBuilder?: (template: unknown[]) => unknown,
  ): TrayLike
  ```

- [ ] **Step 1: Write unit tests in `test/tray.test.ts`**

Test that `createAppTray`:
1. Instantiates tray with the provided `iconPath`.
2. Sets tooltip to "Drive Mirror".
3. Builds context menu with "Open Drive Mirror", "Sync now", and "Quit Drive Mirror".
4. Dispatches `onOpen` when "Open Drive Mirror" is clicked.
5. Dispatches `onSyncNow` when "Sync now" is clicked.
6. Dispatches `onQuit` when "Quit Drive Mirror" is clicked.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tray.test.ts`
Expected: FAIL (module `src/main/tray.ts` does not exist).

- [ ] **Step 3: Implement `createAppTray` in `src/main/tray.ts`**

Use Electron's `Tray` and `Menu` as default factories when not injected.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tray.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/tray.ts test/tray.test.ts
git commit -m "feat(tray): create system tray module"
```

---

### Task 3: Window Lifecycle and Close-to-Tray Integration

**Files:**
- Modify: `src/main/window.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes:
  - `createAppTray` from `src/main/tray.ts`
  - `CliOptions.hidden` from `src/main/cli.ts`
- Produces:
  - `createMainWindow(initialState?: WindowState, onSaveState?: (state: WindowState) => void, options?: { startHidden?: boolean }): BrowserWindow`
  - Window 'close' event interception preventing close and hiding window when `!isQuitting`.
  - Auto-launch `setLoginItemSettings` configured with `args: ['--hidden']`.

- [ ] **Step 1: Update `createMainWindow` in `src/main/window.ts`**

Add `options?: { startHidden?: boolean }`. On `ready-to-show`, only call `window.show()` (and `window.maximize()`) if `!options?.startHidden`.

- [ ] **Step 2: Integrate Tray and Close Interception in `src/main/index.ts`**

1. Maintain `let isQuitting = false`.
2. Add `app.on('before-quit', () => { isQuitting = true })`.
3. Intercept `mainWindow.on('close', (event) => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } })`.
4. Initialize `createAppTray`:
   - `onOpen`: `mainWindow.show()`, `mainWindow.focus()`.
   - `onSyncNow`: triggers sync on current account runtime.
   - `onQuit`: `isQuitting = true; app.quit()`.
5. Update `second-instance` handler:
   ```typescript
   if (mainWindow) {
     if (!mainWindow.isVisible()) mainWindow.show()
     if (mainWindow.isMinimized()) mainWindow.restore()
     mainWindow.focus()
   }
   ```
6. Update `applyAutoLaunch`:
   ```typescript
   app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] })
   ```
7. Pass `{ startHidden: cli.hidden }` into `createMainWindow`.

- [ ] **Step 3: Run existing test suite to ensure no regressions**

Run: `npm test`
Expected: PASS (all tests pass).

- [ ] **Step 4: Commit**

```bash
git add src/main/window.ts src/main/index.ts
git commit -m "feat(window): integrate system tray and close-to-tray lifecycle"
```

---

### Task 4: Remove Windows Task Scheduler Option and Cleanup Legacy Tasks

**Files:**
- Modify: `src/renderer/components/SchedulePanel.tsx`
- Modify: `src/main/scheduler.ts`
- Modify: `src/main/index.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes:
  - `unregisterLegacyTask()` and `unregisterTask()` from `src/main/taskScheduler.ts`
- Produces:
  - `SchedulePanel.tsx` UI without "How it runs" dropdown.
  - `scheduler.ts` without registering Windows scheduled tasks.
  - Startup routine in `index.ts` that purges any lingering Windows tasks.

- [ ] **Step 1: Write / Update tests in `test/scheduler.test.ts`**

Verify that `applySchedule()` does not call `deps.registerTask()`, always arms the in-app timer when enabled, and removes any task if present.

- [ ] **Step 2: Run test to verify current state**

Run: `npx vitest run test/scheduler.test.ts`
Expected: PASS or identifies lines expecting `windows-task`.

- [ ] **Step 3: Modify `src/renderer/components/SchedulePanel.tsx`**

Remove the "How it runs" `<select>` element and its description hint. Schedules are now always managed by the active app.

- [ ] **Step 4: Modify `src/main/scheduler.ts`**

In `applySchedule()`, remove logic that delegates to `deps.registerTask()`. If a task exists, unregister it. Always use in-app arming.

- [ ] **Step 5: Add startup task cleanup in `src/main/index.ts`**

On startup in `app.whenReady()`, run:
```typescript
await unregisterLegacyTask().catch(() => {})
for (const account of appSettings.accounts) {
  await unregisterTask(account.email).catch(() => {})
}
```

- [ ] **Step 6: Run full test suite to verify all tests pass**

Run: `npm test`
Expected: PASS (all 34+ test files pass).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/SchedulePanel.tsx src/main/scheduler.ts src/main/index.ts test/scheduler.test.ts
git commit -m "feat(scheduler): remove windows-task option and purge legacy tasks"
```
