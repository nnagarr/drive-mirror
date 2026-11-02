# Window State & Multi-Monitor Persistence Design

## 1. Intent & Context
Drive Mirror currently initializes with a hardcoded `1180x760` window on the primary monitor. In multi-monitor and custom desktop setups, users moving the window to a secondary monitor or resizing/maximizing it lose their window arrangement upon app restart.

## 2. Goals & Non-Goals
- **Goals**:
  - Persist window position (`x`, `y`), size (`width`, `height`), and `isMaximized` state.
  - Multi-monitor preservation: restore window on the exact monitor it was last closed on.
  - Disconnect guard: if a monitor was disconnected while the app was closed, detect that coordinates are off-screen and gracefully reposition to the primary display.
  - Preserve normal bounds: restoring from maximized returns to the user's custom unmaximized dimensions.
- **Non-Goals**:
  - Kiosk or borderless fullscreen persistence beyond standard maximize.
  - Different window bounds per Google account.

## 3. Architecture & Mechanics

### State Model
```typescript
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}
```

### Persistence
- Stored in `settings.json` under `windowState` via the existing atomic `settingsStore`.
- Defaults to `{ width: 1180, height: 760, isMaximized: false }`.

### Multi-Monitor Validation (`validateWindowState`)
- Given `savedState` and `displays: Electron.Display[]`:
  - Verify that a rectangle of `(x, y, width, height)` intersects at least one connected display's `workArea` with a minimum margin (e.g. 50px).
  - If valid, return the saved bounds.
  - If invalid (monitor disconnected or coordinates corrupted), return safe centered defaults on `screen.getPrimaryDisplay()`.

### Event Tracking
- On `resize` and `move`: update in-memory non-maximized bounds when `!window.isMaximized()`. Debounce persistence by 300ms.
- On `maximize` / `unmaximize`: track `isMaximized`.
- On `close`: flush the latest bounds synchronously to settings.
- On startup in `createMainWindow(state)`:
  - Supply `x`, `y`, `width`, `height` to `new BrowserWindow(...)`.
  - When showing, if `state.isMaximized` is true, call `window.maximize()`.

