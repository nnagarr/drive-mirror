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

## Pull requests

- `npm run typecheck` and `npm test` both have to pass. The compiler is
  configured to treat unused code as an error, so dead code fails the
  build.
- If you change a rule in `src/core/diff.ts`, add the case to the test that
  covers it, and check the exhaustiveness matrix still passes.
- Say what you changed and why. The design document is the reference; if the
  behaviour changes, the document should change with it.
