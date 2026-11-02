/**
 * Window state persistence and multi-monitor validation.
 *
 * Remembers window bounds (x, y, width, height) and maximized state,
 * and ensures coordinates remain safely on a visible connected display.
 */

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

const DEFAULT_WIDTH = 1180
const DEFAULT_HEIGHT = 760
const MIN_WIDTH = 960
const MIN_HEIGHT = 640
const MIN_VISIBLE_OVERLAP = 100

/**
 * Calculates whether a window rectangle overlaps an active display work area
 * by at least minOverlap pixels in both width and height.
 */
function hasSufficientOverlap(
  winX: number,
  winY: number,
  winW: number,
  winH: number,
  display: DisplayLike,
  minOverlap = MIN_VISIBLE_OVERLAP,
): boolean {
  const { x: dX, y: dY, width: dW, height: dH } = display.workArea

  const overlapX = Math.max(0, Math.min(winX + winW, dX + dW) - Math.max(winX, dX))
  const overlapY = Math.max(0, Math.min(winY + winH, dY + dH) - Math.max(winY, dY))

  return overlapX >= Math.min(minOverlap, winW) && overlapY >= Math.min(minOverlap, winH)
}

/**
 * Computes centered coordinates for a window on a given display's work area.
 */
function centerOnDisplay(width: number, height: number, display: DisplayLike): { x: number; y: number } {
  const { x, y, width: dW, height: dH } = display.workArea
  return {
    x: Math.round(x + Math.max(0, (dW - width) / 2)),
    y: Math.round(y + Math.max(0, (dH - height) / 2)),
  }
}

/**
 * Validates saved window state against connected displays.
 * If the saved position is off-screen (e.g. disconnected monitor),
 * falls back to centering the window on the primary display.
 */
export function validateWindowState(
  saved: WindowState | null | undefined,
  displays: DisplayLike[],
  primaryDisplay: DisplayLike,
): WindowState {
  const isMaximized = saved?.isMaximized ?? false
  const width = Math.max(MIN_WIDTH, saved?.width ?? DEFAULT_WIDTH)
  const height = Math.max(MIN_HEIGHT, saved?.height ?? DEFAULT_HEIGHT)

  if (saved?.x === undefined || saved?.y === undefined || displays.length === 0) {
    const centered = centerOnDisplay(width, height, primaryDisplay)
    return {
      x: centered.x,
      y: centered.y,
      width,
      height,
      isMaximized,
    }
  }

  // Check if saved (x, y, width, height) has sufficient overlap with any display work area
  const isVisibleOnAnyDisplay = displays.some((d) =>
    hasSufficientOverlap(saved.x!, saved.y!, width, height, d),
  )

  if (isVisibleOnAnyDisplay) {
    return {
      x: saved.x,
      y: saved.y,
      width,
      height,
      isMaximized,
    }
  }

  // Fallback to primary display center
  const centered = centerOnDisplay(width, height, primaryDisplay)
  return {
    x: centered.x,
    y: centered.y,
    width,
    height,
    isMaximized,
  }
}

