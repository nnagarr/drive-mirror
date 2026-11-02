# Window State & Multi-Monitor Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remember and restore the app's window size, position, monitor, and maximized state across sessions, safely handling multi-monitor changes.

**Architecture:** A pure `windowState.ts` module with `validateWindowState()` verifies saved coordinates against connected display work areas. Window listeners track non-maximized bounds and maximized state, debouncing writes to `settings.json` and saving immediately on close.

**Tech Stack:** Electron (`BrowserWindow`, `screen`), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-window-state-persistence-design.md`

## Global Constraints
- Native implementation: no third-party window state npm packages.
- Persist state atomically in `settings.json` under `windowState`.
- Fall back gracefully to primary monitor if a saved screen position is off-screen or disconnected.
- Maintain minimum dimensions: `960x640`. Default dimensions: `1180x760`.

## Review Focus
- **Monitor disconnected while closed**: Saved coordinates (e.g. `x=1920, y=100`) on a secondary monitor no longer exist; window must center safely on primary display.
- **Maximized on close**: Reopening must maximize the window, and unmaximizing must restore the previous custom size.
- **Negative coordinates**: Secondary monitors positioned to the left or top of primary have negative x/y; valid negative coordinates must not be reset.
- **Partially off-screen window**: If a window was dragged almost entirely off-screen, clamp it to ensure at least 100px overlap with a usable work area.
- **Atomic write on close**: Closing the app via 'X' must synchronously or reliably persist the final bounds before process exit.

---

### Task 1: Window State Validation Engine

**Files:**
- Create: `src/main/windowState.ts`
- Test: `test/windowState.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface WindowState {
    x?: number
    y?: number
    width: number
    height: number
    isMaximized: boolean
  }

  export interface DisplayLike {
    bounds: { x: number; y: number; width: number; height: number }
    workArea: { x: number; y: number; width: number; height: number }
  }

  export function validateWindowState(
    saved: WindowState | null | undefined,
    displays: DisplayLike[],
    primaryDisplay: DisplayLike,
  ): WindowState
  ```

- [ ] **Step 1: Write unit tests for window state validation**
  Cover:
  - Default state when `saved` is null/undefined (1180x760, centered on primary, not maximized).
  - Valid coordinates on primary display preserved.
  - Valid coordinates on secondary display (positive and negative coordinates) preserved.
  - Off-screen coordinates (disconnected monitor) reset to centered primary display.
  - Minimum size enforcement (`minWidth: 960, minHeight: 640`).
  - `isMaximized` flag preserved.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/windowState.test.ts`
  Expected: FAIL (`Cannot find module '../src/main/windowState'`)

- [ ] **Step 3: Implement `validateWindowState` in `src/main/windowState.ts`**
  Implement overlap computation checking intersection between window rect and display work areas.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/windowState.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/main/windowState.ts test/windowState.test.ts
  git commit -m "feat(window): add window state validation and multi-monitor overlap detection"
  ```

---

### Task 2: Settings Schema Integration

**Files:**
- Modify: `src/main/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `WindowState` from `src/main/windowState.ts`
- Produces: `AppSettings.windowState?: WindowState`

- [ ] **Step 1: Write test for persisting `windowState` in `test/settings.test.ts`**
  Verify default `windowState` and patching `windowState`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run test/settings.test.ts`
  Expected: FAIL with TS type error or assertion error.

- [ ] **Step 3: Update `src/main/settings.ts`**
  Add `windowState?: WindowState` to `AppSettings`, `defaultAppSettings`, and `readAppSettings`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run test/settings.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/main/settings.ts test/settings.test.ts
  git commit -m "feat(settings): add windowState persistence to AppSettings"
  ```

---

### Task 3: Window Lifecycle Integration & Tracking

**Files:**
- Modify: `src/main/window.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `validateWindowState` from `src/main/windowState.ts`, `settingsStore` from `src/main/settings.ts`.
- Produces: `createMainWindow(initialState?: WindowState, onSaveState?: (state: WindowState) => void): BrowserWindow`

- [ ] **Step 1: Update `src/main/window.ts`**
  - Accept `initialState` and `onSaveState` in `createMainWindow`.
  - Pass `x`, `y`, `width`, `height` to `new BrowserWindow(...)`.
  - Listen for `resize` and `move`: if not maximized, record bounds and debounce callback (300ms).
  - Listen for `maximize` and `unmaximize`: update `isMaximized` and trigger callback.
  - Listen for `close`: immediately flush current state.
  - On `ready-to-show`: if `initialState?.isMaximized`, call `window.maximize()`.

- [ ] **Step 2: Update `src/main/index.ts`**
  - Before creating the window, read `appSettings.windowState`.
  - Validate with `validateWindowState` against `screen.getAllDisplays()` and `screen.getPrimaryDisplay()`.
  - Pass validated state and save callback to `createMainWindow`.

- [ ] **Step 3: Run full verification suite**
  Run: `npm run typecheck && npm test && npm run build`
  Expected: All checks pass.

- [ ] **Step 4: Commit**
  ```bash
  git add src/main/window.ts src/main/index.ts
  git commit -m "feat(window): restore and persist window bounds, maximize state, and monitor"
  ```
