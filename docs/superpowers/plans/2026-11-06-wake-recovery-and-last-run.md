# Wake-Up Recovery, Accurate Missed Runs & Last Run Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accurately detect and run missed schedules immediately when waking from sleep/hibernate or starting up, show a toast notification, and display real timestamps and clear outcomes in the "Last run" overview strip.

**Architecture:** Pure algorithmic fixes to `isRunMissed()` in `schedule.ts` support daily and weekly wall-clock slots. `index.ts` expands `onResume` to handle screen unlock and displays notifications when the window is hidden in tray. `LastRun.tsx` and `format.ts` format real timestamps and output `"Everything up to date"`.

**Tech Stack:** TypeScript, React, Electron (`powerMonitor`, `Notification`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-wake-recovery-and-last-run-design.md`

## Global Constraints
- Maximize reliability of sleep/hibernate detection across Windows modern standby and sleep states.
- Catch-up runs occur once on wake/startup, never looping or double-firing.
- Cap lists at 5 items in responses.

## Review Focus
- **Short sleep through daily slot**: Sleeping from 11:30 PM to 7:30 AM through a 2:00 AM daily slot must register as missed despite total duration < 24 hours.
- **Immediate wake run**: On waking from sleep, the run starts immediately without waiting for the next timer cycle.
- **Next regular slot preserved**: After catch-up completes, the next run is armed for its normal recurring time.
- **Zero changes display**: Runs with no changes show "Everything up to date" rather than "0 errors".
- **Notifications while in tray**: Notifications fire when the window is hidden in the system tray (`!mainWindow.isVisible()`).

---

### Task 1: Accurate Missed-Run Calculation for Daily and Weekly Shapes

**Files:**
- Modify: `src/core/schedule.ts`
- Test: `test/schedule.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function isRunMissed(shape: ScheduleShape, lastRunAt: string | null, now: Date): boolean
  ```

- [ ] **Step 1: Write failing tests in `test/schedule.test.ts`**
  Add tests for:
  - Daily schedule at 02:00 missed when last run was yesterday at 23:30 and now is 07:30.
  - Weekly schedule missed when last run was before the scheduled day/time and now is after.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/schedule.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement wall-clock slot check in `isRunMissed`**
  In `src/core/schedule.ts`, calculate the latest past slot for daily/weekly shapes.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/schedule.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/core/schedule.ts test/schedule.test.ts
  git commit -m "fix(schedule): accurately detect missed daily and weekly runs"
  ```

---

### Task 2: Wake-Up Notification and Sleep Recovery

**Files:**
- Modify: `src/main/scheduler.ts`
- Modify: `src/main/index.ts`
- Test: `test/scheduler.test.ts`

**Interfaces:**
- Consumes:
  - `isRunMissed` from `src/core/schedule.ts`
  - `deps.notify` from `src/main/scheduler.ts`

- [ ] **Step 1: Write unit test in `test/scheduler.test.ts`**
  Verify that when `catchUpIsDue()` is true, `deps.notify` is called with `"Catching up on missed scheduled sync"`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/scheduler.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `src/main/scheduler.ts` and `src/main/index.ts`**
  1. In `src/main/scheduler.ts`, notify before running catch-up.
  2. In `src/main/index.ts`, listen to `powerMonitor.on('unlock-screen')` alongside `resume`.
  3. In `src/main/index.ts`, update `emit()` to show notifications when `!mainWindow || !mainWindow.isVisible()`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/scheduler.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/main/scheduler.ts src/main/index.ts test/scheduler.test.ts
  git commit -m "feat(scheduler): notify and catch up on missed runs after sleep"
  ```

---

### Task 3: Real Time and Outcome Status in Last Run UI

**Files:**
- Modify: `src/renderer/format.ts`
- Modify: `src/renderer/components/overview/LastRun.tsx`
- Modify: `src/renderer/components/SchedulePanel.tsx`
- Test: `test/format.test.ts`

**Interfaces:**
- Produces:
  - `formatLastRunCounts(c: RunCounts): string` returning `"Everything up to date"` when counts and errors are 0.
  - Enhanced `LastRun.tsx` rendering both real date/time and relative time.

- [ ] **Step 1: Write failing test in `test/format.test.ts`**
  Verify that `formatLastRunCounts` returns `"Everything up to date"` for zero counts.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run test/format.test.ts`
  Expected: FAIL

- [ ] **Step 3: Update `format.ts`, `LastRun.tsx`, and `SchedulePanel.tsx`**
  1. In `format.ts`, return `"Everything up to date"` if no changes and 0 errors.
  2. In `LastRun.tsx`, format real timestamp with `formatFriendlyDate` alongside relative time.
  3. In `SchedulePanel.tsx`, display `Last run was at ...` if available.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/format.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/renderer/format.ts src/renderer/components/overview/LastRun.tsx src/renderer/components/SchedulePanel.tsx test/format.test.ts
  git commit -m "feat(ui): display real time and friendly status for last run"
  ```
