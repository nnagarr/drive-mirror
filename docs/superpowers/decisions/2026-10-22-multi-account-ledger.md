# The ledger of the multi-account work

**Date:** 2026-10-22
**Branch:** `feature/multi-account`, merged into `main` at `09ff148`
**Plan:** `docs/superpowers/plans/2026-10-22-drive-mirror-multi-account.md`
**Spec:** `docs/superpowers/specs/2026-10-22-drive-mirror-multi-account-design.md`

This is the record of the decisions taken while the work was being done, and
of what the review found. The decisions the user was told about are in
`2026-10-21-v2-rulings.md` (rulings 23 to 29). The ones here are about how
the work was carried out.

---

## Before any code was written

**1 — The settings split, the migration and the four consumer files are ONE
task, not three.** The old Task 2 could not stand alone: `Settings` becomes
`AppSettings`, and `index.ts`, `runner.ts`, `ipc.ts` and `scheduler.ts` all
read the fields it removes. The old Task 5 could not stand alone either: it
must run before the app's settings file is rewritten, or the legacy mirrors
and schedule are gone. And the old Task 3 had to exist first, because the
migration writes an account's settings file. *Cost if wrong:* the merged task
is large, and a reviewer has to accept the settings split, the migration and
the consumer updates as a unit.

**2 — The migration reads the legacy settings file itself.** The plan gave
`migrateToAccounts` a `legacySettings` dependency while its own step 3 said
the function reads `legacy\settings.json` and then `settings.json`. Two
sources for one value, and the copy-of-record ordering — which is the whole
safety of the migration — would be split across two places. *Decided:* the
migration reads the file itself, in that order, and the singular
`backupPath` shim lives in one place: `withLegacyDefaults`, exported from
`src/main/settings.ts`. *Cost if wrong:* one extra exported function.

**3 — The execution order is 1, 3, 2, 4, 6, 7, 8, 9, 10, 11, 12, with the
old Task 5 folded into the old Task 2.** The plan document was amended to
match. *Cost if wrong:* the plan file's task numbers did not match the
execution order until it was amended.

## While the tasks were being done

