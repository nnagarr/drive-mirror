# System Tray & Background Scheduler Design

## 1. Intent & Context
Currently, Drive Mirror offers two scheduling mechanisms: in-app timer (only while open) and Windows Task Scheduler (`windows-task`). When users close the app window with 'X', the app exits completely, stopping all in-app scheduled runs.
This change removes the external Windows Task Scheduler mechanism entirely in favor of running purely within the application. To allow schedules to run continuously without cluttering the screen or taskbar, closing the window ('X') hides the application to the Windows System Tray. The app also supports starting minimized to the tray when launching on Windows startup.

## 2. Goals & Non-Goals
- **Goals**:
  - System Tray icon in the Windows notification area with context menu ("Open Drive Mirror", "Sync now", "Quit Drive Mirror") and click-to-restore.
  - Window 'X' (close button) hides the window to the tray instead of terminating the process, keeping scheduled syncs active.
  - Minimize button ('-') maintains normal taskbar minimize behavior.
  - Full app termination is triggered explicitly via the Tray context menu "Quit Drive Mirror" or standard OS termination.
  - Re-launching the app via shortcut / second instance un-hides and focuses the existing window.
  - Support `--hidden` command-line argument for startup at login, ensuring the app starts silently in the tray without opening a window.
  - Remove the "How it runs" (`windows-task` vs `in-app`) selection in `SchedulePanel.tsx`. All schedules run via the in-app scheduler.
  - Automatically unregister and clean up all legacy Windows Scheduled Tasks created by older versions upon app startup.
- **Non-Goals**:
  - Creating multiple tray icons for different Google accounts (single app tray icon handles active app state).
  - Minimizing directly to tray when '-' is clicked (user explicitly chose minimize to taskbar).

## 3. Architecture & Mechanics

### System Tray (`src/main/tray.ts`)
- Manages Electron `Tray` instance using `appIconPath()`.
- Single click / double click: restores `mainWindow` (`show()`, `focus()`).
- Context menu options:
  - `Open Drive Mirror`: restores and focuses window.
  - `Sync now`: triggers sync on the currently selected account.
  - Separator.
  - `Quit Drive Mirror`: sets `isQuitting = true` and calls `app.quit()`.

### Window Lifecycle & Close Interception (`src/main/window.ts`, `src/main/index.ts`)
- Track `isQuitting` in `src/main/index.ts`.
- Listen to `mainWindow.on('close', (event) => { if (!isQuitting) { event.preventDefault(); mainWindow.hide(); } })`.
- Listen to `app.on('before-quit', () => { isQuitting = true; })`.
- In `createMainWindow`, accept optional `startHidden?: boolean` configuration. When `startHidden` is true, do not call `window.show()` on `ready-to-show`.

### CLI & Auto-Launch (`src/main/cli.ts`, `src/main/index.ts`)
- Update `parseCli` to recognize `--hidden` flag: `{ hidden: boolean, ... }`.
- In `applyAutoLaunch(enabled: boolean)`:
  - `app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] })`.

### Scheduler & UI Simplification (`src/main/scheduler.ts`, `SchedulePanel.tsx`, `taskScheduler.ts`)
- In `SchedulePanel.tsx`, remove the "How it runs" select dropdown and its explanatory hint.
- In `src/main/index.ts`, during startup:
  - Unregister legacy task `unregisterLegacyTask()`.
  - Unregister any account task `unregisterTask(account.email)` for all registered accounts.
- In `scheduler.ts`, simplify `applySchedule()` so that it no longer creates Windows scheduled tasks.
