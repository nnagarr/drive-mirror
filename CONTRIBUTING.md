# Contributing

Thanks for looking at Drive Mirror.

## Getting set up

```bash
npm install
npm test          # the test suite
npm run typecheck # both TypeScript projects
npm run dev       # run it from source
npm run dist      # build the Windows installer
```

Node 24 and Windows are the primary development environment. The unit test suite itself
runs anywhere Node does.

## How the code is laid out

- `src/core/` - The decision engine. What should sync, what should not, and why.
  It has no Electron, no network, and no knowledge of the interface. This is
  where core synchronization rules live, and where tests are focused.
- `src/drive/` - The only layer that communicates with Google Drive APIs.
- `src/main/` - The Electron main process: window creation, secure IPC bridges,
  DPAPI credential storage, Windows Task Scheduler automation, and sync runner dispatch.
- `src/preload/` - Secure IPC bridge isolating renderer from system capabilities.
- `src/renderer/` - The user interface (React 19). It cannot read files or reach
  the network directly; it calls the main process through strictly typed IPC channels.
- `test/` - The test suite, including an invariant exhaustiveness matrix over the diff engine states.

## The core invariants

1. **The app must never permanently delete anything from Drive.** A file removed locally is moved to the Drive Trash, where Google keeps it for thirty days. The Drive client has no delete endpoint.
2. **The app must never write outside a folder the user configured.** Every run resolves the Drive destination folder first and writes only beneath it.
3. **The app must never mix two Google accounts.** A file id in one account means nothing in another. Account credentials, manifests, schedules, and histories remain isolated.
4. **No drive letters hardcoded in `src/`.** The application must run cleanly across any Windows volume layout.
5. **No test writes outside temporary directories.** All test operations use isolated temporary folders (`mkdtemp`).
6. **The mirror list is configuration; the manifest is history.** Changing a mirror does not erase history.
7. **One schedule, one runner.** The in-app timer and the Windows scheduled task are mutual alternatives to prevent duplicate runs.
8. **Double locking.** Process-level locking for concurrent triggers in the UI, and file-level locking for background tasks.
9. **Core modules remain pure.** `src/core` never imports from `electron`.

## Pull requests

- `npm run typecheck` and `npm test` must both pass cleanly. Unused variables and dead code fail the build.
- If you modify a rule in `src/core/diff.ts`, add unit test coverage and ensure the exhaustiveness matrix test (`test/exhaustiveness.test.ts`) passes.
- Keep commits clear, focused, and well-described.
