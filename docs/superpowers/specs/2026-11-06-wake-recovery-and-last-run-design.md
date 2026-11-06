# Wake-Up Recovery, Accurate Missed Runs & Last Run Display Design

## 1. Intent & Context
When a laptop is shut down, sleeping, or hibernating, scheduled syncs can be missed. Currently, `isRunMissed` does not correctly detect missed `daily` or `weekly` wall-clock times if the sleep period was under 24 hours. Additionally, the overview bar displays relative times without real timestamps or a clear "Everything up to date" outcome.

## 2. Goals & Non-Goals
- **Goals**:
  - Accurate missed run detection for all schedules (`every-hours`, `daily`, `every-days`, `weekly`).
  - Upon waking from sleep/hibernate or starting up, run the missed sync once immediately, notify the user, and schedule the next normal slot.
  - Windows toast notifications while hidden in tray for catch-up syncs, errors, and safety guards.
  - Show real clock/calendar timestamp in the "Last run" strip (e.g. `Today at 2:15 PM` or `Nov 6, 2:15 PM`) alongside relative time.
  - Show clear outcome text (e.g. `Everything up to date` when 0 changes and 0 errors, or detailed change counts).
  - Show `Last run was at ...` in `SchedulePanel.tsx`.
- **Non-Goals**:
  - Running multiple missed runs in rapid succession (only one catch-up run occurs, then clock moves to next regular slot).

## 3. Architecture & Mechanics

### Accurate Missed Runs (`src/core/schedule.ts`)
- For `daily`: calculate latest scheduled occurrence of `at` before `now`. If `lastRun < latestOccurrence`, return `true`.
- For `weekly`: calculate latest scheduled occurrence of `(day, at)` before `now`. If `lastRun < latestOccurrence`, return `true`.
- For interval-based (`every-hours`, `every-days`): `now - last >= intervalMs(shape)`.

### Wake Recovery & Notification (`src/main/index.ts`, `src/main/scheduler.ts`)
- Listen to both `powerMonitor.on('resume')` and `powerMonitor.on('unlock-screen')`.
- On wake or start, when `catchUpIsDue()` is true:
  - Display Windows toast: `Drive Mirror: Catching up on missed scheduled sync`.
  - Execute `runNow()`.
  - Re-arm timer for next standard slot.
- Ensure `emit()` in `src/main/index.ts` triggers Windows notifications whenever `!mainWindow || !mainWindow.isVisible()`.

### Last Run UI Enhancement (`src/renderer/format.ts`, `LastRun.tsx`, `SchedulePanel.tsx`)
- In `formatLastRunCounts()`: return `"Everything up to date"` if all counts are 0 and errors are 0.
- In `LastRun.tsx`: display formatted date/time plus relative time, with the computed outcome line.
- In `SchedulePanel.tsx`: display last run time if present.
