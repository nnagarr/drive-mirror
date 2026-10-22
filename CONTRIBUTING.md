# Contributing

Thanks for looking at this.

## Getting set up

```bash
npm install
npm test          # the test suite
npm run typecheck # both TypeScript projects
npm run dev       # run it from source
```

Node 24 and Windows are what it is developed against. The test suite itself
runs anywhere Node does.

## How the code is laid out

- `src/core/` - the rules. What should sync, what should not, and why. It
  has no Electron, no network, and no knowledge of the interface. This is
  where the interesting decisions live, and where the tests are.
- `src/drive/` - the only code that talks to Google.
- `src/main/` - the Electron main process: the window, the IPC bridge, and
  the runner that ties the rules to the Drive.
- `src/renderer/` - the interface. It cannot read a file or reach the
  network; it calls the main process through a fixed set of channels.
- `test/` - the tests, including an exhaustiveness matrix over the diff
  engine's inputs.
- `docs/superpowers/` - the design document and the implementation plan the
  code was built from. They are worth reading before changing a rule.

## The one rule

**The app must never destroy the only copy of a file.** Every rule that
overwrites or removes something archives the bytes being replaced first, and
if that archive cannot be written the destructive action is skipped, not
continued. When you add a rule, keep that promise.

> **Amended, 2026-10-22.** The app no longer archives. A file that changes
> replaces the copy on Drive, and a file that is deleted goes to the Drive
> trash, where Google keeps it for thirty days. Nothing is stored locally.
>
> The rule that remains: **the app must never permanently delete anything
> from Drive, and it must never write outside a folder the user gave it.**
> The Drive trash is the safety net for deletions. There is no safety net for
> a replacement, and that is a decision, not an oversight — see the v2
> design, section 8, amendment A2.

## The second rule

**The app must never mix two Google accounts.** A file id in one account's
manifest means nothing in another account's Drive, so an account's file list,
its sign-in, its schedule and its history belong to that account and to no
other. Every rule that touches a file, a folder or a mirror names the
account it belongs to, and the core stays account-free: it is handed one
account's work at a time and knows nothing about the others.

## The rules the code holds to

These are the ones a change can break without any test going red, so they are
worth checking by hand.

- **No drive letter in `src/`.** Nothing in the source may name `E:` or any
  other drive. The app has to run on a machine with no `E:` at all, and the
  mirrors the user chooses are the only ones it knows about.
- **No test writes outside its own temporary directory.** The test suite used
  to overwrite the user's real backup of the manifest on every run, because a
  path was hardcoded and the test never overrode it. Anything a test writes
  goes in a `mkdtemp` directory.
- **The mirror list is configuration; the manifest is history.** The list of
  mirrors lives in `settings.json`. The manifest records what has been
  synced. Changing one never touches the other, and nothing in the app
  destroys the manifest - not a connection reset, not an account change, not
  an uninstall.
- **One schedule, one way to run it.** The in-app timer and the Windows
  task are alternatives. Both being on would mean two syncs per slot.
- **Two locks stand in front of a run.** One in the process, so a second
  "Sync now" joins the run already going; one on disk, so a scheduled run in
  its own process and the window cannot write the manifest at the same time.
- **A new core module imports nothing from `electron`.** A module whose only
  job is file I/O may import `node:fs`; everything else is pure.

## Pull requests

- `npm run typecheck` and `npm test` both have to pass. The compiler is
  configured to treat unused code as an error, so dead code fails the
  build.
- If you change a rule in `src/core/diff.ts`, add the case to the test that
  covers it, and check the exhaustiveness matrix still passes.
- Say what you changed and why. The design document is the reference; if the
  behaviour changes, the document should change with it.