**Task 1 — `backupDirFor` takes a backup root, not the app root.** The plan's
two assertions for it could not both hold: one passed the app root and
expected the `backups` segment added, the other passed a backup root and
expected nothing added. The spec's shape decides it — the app's own copy
lives at `backups\<email>\` and a named one at `<location>\<email>\` — so the
function takes a backup root and the app's own is `appBackupDir(root)`. The
test was corrected, not the code. *Cost if wrong:* one argument's meaning at
the call site.

**Task 3 — The store tests use a temporary directory**, not the plan's
`C:\appdata\DriveMirror`, which would have written real files outside the
worktree. *Cost if wrong:* none; the temporary root is the same shape.
`SafeStorageLike` was already exported from `src/main/settings.ts`, so the
brief's step 5 was a no-op. `mergeValue` is now exported too, so the
one-level merge of a partial file over the defaults lives in one place
rather than twice. The brief's test also had an unescaped apostrophe in a
name and a mistyped account id.

**Task 2 + 5 — The runner's client and manifest store are resolved per
call**, rather than injected as values, because they belong to an account and
the account can change. *Cost if wrong:* the later per-account task
consolidates them. **The settings file holds an account's record; the
derived state — signed in, mirror count, has notice — is worked out from the
account's own files every time it is asked for, so it is never stored.**
*Cost if wrong:* one extra field in the file.

**Task 4 — A new account's folder is made when the account is created**, not
when it first syncs, so an account is a world from the moment it exists.
*Cost if wrong:* one directory appears earlier than it used to.

**Task 6 — The runner remembers one object per account** — the cards, the
last run, the running flag, the phase and the in-flight promise — rather
than six separate maps keyed by mirror name. The behaviour is the one the
spec asks for; only the shape of the bookkeeping differs. *Cost if wrong:*
one map instead of six. **A busy lock is waited out, not failed:** the run
waits up to five minutes at sixty-second intervals, and says "waiting" while
it does. *Cost if wrong:* a run can be delayed by the length of the other
account's sync.

**Task 7 — The scheduler is one instance per account**, held in a map by the
app, and each instance's Windows task is named after the account. The
command line carries `--account <id>`, so a task knows which account it is
for. *Cost if wrong:* Task Scheduler shows one entry per account rather than
one for the app. The migration removes the old task by its old name, through
a separate `unregisterLegacyTask`, because that task has no account to be
named after.

**Task 8 + 9 — The preload's account-scoped methods take the account id as
an optional LAST argument**, while the IPC's channels take it first. The
wire order is the account's, but the interface always works on the account on
screen, so it never has to name one. *Cost if wrong:* the two orders differ,
which is confusing to read. The sign-in reads the address with a client
built over the token that has just come back, so nothing is written to disk
until the app knows which account the sign-in belongs to. A refused sign-in
leaves nothing behind.

**Task 10 — The switcher lives in the top bar**, in the place the account
label was, so nothing new is laid out. The renderer has no test setup and
none was added, so this task is verified by the typecheck, the build and the
IPC contract it uses.

---

## What the review found, and what was done about it

The whole branch was reviewed at the end. Three defects came out of it, and
two of them would have broken the second account outright.

**Fixed — the guard and the backup writer used the account on screen
instead of the account being run.** The second account's first run stamped
the first account's address on its own manifest, and from then on every one
of its runs was blocked with "this manifest belongs to somebody else". Its
manifest backup was written into the first account's backup folder too. The
running account carries its own address, and that is what is used now.

**Fixed — the test harness was hiding it.** The harness gave every account
the same address, so the guard could never tell two accounts apart and the
tests passed for the wrong reason. Each account has its own address now, and
the tests assert each manifest's owner and each backup's folder.

**Fixed — the migration was not resumable.** The marker was written last,
after the old files had been moved aside. A failure in between deleted the
account folder, manifest and all, and left the manifest in the legacy
folder, where the app would never read it again. The marker now comes
before anything is moved aside, so a failure leaves the old files where they
were, and the tidying-up afterwards cannot undo the migration.

**Fixed — an empty account id would have deleted the whole accounts
folder.** `path.join` drops an empty segment, so `accounts\` plus an empty id
is the accounts folder itself. The path refuses an empty id, and the
interface refuses a call that names no account or one it does not know.

**Fixed — the interface went stale after switching, connecting or forgetting
an account.** The refresh now re-reads the app's settings, the account's
settings and the state. Before, the switcher showed the old address, the
event filter dropped the new account's events, and the settings dialog
showed the previous account's schedule.

**Fixed — signing in to an account that is already connected was allowed**,
and the reason for a refusal was thrown away. The result carries a message
now.

**Fixed — a missed slot waited a whole period.** It is retried as soon as
the lock is free.

**Fixed — the settings dialog was missing the app's own controls**:
start-with-Windows, and the extra place to keep a copy of every account's
manifest.

**Restored — two planned units the branch had dropped**: the token refresh
in its own module, with a test, and the command line's test. The review's
fourth focus condition now has a test: a refresh writes the new token to
that account's file and touches no other.

**Minor, also fixed:** the log names the account each line came from; the
state names the account it is about; a scheduled run that names an account
the app does not know says so; signing out of the account on screen moves to
another one; the file git treated as binary is text again; the recovered
file's name is not shared between two runs; the README names the button the
way it is actually called; the plan referred to a ruling that does not exist.

---

## What the review set aside, and what I decided about each

The review listed the things it would not judge. Each one is a decision, so
each one is decided here rather than left dangling.

**Downgrade support.** An older build writing the old manifest after the
migration would be ignored, and the mirrors would be lost. *Decided:* out of
scope. The spec chooses this design for the public app, not for the install
that exists, and the migration keeps the old files in `legacy\` where a
person can find them. *Cost if wrong:* a user who runs an old build after the
upgrade has to re-add their mirrors.

**The `isRunMissed` and `nextFireAt` arithmetic in `src/core/schedule.ts`.**
Untouched by this branch. *Decided:* left alone. The scheduler now retries a
missed slot itself, and the core's arithmetic is still the arithmetic it
always was. *Cost if wrong:* none.

**The renderer having no test setup.** The plan forbids adding one.
*Decided:* kept. The renderer is verified by the typecheck, the build and
the IPC contract it uses. *Cost if wrong:* a mistake in the interface is
found by a person, not by a test.

**The task builder's names.** The plan called them `buildCreateArgs` and
`buildDeleteArgs`; they are `buildSchtasksArgs` and `buildDeleteArgs(email)`.
*Decided:* the plan's names could not carry the address the task name needs,
and the behaviour matches the spec. *Cost if wrong:* two names differ from
the plan's.

**`AppSettings.clientId`.** Not in the spec's §6.1, but §6.1's note keeps
it as a read-only projection of the credential store. *Decided:* kept. The
interface needs the client id to show it, and it is never written to the
file. *Cost if wrong:* one field more than the spec lists.

**"Forget this account" deleting permanently rather than archiving.** The
user's recorded choice. *Decided:* kept. *Cost if wrong:* the app forgets
which files it uploaded, so adding the same folder again re-uploads
everything. The copies of the manifest in the backup folders survive.

**Shared drives, service accounts, domain-wide delegation, per-mirror
schedules, and a "sync every account at once" button.** *Decided:* out of
scope; they are the spec's explicit non-goals. *Cost if wrong:* none.

**The recovered file's temporary name.** Pre-existing at the base commit, and
now fixed anyway: the name carries a random suffix, so two runs cannot
share it. *Cost if wrong:* none.

---

## The state at the end

- The suite: **424 tests, 29 files, all passing**. The typecheck and the
  build are clean.
- The engine is still account-free. `src/core/` gained two lines: the
  `account?: string` field on `LogEvent`.
- The review's five focus conditions each have a test.
