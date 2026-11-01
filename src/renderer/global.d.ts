import type { DriveMirrorApi } from '../preload'

declare global {
  interface Window {
    /** The bridge the preload script exposes. */
    driveMirror: DriveMirrorApi
  }
}

export {}
