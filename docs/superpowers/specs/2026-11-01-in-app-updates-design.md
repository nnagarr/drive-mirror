# In-App Updates Design

## Overview & Intent
Drive Mirror users who have the Windows app installed currently have no mechanism to know when fixes, improvements, or new releases are published to GitHub, nor any way to update the application in-place.

This feature adds in-app update management for installed users:
1. Detecting new releases published on GitHub.
2. Alerting users via an in-app banner and a dedicated "Updates" card in App Settings.
3. Allowing users to trigger checks, download updates, and restart to apply updates without manually redownloading and running an installer.
4. Providing automated GitHub Actions CI/CD to build, package, and publish releases whenever a version tag is pushed.

## Goals
- Check for updates on startup (configurable) and on demand via Settings.
- Display current application version and update status (idle, checking, available, downloading with progress, downloaded, error).
- Safely download and trigger NSIS silent/passive update on restart using `electron-updater`.
- Gracefully handle development mode, offline state, and GitHub network errors without crashing.
- Automatically build and attach Windows installer assets and update metadata (`latest.yml`) on GitHub version tags.

## Non-Goals & Anti-Goals
- Auto-updating source code in git repositories (this is specifically for packaged desktop app installations).
- Forcing instant restarts while a sync run is actively in progress.
- Unsigned certificate warnings bypass (the NSIS installer runs through standard Windows execution).

## Approaches Considered

### Approach 1: `electron-updater` with GitHub Releases (Selected)
- **Mechanism**: Official `electron-builder` companion library. `electron-builder.yml` specifies GitHub publish metadata. When building releases, `electron-builder` outputs `latest.yml` with sha512 checksums alongside the setup exe. `electron-updater` validates checksums, downloads differentials or full installers, and handles restart & install.
- **Trade-offs**: Requires adding `electron-updater` dependency. In return, provides robust checksum verification, background downloading, progress events, and standard NSIS installation integration.

### Approach 2: Custom GitHub REST API Polling + Direct Executable Download
- **Mechanism**: Use `fetch()` against `api.github.com/repos/nnagarr/drive-mirror/releases/latest`, parse release asset URLs, download `.exe` using Node streams, and execute `child_process.spawn`.
- **Trade-offs**: Zero new runtime dependencies, but requires implementing custom checksum verification, partial file downloads, resume support, and NSIS launch arguments manually. More fragile than using the battle-tested library designed for `electron-builder`.

## User Experience & UI
- **In-App Notification**: An update banner appears in the top area of `App.tsx` when an update is available or downloaded, with buttons to download or restart.
- **Settings Page**: A new "Updates" section in `AppSettingsTab`:
  - Current version (`vX.Y.Z`).
  - Toggle: "Check for updates automatically".
  - Button: "Check for updates".
  - Status display with download progress indicator.
  - Buttons: "Download update", "Restart and install".

## Architecture
- `src/main/updater.ts`: `UpdateManager` manages update lifecycle, communicates with `UpdaterBackend` (wrapping `electron-updater`), handles dev-mode safety and errors, and emits status events.
- `src/main/settings.ts`: Stores user preference `autoCheckUpdates` (default `true`).
- `src/main/ipc.ts` & `src/preload/index.ts`: IPC channels for check, download, install, and status polling/events.
- `src/renderer`: React UI integration in `AppSettings.tsx` and `App.tsx`.
- `.github/workflows/release.yml`: GitHub Actions workflow building and publishing releases on `v*` tags.

