# Multiple Google Accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One install of Drive Mirror holds several Google accounts at once, each a separate world with its own mirrors, schedule, manifest and sign-in, switchable from a dropdown in the top bar.

**Architecture:** The core engine is untouched — `src/core/` gains no account concept. Every account owns a folder under `accounts\` holding its settings, manifest, journal and tokens; the app-wide `settings.json` holds the account registry and the shared client id. One shared `Runner` resolves the account per call and keeps its per-account state in maps keyed by account id; one `Scheduler` instance exists per account. The app-wide `sync.lock` keeps two accounts from ever syncing at once, and a run that cannot take the lock is marked `skipped` so the schedule's clock does not advance and the slot is caught up.

**Tech Stack:** TypeScript (strict), Electron 3x main + React 19 renderer, Vite, Vitest, `better-sqlite3`-free, Node's `fs/promises` and `safeStorage`, `schtasks.exe` for the Windows scheduled task.

**Spec:** `docs/superpowers/specs/2026-10-22-drive-mirror-multi-account-design.md`

## Global Constraints

- No drive letter and no personal path may appear in `src/`. `test/freshInstall.test.ts` enforces this.
- No secret is committed. The client secret is stored only in `credentials.json`, encrypted with `safeStorage`.
- The app keeps **no copy** of any file it replaces. There is no archive, and none may be reintroduced.
- `src/core/` gains **no** account concept. `accountEmail` in the manifest keeps its present meaning: "the Google account that owns this manifest".
- The manifest's `version` stays **11**. The manifest's shape does not change; only the path it lives at does.
- The OAuth scope stays `https://www.googleapis.com/auth/drive`. The app keeps asking each user for their own client id; no client id is baked into the binary.
- The IPC surface goes from **23 channels to 27**.
- The renderer has no test setup and none is added. Renderer work is verified by `npm run typecheck` and `npm run build`.
- `npm run typecheck` must be clean, `npm test` must be green, `npm run build` must succeed, at the end of every task.
- `vitest.config.ts` already sets `testTimeout: 20000`. Do not lower it.
- Every task ends with a commit. Commits use the message style already in the repository: a short summary line, then a paragraph saying what changed and why.
- The app's user-facing copy is English. Code comments are English.

## Review Focus

Five conditions a person using this software would expect to work, that the spec implies but no task's own tests would otherwise catch. Each has a test in the task that owns the code.

1. **The same local folder is mirrored into two accounts, and a file is deleted locally.** The file must be trashed on *both* Drives, and neither account's manifest may show the other's file list.
2. **The user signs out of an account and signs back in with the same address.** The mirrors, the schedule, the file list and the Drive destinations must all be exactly as they were.
3. **A scheduled slot arrives while the app is busy with another account.** The slot must be caught up, not lost. (This is a live bug in today's build.)
4. **An account's token expires while the app is closed.** The refresh must use that account's own credentials and write back to that account's token file, and must not touch any other account's file.
5. **The user connects a second account while the first account's run is in progress.** The first run's results must stay in the first account's world, and the second account's world must be untouched.

---

## File structure

**New, in `src/main/`**

| File | One responsibility |
|---|---|
| `accountPaths.ts` | The on-disk layout: where an account's folder and files live, the account id generator, the path sanitiser. |
| `accountSettings.ts` | The per-account settings store: read and write `accounts\<id>\settings.json`. |
| `accountTokens.ts` | The per-account token store: read, write and clear `accounts\<id>\tokens.json`. |
| `accounts.ts` | The account registry: the list, the summaries, create, find by email, forget, set current. |
| `refreshToken.ts` | Refreshing one account's access token, and writing it back to that account's file. |
| `migrate.ts` | The one-time migration from the single-account layout. |
| `cli.ts` | Parsing the command line. |

**New, in `test/`**

| File | What it covers |
|---|---|
| `accounts.test.ts` | The layout, the per-account stores, the registry. |
| `migrate.test.ts` | The migration, including its failure paths. |
| `cli.test.ts` | The command line. |

**Modified**

| File | What changes |
|---|---|
| `src/main/settings.ts` | `Settings` becomes `AppSettings`; `AccountRecord` and `AccountSummary` are added; the credential store is unchanged. |
| `src/main/notice.ts` | Made generic over any settings object carrying a `pendingNotice`. |
| `src/main/index.ts` | The wiring: the registry, the runtimes, the scheduler map, the events, the notices, the migration, the command line. |
| `src/main/runner.ts` | The account resolver; the per-account cards, in-flight promise, running flag, phase, guard and last run; the per-account backups; `skipped` on the summary. |
| `src/main/scheduler.ts` | One instance per account; a skipped run does not advance the clock. |
| `src/main/taskScheduler.ts` | The per-account task name and the `--account` argument. |
| `src/main/ipc.ts` | 27 channels; `AppState` gains `accountId`; `AppEvent` gains `accountId`; `RunSummary` gains `skipped`. |
| `src/preload/index.ts` | The preload API to match. |
| `src/core/logger.ts` | `LogEvent` gains an optional `account`. |
| `src/core/mirrorConfig.ts` | `validateMirror` is unchanged; callers pass one account's mirror list. |
| `src/renderer/App.tsx` | The switcher, the account-scoped state, the event filter. |
| `src/renderer/components/AccountSwitcher.tsx` | **New.** The dropdown. |
| `src/renderer/components/SettingsDialog.tsx` | The app-wide and account sections; "Connect an account". |
| `src/renderer/global.d.ts` | The preload types. |
| `src/renderer/styles.css` | The dropdown. |
| `README.md`, `CONTRIBUTING.md` | The new layout, the new actions, the new promises. |

---

### Task 1: The account layout

**Files:**
- Create: `src/main/accountPaths.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every path helper below, used by every later task.

- [ ] **Step 1: Write the failing test**

`test/accounts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  accountsDir, accountDir, accountSettingsPath, accountManifestPath,
  accountJournalPath, accountTokensPath, accountArchiveDir, appBackupDir,
  backupDirFor, legacyDir, sanitiseForPath, newAccountId,
} from '../src/main/accountPaths'

const ROOT = join('C:', 'appdata', 'DriveMirror')

describe('the account layout', () => {
  it('puts every account under the accounts folder', () => {
    expect(accountsDir(ROOT)).toBe(join(ROOT, 'accounts'))
    expect(accountDir(ROOT, 'acc_7f3a2b')).toBe(join(ROOT, 'accounts', 'acc_7f3a2b'))
  })

  it('gives each account its own settings, manifest, journal and tokens', () => {
    const dir = accountDir(ROOT, 'acc_7f3a2b')
    expect(accountSettingsPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'settings.json'))
    expect(accountManifestPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'manifest.json'))
    expect(accountJournalPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'journal.ndjson'))
    expect(accountTokensPath(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'tokens.json'))
    expect(accountArchiveDir(ROOT, 'acc_7f3a2b')).toBe(join(dir, 'manifest-archive'))
  })

  it('keeps the app backup folder and the legacy folder apart from the accounts', () => {
    expect(appBackupDir(ROOT)).toBe(join(ROOT, 'backups'))
    expect(legacyDir(ROOT)).toBe(join(ROOT, 'legacy'))
  })

  it('names a backup folder after the account that owns it', () => {
    expect(backupDirFor(ROOT, 'you@example.com'))
      .toBe(join(ROOT, 'backups', 'you@example.com'))
    expect(backupDirFor(join('E:', 'backup'), 'you@example.com'))
      .toBe(join('E:', 'backup', 'you@example.com'))
  })

  it('makes a name safe to write to disk', () => {
    expect(sanitiseForPath('a@b.com')).toBe('a@b.com')
    expect(sanitiseForPath('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(sanitiseForPath('')).toBe('account')
  })

  it('makes an account id that is not an email', () => {
    const id = newAccountId()
    expect(id).toMatch(/^acc_[0-9a-f]{12}$/)
    expect(id).not.toContain('@')
    expect(newAccountId()).not.toBe(id)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/accounts.test.ts`
Expected: FAIL — "Failed to resolve import '../src/main/accountPaths'".

- [ ] **Step 3: Implement `src/main/accountPaths.ts`**

Every function takes the app data root as its first argument, so nothing in this file reads a global. Signatures:

```ts
export function accountsDir(root: string): string
export function accountDir(root: string, id: string): string
export function accountSettingsPath(root: string, id: string): string
export function accountManifestPath(root: string, id: string): string
export function accountJournalPath(root: string, id: string): string
export function accountTokensPath(root: string, id: string): string
export function accountArchiveDir(root: string, id: string): string
export function appBackupDir(root: string): string
export function backupDirFor(root: string, email: string): string
export function legacyDir(root: string): string
export function sanitiseForPath(name: string): string
export function newAccountId(): string
```

`sanitiseForPath` replaces `/ \ : * ? " < > |` and the control characters with `_`, and returns `'account'` for an empty result. `newAccountId` returns `'acc_' + randomBytes(6).toString('hex')`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/accounts.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green with 6 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/accountPaths.ts test/accounts.test.ts
git commit -m "feat: where an account lives on disk

Every account gets a folder under accounts\\, holding its settings,
manifest, journal and tokens. The paths are pure functions of the app
data root, so nothing in the module reads a global and the whole layout
can be tested without a disk."
```

---

### Task 2: The app-wide settings

**Files:**
- Modify: `src/main/settings.ts:54-121` (the `Settings` interface and `defaultSettings`), `:202-299` (the store and `withDefaults`)
- Modify: `src/main/notice.ts` (make it generic)
- Test: `test/settings.test.ts`, `test/notice.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AccountRecord`, `AccountSummary`, `AppSettings`, `defaultAppSettings()`, `createSettingsStore` over `AppSettings`.

- [ ] **Step 1: Write the failing test**

In `test/settings.test.ts`, replace the assertions on the flat `Settings` shape with:

```ts
it('starts with no accounts and no current account', async () => {
  const s = defaultAppSettings()
  expect(s.accounts).toEqual([])
  expect(s.currentAccountId).toBeNull()
  expect(s.clientSecretSet).toBe(false)
  expect(s.extraBackupPath).toBeNull()
  expect(s.guardThreshold).toBe(5)
  expect(s.startWithWindows).toBe(false)
  expect(s.pendingNotice).toBeNull()
})

it('keeps an account it was given and drops the keys it does not know', async () => {
  const store = createSettingsStore(file)
  await store.write({
    ...defaultAppSettings(),
    accounts: [{
      id: 'acc_7f3a2b', email: 'you@example.com', addedAt: '2026-10-22T00:00:00.000Z',
      signedIn: true, mirrorCount: 4, hasNotice: false,
    }],
    currentAccountId: 'acc_7f3a2b',
  })
  const read = await store.read()
  expect(read.accounts).toHaveLength(1)
  expect(read.accounts[0]?.email).toBe('you@example.com')
  expect(read.currentAccountId).toBe('acc_7f3a2b')
  expect(Object.keys(read as object)).not.toContain('mirrors')
  expect(Object.keys(read as object)).not.toContain('schedule')
})

it('never writes the client id to the file', async () => {
  await store.write({ ...defaultAppSettings(), clientSecretSet: true })
  const onDisk = await readFile(file, 'utf8')
  expect(onDisk).not.toContain('clientId')
})
```

In `test/notice.test.ts`, the notice functions are called with a settings object of either shape, so the assertions become:

```ts
it('leaves a note on a settings object of any shape', async () => {
  const app = setPendingNotice(defaultAppSettings(), 'the backup could not be written', new Date())
  expect(app.pendingNotice?.message).toBe('the backup could not be written')
  expect(clearPendingNotice(app).pendingNotice).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/settings.test.ts test/notice.test.ts`
Expected: FAIL — `defaultAppSettings` is not exported, and `setPendingNotice` does not accept an `AppSettings`.

- [ ] **Step 3: Rewrite the settings type**

In `src/main/settings.ts`, replace `Settings` with:

```ts
export interface AccountRecord {
  /** The opaque id. The folder name and the key everywhere. */
  id: string
  /** The Google address this account is signed in as. */
  email: string
  /** ISO timestamp. */
  addedAt: string
}

/** What the switcher needs to draw one line. */
export interface AccountSummary extends AccountRecord {
  /** Whether the account has a sign-in. */
  signedIn: boolean
  /** How many mirrors it has configured. */
  mirrorCount: number
  /** Whether it has a notice that has not been shown. */
  hasNotice: boolean
}

export interface AppSettings {
  /** Every account this install knows about, signed in or not. */
  accounts: AccountSummary[]
  /** Which account the app is showing. Null when there are none. */
  currentAccountId: string | null
  /** Whether a client secret is stored. The secret itself is never here. */
  clientSecretSet: boolean
  /** The smallest folder size the count-drop guard applies to. */
  guardThreshold: number
  /** Start with Windows. */
  startWithWindows: boolean
  /** One extra place to keep a copy of each manifest. Null for none. */
  extraBackupPath: string | null
  /** A problem with the app itself, shown once. */
  pendingNotice: { message: string; at: string } | null
}
```

`defaultSettings()` becomes `defaultAppSettings(): AppSettings`, returning the defaults above. `ScheduleConfig` stays in this file unchanged.

`withDefaults` is rewritten to enumerate the new fields and to **ignore every key it does not know**, so an old `settings.json` carrying `mirrors`, `schedule` and `backupPaths` loads as an app settings file with no mirrors and no schedule. `mergeValue` and `isPlainObject` are unchanged.

`createSettingsStore` keeps its current shape — `read()`, `write(s)`, `patch(p)` — over `AppSettings`. `write` still deletes `clientId` before serialising, so a client id can never reach the file.

- [ ] **Step 4: Make the notice module generic**

In `src/main/notice.ts`, change the two functions to:

```ts
export interface PendingNotice {
  message: string
  at: string
}

export interface HasPendingNotice {
  pendingNotice: PendingNotice | null
}

export async function setPendingNotice<T extends HasPendingNotice>(
  settings: T,
  message: string,
  now: Date,
): Promise<T>

export async function clearPendingNotice<T extends HasPendingNotice>(
  settings: T,
): Promise<T>
```

Both return a new object and never mutate the one they were given.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/settings.test.ts test/notice.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix everything that referenced the old `Settings` type**

Run: `npm run typecheck`
Expected: errors in `src/main/index.ts`, `src/main/runner.ts`, `src/main/ipc.ts`, `src/main/scheduler.ts` and their tests. **Do not fix them yet** — later tasks replace those files. Instead, for this task only, make the typecheck pass by giving each of those call sites the shape they need, with a `// TODO(multi-account): replaced in task N` comment naming the task that replaces it.

Every one of those call sites is replaced by a later task. Do not build the account machinery here.

- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green.

- [ ] **Step 8: Commit**

```bash
git add src/main/settings.ts src/main/notice.ts test/settings.test.ts test/notice.test.ts
git commit -m "feat: the app-wide settings carry the account list

The flat settings object is split. What belongs to the app - the list of
accounts, which one is current, the client id flag, the guard
threshold, start-with-Windows, the extra backup location - stays in
settings.json. What belongs to an account moves into the account's own
folder, in the next task.

The store now ignores keys it does not know, so an old settings file
loads without complaint and its mirrors and schedule are simply not
there. The notice functions are generic over any settings object that
carries a notice, so the same code serves an account and the app."
```

---

### Task 3: The per-account stores

**Files:**
- Create: `src/main/accountSettings.ts`
- Create: `src/main/accountTokens.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Consumes: `accountPaths.ts` (Task 1), `AppSettings` and `ScheduleConfig` (Task 2), `MirrorConfig` (`src/core/mirrorConfig.ts`), `OAuthTokens` (`src/drive/oauth.ts`).
- Produces: `AccountSettings`, `defaultAccountSettings()`, `createAccountSettingsStore`, `createAccountTokenStore`.

- [ ] **Step 1: Write the failing test**

Add to `test/accounts.test.ts`:

```ts
describe('the account settings store', () => {
  it('starts with no mirrors, no schedule and no notice', () => {
    const s = defaultAccountSettings()
    expect(s.mirrors).toEqual([])
    expect(s.schedule.enabled).toBe(false)
    expect(s.schedule.mechanism).toBe('in-app')
    expect(s.schedule.lastRunAt).toBeNull()
    expect(s.schedule.nextRunAt).toBeNull()
    expect(s.pendingNotice).toBeNull()
  })

  it('reads and writes one account without touching another', async () => {
    const store = createAccountSettingsStore(ROOT)
    await store.write('acc_7f3a2b', {
      ...defaultAccountSettings(),
      mirrors: [{ name: 'Medicine', root: 'E:\\Medicine', drivePath: 'Archive/Medicine', enabled: true }],
    })
    const a = await store.read('acc_7f3a2b')
    expect(a.mirrors).toHaveLength(1)
    expect(a.mirrors[0]?.name).toBe('Medicine')
    const b = await store.read('acc_91c4de')
    expect(b.mirrors).toEqual([])
  })

  it('writes the account settings where the layout says', async () => {
    const store = createAccountSettingsStore(ROOT)
    await store.write('acc_7f3f3a2b', defaultAccountSettings())
    const raw = JSON.parse(await readFile(accountSettingsPath(ROOT, 'acc_7f3a2b'), 'utf8'))
    expect(raw.mirrors).toEqual([])
  })
})

describe('the account token store', () => {
  it('has no tokens for an account that has never signed in', async () => {
    const tokens = createAccountTokenStore(ROOT, safeStorage)
    expect(await tokens.read('acc_7f3a2b')).toBeNull()
    expect(await tokens.has('acc_7f3a2b')).toBe(false)
  })

  it('keeps one account's tokens out of another account's file', async () => {
    const tokens = createAccountTokenStore(ROOT, safeStorage)
    await tokens.write('acc_7f3a2b', { access_token: 'a', refresh_token: 'r', expiry_date: 1, scope: 's', token_type: 'Bearer' })
    expect((await tokens.read('acc_7f3a2b'))?.access_token).toBe('a')
    expect(await tokens.read('acc_91c4de')).toBeNull()
    await tokens.clear('acc_7f3a2b')
    expect(await tokens.has('acc_7f3a2b')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/accounts.test.ts`
Expected: FAIL — "Failed to resolve import '../src/main/accountSettings'".

- [ ] **Step 3: Implement `src/main/accountSettings.ts`**

```ts
export interface AccountSettings {
  /** The mirrors this account has configured. */
  mirrors: MirrorConfig[]
  /** How often this account syncs on its own. */
  schedule: ScheduleConfig
  /** A problem from a run the user did not watch, shown once. */
  pendingNotice: { message: string; at: string } | null
}

export function defaultAccountSettings(): AccountSettings

export interface AccountSettingsStore {
  read(id: string): Promise<AccountSettings>
  write(id: string, settings: AccountSettings): Promise<AccountSettings>
  exists(id: string): Promise<boolean>
}

export function createAccountSettingsStore(root: string): AccountSettingsStore
```

`read` returns `defaultAccountSettings()` when the file is missing, and merges a partial file over the defaults one level deep, so a file written by an older build still loads. `write` uses `writeAtomic` from `src/core/atomic.ts` and creates the account folder first.

- [ ] **Step 4: Implement `src/main/accountTokens.ts`**

```ts
export interface AccountTokenStore {
  read(id: string): Promise<OAuthTokens | null>
  write(id: string, tokens: OAuthTokens): Promise<void>
  clear(id: string): Promise<void>
  has(id: string): Promise<boolean>
}

export function createAccountTokenStore(
  root: string,
  safeStorage: SafeStorageLike,
): AccountTokenStore
```

The on-disk shape is unchanged from today's `tokens.json`: `{"payload":"<base64 of the safeStorage-encrypted JSON>"}`. `read` returns `null` for a missing file and for any file it cannot read. `write` creates the account folder first. `clear` removes the file and does nothing when it is not there.

`SafeStorageLike` is the interface `createCredentialStore` already takes at `src/main/settings.ts:130`. **Export it from `src/main/settings.ts`** and import it here, so there is one definition of it.

- [ ] **Step 5: Export `SafeStorageLike` from `src/main/settings.ts`**

```ts
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}
```

`createCredentialStore` takes this type instead of the one it declares today.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/accounts.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green.

- [ ] **Step 8: Commit**

```bash
git add src/main/accountSettings.ts src/main/accountTokens.ts test/accounts.test.ts
git commit -m "feat: an account's settings and its sign-in live in its own folder

The account settings store reads and writes accounts\\<id>\\settings.json
and the token store accounts\\<id>\\tokens.json. The token file keeps
today's shape, so an account's sign-in is encrypted exactly as it was.

The two stores never touch another account's files, which is what makes
the account folder the unit of storage: forgetting an account is one
delete of one folder."
```

---

### Task 4: The account registry

**Files:**
- Create: `src/main/accounts.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Consumes: `AppSettings`, `AccountRecord`, `AccountSummary` (Task 2); `createAccountSettingsStore`, `defaultAccountSettings` (Task 3); `createAccountTokenStore` (Task 3); `accountPaths.ts` (Task 1).
- Produces: `createAccountRegistry`, `AccountRegistry`, `findAccountByEmail`.

- [ ] **Step 1: Write the failing test**

Add to `test/accounts.test.ts`:

```ts
describe('the account registry', () => {
  it('finds an account by its address, whatever the case', async () => {
    const reg = registry()
    const made = await reg.create('You@Example.com')
    expect(await findAccountByEmail(reg.list(), 'you@example.com')).not.toBeNull()
    expect(await findAccountByEmail(reg.list(), 'YOU@EXAMPLE.COM')).not.toBeNull()
    expect(await findAccountByEmail(reg.list(), 'other@example.com')).toBeNull()
    expect(made.email).toBe('You@Example.com')
  })

  it('says whether an account is signed in and how many mirrors it has', async () => {
    const reg = registry()
    const made = await reg.create('you@example.com')
    await accountSettings.write(made.id, {
      ...defaultAccountSettings(),
      mirrors: [{ name: 'A', root: 'E:\\A', drivePath: 'A', enabled: true }],
    })
    await accountTokens.write(made.id, TOKENS)
    const summaries = await reg.list()
    expect(summaries[0]).toMatchObject({
      id: made.id, email: 'you@example.com', signedIn: true, mirrorCount: 1, hasNotice: false,
    })
  })

  it('makes a new account with an empty world', async () => {
    const reg = registry()
    const made = await reg.create('you@example.com')
    expect(await accountSettings.read(made.id)).toEqual(defaultAccountSettings())
    expect(await accountTokens.has(made.id)).toBe(false)
    expect(existsSync(accountDir(ROOT, made.id))).toBe(true)
  })

  it('forgets an account and leaves the others alone', async () => {
    const reg = registry()
    const a = await reg.create('a@example.com')
    const b = await reg.create('b@example.com')
    await accountTokens.write(b.id, TOKENS)
    await reg.forget(a.id)
    expect(existsSync(accountDir(ROOT, a.id))).toBe(false)
    expect(existsSync(accountDir(ROOT, b.id))).toBe(true)
    expect(await accountTokens.has(b.id)).toBe(true)
    expect((await reg.list()).map((x) => x.email)).toEqual(['b@example.com'])
  })

  it('moves the current account and can clear it', async () => {
    const reg = registry()
    const a = await reg.create('a@example.com')
    const b = await reg.create('b@example.com')
    await reg.setCurrent(a.id)
    expect((await appSettings.read()).currentAccountId).toBe(a.id)
    await reg.setCurrent(b.id)
    expect((await appSettings.read()).currentAccountId).toBe(b.id)
    await reg.setCurrent(null)
    expect((await appSettings.read()).currentAccountId).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/accounts.test.ts`
Expected: FAIL — "Failed to resolve import '../src/main/accounts'".

- [ ] **Step 3: Implement `src/main/accounts.ts`**

```ts
export interface AccountRegistry {
  /** Every account, with the fields the switcher draws. */
  list(): Promise<AccountSummary[]>
  /** The account with this address, or null. The comparison ignores case. */
  findByEmail(email: string): Promise<AccountRecord | null>
  /** A new account with an empty world. */
  create(email: string): Promise<AccountRecord>
  /** Delete the account's folder and take it off the list. */
  forget(id: string): Promise<void>
  /** Which account the app is showing. */
  setCurrent(id: string | null): Promise<void>
}

export function createAccountRegistry(deps: {
  appSettings: () => Promise<AppSettings>
  saveAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  accountSettings: AccountSettingsStore
  tokens: AccountTokenStore
}): AccountRegistry

export function findAccountByEmail(
  accounts: AccountSummary[],
  email: string,
): AccountSummary | null
```

`create` makes the folder, writes the account's default settings, and adds the record to the list. `forget` removes the whole folder recursively and takes the record off the list; it does **not** touch the backup copies, which live outside the folder. `list` derives `signedIn` from `tokens.has(id)`, and `mirrorCount` and `hasNotice` from the account's settings file.

The comparison in `findAccountByEmail` lower-cases both sides.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green.

- [ ] **Step 6: Commit**

```bash
git add src/main/accounts.ts test/accounts.test.ts
git commit -m "feat: the registry of accounts

The app keeps a list of the accounts it knows about, whether or not
they are signed in. The list lives in the app-wide settings; each
account's own world lives in its folder.

Two rules the registry holds to. The address a user signs in with is
matched without regard to case, because a Google address is not
case-sensitive and a case-sensitive match would make a second account
for the same person. And forgetting an account removes its folder and
nothing else, so the backup copies of its manifest survive and the file
list can be recovered by hand."
```

---

### Task 5: The migration

**Files:**
- Create: `src/main/migrate.ts`
- Test: `test/migrate.test.ts`

**Interfaces:**
- Consumes: `accountPaths.ts` (Task 1); `AppSettings`, `defaultAppSettings` (Task 2); `createAccountSettingsStore` (Task 3); `createAccountTokenStore` (Task 3).
- Produces: `migrateToAccounts`, `MigrationResult`.

- [ ] **Step 1: Write the failing test**

`test/migrate.test.ts`:

```ts
describe('the migration to accounts', () => {
  it('does nothing when there is no legacy manifest', async () => {
    const result = await migrateToAccounts({ root: ROOT })
    expect(result.migrated).toBe(false)
  })

  it('moves the manifest, the journal, the tokens and the mirrors', async () => {
    seedLegacy()
    const result = await migrateToAccounts({ root: ROOT })
    expect(result.migrated).toBe(true)
    const id = result.accountId
    const manifest = JSON.parse(await readFile(accountManifestPath(ROOT, id!), 'utf8'))
    expect(manifest.version).toBe(11)
    expect(manifest.accountEmail).toBe('you@example.com')
    expect(manifest.mirrors.Medicine.root).toBe('E:\\Medicine')
    expect(existsSync(accountJournalPath(ROOT, id!))).toBe(true)
    const tokens = JSON.parse(await readFile(accountTokensPath(ROOT, id!), 'utf8'))
    expect(typeof tokens.payload).toBe('string')
  })

  it('keeps the schedule, the mechanism and the extra backup location', async () => {
    seedLegacy({ schedule: { enabled: true, shape: { kind: 'daily', at: '02:00' }, mechanism: 'windows-task', lastRunAt: '2026-10-21T00:00:00.000Z', nextRunAt: '2026-10-22T02:00:00.000Z' } })
    await migrateToAccounts({ root: ROOT })
    const id = (await listIds())[0]!
    const s = await accountSettings.read(id)
    expect(s.schedule.enabled).toBe(true)
    expect(s.schedule.shape).toEqual({ kind: 'daily', at: '02:00' })
    expect(s.schedule.mechanism).toBe('windows-task')
    expect(s.schedule.lastRunAt).toBe('2026-10-21T00:00:00.000Z')
    expect((await appSettings.read()).extraBackupPath).toBe('E:\\.drive-mirror-backup')
  })

  it('reads an old file with the singular backupPath', async () => {
    seedLegacy({ backupPath: 'E:\\.drive-mirror-backup' })
    await migrateToAccounts({ root: ROOT })
    expect((await appSettings.read()).extraBackupPath).toBe('E:\\.drive-mirror-backup')
  })

  it('keeps the old files in the legacy folder', async () => {
    seedLegacy()
    await migrateToAccounts({ root: ROOT })
    expect(existsSync(join(legacyDir(ROOT), 'manifest.json'))).toBe(true)
    expect(existsSync(join(legacyDir(ROOT), 'settings.json'))).toBe(true)
    expect(existsSync(join(legacyDir(ROOT), 'journal.ndjson'))).toBe(true)
  })

  it('leaves the old files alone when the copy fails, and starts with no accounts', async () => {
    seedLegacy()
    await writeFile(accountDir(ROOT, 'x'), 'not a directory')  // a file where a folder must be
    const result = await migrateToAccounts({ root: ROOT })
    expect(result.migrated).toBe(false)
    expect(result.error).toBeTruthy()
    expect(existsSync(join(ROOT, 'manifest.json'))).toBe(true)
    expect((await appSettings.read()).accounts).toEqual([])
  })

  it('recovers when it failed after the new settings file was written', async () => {
    seedLegacy()
    // A first attempt that got as far as writing the new app settings and
    // then failed.
    await writeFile(join(ROOT, 'settings.json'), JSON.stringify({ ...defaultAppSettings(), accounts: [] }))
    await writeFile(join(legacyDir(ROOT), 'settings.json'), await readFile(join(ROOT, 'settings.json'), 'utf8'))
    const result = await migrateToAccounts({ root: ROOT })
    expect(result.migrated).toBe(true)
  })

  it('does not run twice', async () => {
    seedLegacy()
    const first = await migrateToAccounts({ root: ROOT })
    const second = await migrateToAccounts({ root: ROOT })
    expect(first.migrated).toBe(true)
    expect(second.migrated).toBe(false)
  })

  it('removes the legacy Windows task', async () => {
    seedLegacy()
    let removed = false
    await migrateToAccounts({ root: ROOT, unregisterLegacyTask: async () => { removed = true } })
    expect(removed).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/migrate.test.ts`
Expected: FAIL — "Failed to resolve import '../src/main/migrate'".

- [ ] **Step 3: Implement `src/main/migrate.ts`**

```ts
export interface MigrationResult {
  /** Whether the layout was changed. */
  migrated: boolean
  /** The account that was created, when one was. */
  accountId?: string
  /** Why it did not run, when it did not. */
  error?: string
}

export async function migrateToAccounts(deps: {
  root: string
  /** The old account's settings, for the migration to read. */
  legacySettings?: unknown
  /** Write the new app-wide settings file. */
  saveAppSettings?: (patch: Partial<AppSettings>) => Promise<AppSettings>
  /** Remove the old Windows task, if it is registered. */
  unregisterLegacyTask?: () => Promise<void>
  log?: (message: string) => void
}): Promise<MigrationResult>
```

The order is the whole point and must be followed exactly:

1. If `<root>\accounts\.migrated` exists, or `<root>\manifest.json` does not, return `{ migrated: false }`.
2. Read the legacy settings from `<root>\legacy\settings.json` if it is there, else from `<root>\settings.json`. **Read before anything is written.**
3. If `<root>\legacy\settings.json` does not exist and the source does, **copy** the source to it. From here on it is the copy of record.
4. Remove any partial `<root>\accounts\acc_*` folder.
5. Create `<root>\accounts\acc_<new id>\`.
6. **Copy** (not move) `<root>\manifest.json`, `<root>\journal.ndjson` and `<root>\tokens.json` into the account folder.
7. Write `<root>\accounts\acc_<id>\settings.json` from the settings read in step 2, applying the singular-`backupPath` shim that `src/main/settings.ts` applies, so an old file is not misread.
8. Verify: the copied manifest parses and its `version` is 11; the account settings parse; the legacy settings copy still parses.
9. Write the new app-wide `settings.json`: one account summary, `currentAccountId` set to it, `clientSecretSet`, `guardThreshold` and `startWithWindows` carried over, and `extraBackupPath` taken from the first entry of the legacy `backupPaths` — after the shim — that is not the app's own default backup directory.
10. **Move** the legacy `manifest.json`, `journal.ndjson` and `tokens.json` into `<root>\legacy\`, keeping them. The legacy `settings.json` is already in `legacy\` from step 3.
11. Call `unregisterLegacyTask` if it was given.
12. Write `<root>\accounts\.migrated`.
13. Log one line naming the account folder, the legacy folder and the account's address.

On any failure: remove the partial account folder, leave everything else exactly where it was, and return `{ migrated: false, error }`. The next start runs the migration again, and it reads `legacy\settings.json`, which by then holds the author's schedule and extra backup location.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green.

- [ ] **Step 6: Commit**

```bash
git add src/main/migrate.ts test/migrate.test.ts
git commit -m "feat: the one-time move into the account layout

The author's install becomes account one, with its four mirrors, its
schedule, its sign-in and its extra backup location intact.

The order is the whole point. The legacy settings file is copied aside
first, before the new app-wide settings file is written, because they
share a path. If the new file were written first and the migration then
failed, the next start would read the new-shaped file as legacy, and
the schedule and the extra backup location would be gone, because they
exist nowhere else. Every later step reads the settings from the copy.

The migration copies before it moves and verifies before it deletes, it
is resumable, and it is idempotent. On any failure the legacy files are
left exactly where they were."
```

---

### Task 6: The runner is per account

**Files:**
- Modify: `src/main/runner.ts`
- Test: `test/runner.test.ts`

**Interfaces:**
- Consumes: `AccountSettings` (Task 3); `AppSettings` (Task 2); `OAuthTokens` (`src/drive/oauth.ts`); `DriveClient`, `ManifestStore` (`src/core/types.ts` and `src/drive/client.ts`).
- Produces: `AccountRuntime`, `RunnerDeps.account`, `RunnerDeps.appSettings`, the per-account `Runner` methods, `RunSummary.skipped`.

- [ ] **Step 1: Write the failing test**

In `test/runner.test.ts`, replace the account block at `:642-678` with:

```ts
describe('the manifest and the account that owns it', () => {
  it('claims the manifest for the account when no owner is recorded', async () => {
    const h = harness()
    await h.runner.syncNow('acc_7f3a2b')
    expect(h.summary().errors).toBe(0)
    expect(h.manifest('acc_7f3a2b').accountEmail).toBe('user@example.com')
  })

  it('blocks the run when the manifest belongs to another account', async () => {
    const h = harness()
    h.manifest('acc_7f3a2b').accountEmail = 'other@example.com'
    const summary = await h.runner.syncNow('acc_7f3a2b')
    expect(summary.errors).toBe(1)
    expect(summary.reports[0]?.message).toContain('other@example.com')
    expect(summary.reports[0]?.message).toContain('user@example.com')
  })

  it('keeps two accounts apart when they hold a mirror with the same name', async () => {
    const h = harness()
    await h.runner.syncNow('acc_7f3a2b')
    await h.runner.syncNow('acc_91c4de')
    const a = await h.runner.state('acc_7f3a2b')
    const b = await h.runner.state('acc_91c4de')
    expect(a.mirrors[0]?.name).toBe('Medicine')
    expect(b.mirrors[0]?.name).toBe('Medicine')
    expect(a.mirrors[0]?.fileCount).not.toBe(b.mirrors[0]?.fileCount)
  })

  it('gives the caller its own summary when another account is running', async () => {
    const h = harness()
    const first = h.runner.syncNow('acc_7f3a2b')
    const second = await h.runner.syncNow('acc_91c4de')
    const firstSummary = await first
    expect(second).not.toBe(firstSummary)
    expect(second.mirrors.map((m) => m.name)).toEqual(['Medicine'])
  })
})
```

And a new block for the lock:

```ts
describe('a run that could not happen', () => {
  it('waits for the lock and runs when it is free', async () => {
    const h = harness()
    h.lockHeld = true
    h.lockFreesAfterAttempts = 2
    const summary = await h.runner.syncNow('acc_7f3a2b')
    expect(summary.skipped).toBeUndefined()
    expect(h.sleptFor).toBeGreaterThan(0)
  })

  it('marks the summary as skipped when the lock never frees', async () => {
    const h = harness()
    h.lockHeld = true
    h.lockWait = { attempts: 2, intervalMs: 1 }
    const summary = await h.runner.syncNow('acc_7f3a2b')
    expect(summary.skipped).toBe(true)
    expect(h.accountSettings('acc_7f3a2b').schedule.lastRunAt).toBeNull()
  })
})

describe('two accounts with the same folder', () => {
  it('trashes a deleted local file in both Drives and keeps the manifests apart', async () => {
    const h = harness()
    await h.runner.syncNow('acc_7f3a2b')
    await h.runner.syncNow('acc_91c4de')
    h.removeLocalFile('Medicine', 'a.psd')
    await h.runner.syncNow('acc_7f3a2b')
    await h.runner.syncNow('acc_91c4de')
    expect(h.driveTrashed('acc_7f3a2b')).toContain('a.psd')
    expect(h.driveTrashed('acc_91c4de')).toContain('a.psd')
    expect(h.manifest('acc_7f3a2b').mirrors.Medicine.files['a.psd']).toBeUndefined()
    expect(h.manifest('acc_91c4de').mirrors.Medicine.files['a.psd']).toBeUndefined()
  })

  it('records the disk fingerprint only for the disks its own mirrors use', async () => {
    const h = harness()
    await h.runner.syncNow('acc_7f3a2b')
    await h.runner.syncNow('acc_91c4de')
    expect(Object.keys(h.manifest('acc_7f3a2b').volumes)).toEqual(['E:'])
    expect(Object.keys(h.manifest('acc_91c4de').volumes)).toEqual(['D:'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/runner.test.ts`
Expected: FAIL — `syncNow` takes no account id, and `RunSummary` has no `skipped`.

- [ ] **Step 3: Change the runner's dependencies**

In `src/main/runner.ts`:

```ts
export interface AccountRuntime {
  id: string
  email: string
  /** Whether the account has a sign-in. */
  signedIn: boolean
  client: DriveClient
  store: ManifestStore
  settings: () => Promise<AccountSettings>
  /** The account's tokens, and where to write a refreshed one. */
  loadTokens: () => Promise<OAuthTokens | null>
  saveTokens: (tokens: OAuthTokens) => Promise<void>
}

export interface RunnerDeps {
  account: (id: string) => Promise<AccountRuntime>
  appSettings: () => Promise<AppSettings>
  emit: (event: AppEvent) => void
  lockPath?: string
  saveAccountSettings?: (id: string, patch: Partial<AccountSettings>) => Promise<AccountSettings>
  /** How long to keep trying for the lock before a run is given up on. */
  lockWait?: { attempts: number; intervalMs: number }
  /** Waiting, in a way a test can stand in for. */
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}
```

`lockWait` defaults to `{ attempts: 5, intervalMs: 60_000 }` — five minutes. `sleep` defaults to a real timer.

The old `client`, `store`, `settings`, `hasCredentials` and `accountEmail` dependencies are gone. The account's address comes from `AccountRuntime.email`; **the runner makes no API call to learn who is signed in**, so the guard cannot be disabled by a network failure.

- [ ] **Step 4: Make the runner's state per account**

Inside `createRunner`, the state that was global becomes a map keyed by account id:

| Today | Becomes |
|---|---|
| `cards: Map<string, MirrorCard>` | `cards: Map<string, MirrorCard>`, keyed by `${accountId}\u0000${mirrorName}` |
| `inFlight: Promise<RunSummary> \| null` | `inFlight: Map<string, Promise<RunSummary>>` |
| `running: { value: boolean }` | `running: Map<string, boolean>` |
| `phase: { value: string }` | `phase: Map<string, string>` |
| the pending guard | `guards: Map<string, PendingGuard>` |
| `lastRun: { value: RunSummary \| null }` | `lastRun: Map<string, RunSummary \| null>` |

Every method that acts on a mirror takes the account id first:

```ts
syncNow(accountId: string, mirrorName?: string, options?: { overrideGuard?: boolean }): Promise<RunSummary>
state(accountId: string): Promise<AppState>
prime(accountId: string): Promise<void>
rebase(accountId: string, mirrorName: string): Promise<void>
moveMirrorDestination(accountId: string, mirrorName: string, drivePath: string): Promise<{ ok: true } | { ok: false; message: string }>
pruneRemovedMirrors(accountId: string): Promise<number>
downloadRestored(accountId: string, mirrorName: string, driveFileId: string): Promise<{ ok: true; path: string } | { ok: false; message: string }>
```

- [ ] **Step 5: Make the guard local and the backups per account**

The guard, at `src/main/runner.ts:563-583`, becomes:

- the owner is `manifest.accountEmail` when it is a string, and `null` otherwise;
- the signed-in address is the **registry's** `AccountRuntime.email`, with no API call;
- a null owner means "no owner recorded": the first run claims the manifest, exactly as today;
- an owner that is recorded and different blocks the run, and the message names both addresses, unchanged.

The write-back of the backups, at `src/main/runner.ts:1050-1076`, writes each account's manifest to the app's own `backups\<email>\` and to `<extraBackupPath>\<email>\`, using `backupDirFor` from Task 1. A failed backup emits a notice naming the path, as today.

The volume fingerprints in the manifest are now per account, because the runner only ever sees one account's mirrors. An account whose mirrors are on `E:` records `E:` and nothing else, and a changed `E:` stops that account alone.

- [ ] **Step 6: Make a busy lock wait instead of failing**

Today `acquireSyncLock` fails the moment the lock is held, and the run is
skipped. A busy lock must instead be **waited out**, so a run for one
account waits for the other and then runs (M19).

The lock acquisition becomes a loop: try; if it fails, set that account's
`phase` to `'waiting'`, emit a state event, `await sleep(lockWait.intervalMs)`,
and try again. After `lockWait.attempts` tries the run is given up on, and
its summary carries `skipped: true`.

The run does **not** write `lastRunAt` when it is given up on — it already
returns before that point, and that must stay true.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green. Other files still reference the old runner signatures — fix them in this task with the `// TODO(multi-account): replaced in task N` comment naming the task that replaces them.

- [ ] **Step 9: Commit**

```bash
git add src/main/runner.ts test/runner.test.ts
git commit -m "feat: the runner works on one account at a time

The runner resolves its account per call instead of holding one client
and one manifest store, and every piece of state it keeps is keyed by
the account as well as the mirror. Without that, two accounts holding a
mirror called Medicine would show each other's file counts, and a Sync
now on one account would hand back the other account's results.

The guard now compares the manifest's recorded owner against the
account's own address, which the app already knows, so it makes no API
call and no network failure can disable it. A missing owner still means
no owner recorded, and the first run claims the manifest, as before.

A busy lock is waited out rather than skipped, so a run for one account
waits for the other and then runs. A run that is finally given up on
says so on its summary, and the schedule's clock does not advance."
```

---

### Task 7: The scheduler, the Windows task, and the missed slot

**Files:**
- Modify: `src/main/scheduler.ts`
- Modify: `src/main/taskScheduler.ts`
- Test: `test/scheduler.test.ts`, `test/schtasks.test.ts`

**Interfaces:**
- Consumes: `AccountSettings` (Task 3); `ScheduleShape` (`src/core/schedule.ts`); `RunSummary.skipped` (Task 6).
- Produces: `taskNameFor(email)`, `buildCreateArgs(shape, exePath, nextRunAt, accountId)`, `buildDeleteArgs(email)`, `createScheduler` with an account id.

- [ ] **Step 1: Write the failing test**

In `test/schtasks.test.ts`:

```ts
it('names the task after the account it belongs to', () => {
  expect(taskNameFor('you@example.com')).toBe('Drive Mirror Sync - you@example.com')
})

it('tells the task which account to run', () => {
  const args = buildCreateArgs({ kind: 'daily', at: '02:00' }, 'C:\\app.exe', new Date('2026-10-22T02:00:00Z'), 'acc_7f3a2b')
  const tr = args[args.indexOf('/TR') + 1]
  expect(tr).toContain('--sync-once')
  expect(tr).toContain('--account acc_7f3a2b')
})

it('deletes by the same name it creates', () => {
  const args = buildDeleteArgs('you@example.com')
  expect(args[args.indexOf('/TN') + 1]).toBe(taskNameFor('you@example.com'))
})
```

In `test/scheduler.test.ts`:

```ts
it('does not advance the clock when the run was skipped', async () => {
  const h = harness()
  h.runSummary = { ...emptySummary(), skipped: true }
  await h.scheduler.runNow()
  expect(h.settings.schedule.lastRunAt).toBeNull()
})

it('advances the clock when the run happened', async () => {
  const h = harness()
  h.runSummary = { ...emptySummary(), finishedAt: '2026-10-22T00:00:00.000Z' }
  await h.scheduler.runNow()
  expect(h.settings.schedule.lastRunAt).toBe('2026-10-22T00:00:00.000Z')
})

it('runs the account it was made for', async () => {
  const h = harness()
  await h.scheduler.runNow()
  expect(h.ranAccountId).toBe('acc_7f3a2b')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/scheduler.test.ts test/schtasks.test.ts`
Expected: FAIL — `taskNameFor` is not exported, and the scheduler advances the clock for a skipped run.

- [ ] **Step 3: Change the task builder**

In `src/main/taskScheduler.ts`:

```ts
export const TASK_NAME = 'Drive Mirror Sync'

export function taskNameFor(email: string): string {
  return `${TASK_NAME} - ${email}`
}

export function buildCreateArgs(
  shape: ScheduleShape,
  exePath: string,
  nextRunAt: Date,
  accountId: string,
): string[]

export function buildDeleteArgs(email: string): string[]
```

`buildCreateArgs` keeps today's switches exactly (`/Create /TN <name> /TR "<exe>" --sync-once --account <id> /F /IT`) and changes only the task name and the added `--account` argument. `buildDeleteArgs` deletes the per-account name. `TASK_NAME` stays exported so the migration can delete the legacy task.

- [ ] **Step 4: Change the scheduler**

`createScheduler` gains an `accountId`, and every dependency that read the app-wide settings now reads that account's:

```ts
export interface SchedulerDeps {
  accountId: string
  accountEmail: string
  settings(): Promise<AccountSettings>
  saveSettings(patch: Partial<AccountSettings>): Promise<AccountSettings>
  /** Run a sync of this account's mirrors. */
  runSync(): Promise<RunSummary>
  now(): Date
  registerTask(shape: ScheduleShape, exePath: string, nextRunAt: Date): Promise<void>
  unregisterTask(): Promise<void>
  taskExists(): Promise<boolean>
  exePath(): string
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  onResume(fn: () => void): () => void
  notify(title: string, body: string): void
}
```

In `doRun`, the clock only advances when the run happened:

```ts
const summary = await deps.runSync()
if (summary.skipped) {
  // The run did not happen. The clock must not move, or the slot is lost.
  deps.notify('The scheduled sync did not run', 'another sync was already running, so this slot was missed')
} else {
  lastRunAt = deps.now().toISOString()
  await persist({ lastRunAt })
}
```

The in-app timer re-arms as it does today, so the missed slot is retried.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/scheduler.test.ts test/schtasks.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green.

- [ ] **Step 7: Commit**

```bash
git add src/main/scheduler.ts src/main/taskScheduler.ts test/scheduler.test.ts test/schtasks.test.ts
git commit -m "feat: a schedule and a Windows task per account

Each account's task is named after it and carries its id on the command
line, so two accounts can run at their own times without one task
running the other's work.

The scheduler no longer advances its clock after a run that did not
happen. It did, and that is why a scheduled slot was silently lost
whenever the app was busy at the time: the run returned a summary
rather than an error, the scheduler read it as a run, and the missed-run
logic never fired. A skipped run is now marked, the clock stays where
it was, and the slot is caught up."
```

---

### Task 8: The app wires the accounts together

**Files:**
- Create: `src/main/cli.ts`
- Create: `src/main/refreshToken.ts`
- Modify: `src/main/index.ts`
- Test: `test/cli.test.ts`, `test/refreshToken.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: `parseCli`, `CliOptions`, and the app's wiring.

- [ ] **Step 1: Write the failing test**

`test/cli.test.ts`:

```ts
describe('the command line', () => {
  it('is not a scheduled run by default', () => {
    expect(parseCli([])).toEqual({ syncOnce: false, accountId: null })
  })

  it('reads a scheduled run', () => {
    expect(parseCli(['--sync-once'])).toEqual({ syncOnce: true, accountId: null })
  })

  it('reads the account to run', () => {
    expect(parseCli(['--sync-once', '--account', 'acc_7f3a2b']))
      .toEqual({ syncOnce: true, accountId: 'acc_7f3a2b' })
  })

  it('ignores an account with no id after it', () => {
    expect(parseCli(['--sync-once', '--account'])).toEqual({ syncOnce: true, accountId: null })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — "Failed to resolve import '../src/main/cli'".

- [ ] **Step 3: Implement `src/main/cli.ts`**

```ts
export interface CliOptions {
  /** Whether this is a run that quits when it is done. */
  syncOnce: boolean
  /** Which account to run, or null for all of them. */
  accountId: string | null
}

export function parseCli(argv: string[]): CliOptions
```

`--account` takes the next argument as its value and is ignored when there is none.

- [ ] **Step 4: Move the token refresh into its own module**

`src/main/refreshToken.ts` holds the refresh, so it can be tested without
Electron:

```ts
export interface Credentials {
  clientId: string
  clientSecret: string
}

export interface RefreshedTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
  scope: string
  token_type: string
}

/**
 * A fresh access token for this account, and the tokens to keep.
 *
 * Nothing here touches a file. The caller writes the result to the
 * account's own token file, so one account's refresh can never land in
 * another account's file.
 */
export async function refreshIfNeeded(
  tokens: RefreshedTokens | null,
  credentials: Credentials | null,
  now: Date,
  fetchImpl?: typeof fetch,
): Promise<RefreshedTokens | null>
```

It returns the tokens unchanged when they are still good — more than sixty
seconds left — and asks Google for a new access token when they are not. It
returns `null` when there are no tokens, or when the client id or the secret
is missing. The refresh call itself is the one in `src/drive/oauth.ts`, which
already exists and is not changed.

`test/refreshToken.test.ts`:

```ts
it('keeps tokens that are still good', async () => {
  const tokens = { access_token: 'a', refresh_token: 'r', expiry_date: 1_000_000, scope: 's', token_type: 'Bearer' }
  const out = await refreshIfNeeded(tokens, CREDS, new Date(0))
  expect(out).toBe(tokens)
})

it('asks for a new access token when the old one has expired', async () => {
  const out = await refreshIfNeeded(EXPIRED, CREDS, new Date(0), fakeFetch)
  expect(out?.access_token).toBe('fresh')
  expect(out?.refresh_token).toBe('r')
})

it('has nothing to refresh without tokens or credentials', async () => {
  expect(await refreshIfNeeded(null, CREDS, new Date(0))).toBeNull()
  expect(await refreshIfNeeded(EXPIRED, null, new Date(0))).toBeNull()
})
```

- [ ] **Step 5: Wire the app in `src/main/index.ts`**

The changes, in the order they are made:

1. Build the registry, the account settings store and the account token store from `appDataDir()`.
2. **Run the migration before anything else**, at start-up, with `unregisterLegacyTask` wired to the task builder's delete for the legacy name. A failed migration is logged and the app starts with no accounts.
3. Replace the single `client` and `store` with an `account` resolver that, for an id, returns an `AccountRuntime`: the account's own `DriveClient` built over its own tokens, its own `ManifestStore` rooted at its own folder, its own settings, and the token accessors.
4. The token refresh (`src/main/index.ts:110-132`) now calls `refreshIfNeeded` from Task 8's module and writes the result back with the runtime's own `saveTokens`, so a refresh writes to that account's file and to no other.
5. The scheduler becomes a `Map<string, Scheduler>`, one per account, created when an account is added and destroyed when it is forgotten. Each is built with its own `accountId` and `accountEmail`.
6. Every `deps.emit` call carries the account id. App-level events carry `null`.
7. A notice or error with an account id is written to that account's settings; one without is written to the app-wide settings.
8. `parseCli(process.argv)` replaces the `process.argv.includes('--sync-once')` check. With `--sync-once --account <id>`, the app runs that account and quits. With `--sync-once` and no account, it runs every account whose mechanism is `windows-task`, one after another, taking and releasing the lock between them, and quits. An unknown account id is refused with a message and nothing is run.
9. The `sign-out`, `forget`, `reset connection`, `reset account history` and `switch account` actions are implemented here, over the registry.

- [ ] **Step 6: Implement the sign-in flow**

The `authenticate` action, in `src/main/index.ts`, does this in order:

1. Read the shared client id and secret from the credential store. Without a client id, refuse with the message "the app needs a Google client id before it can sign in".
2. Open the browser to Google's sign-in page with the **shared** client id and a loopback redirect, exactly as today.
3. Exchange the code for tokens and **hold them in memory**. Nothing is written to disk yet.
4. Build a `DriveClient` over the in-memory access token and call `about?fields=user(emailAddress)` to learn the address. If that call fails, refuse with the message "the app could not read your Google account address, so it will not sign you in" and write nothing.
5. Look the address up in the registry, ignoring case.
   - **Found and signed out** → write the tokens into that account's folder.
   - **Not found** → create the account, then write the tokens into it.
   - **Found and already signed in** → refuse with the message "that account is already connected" and write nothing.
6. Make the account current and return `{ ok: true, email, accountId }`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/cli.test.ts test/refreshToken.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the whole suite, the typecheck and the build**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; the suite green; the build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/main/cli.ts src/main/refreshToken.ts src/main/index.ts test/cli.test.ts test/refreshToken.test.ts
git commit -m "feat: the app holds several accounts

The app builds a registry, a per-account runtime for each of them, and
a scheduler for each account whose schedule needs one. The migration
runs before anything else at start-up.

A token refresh now uses the account's own tokens and writes back to
that account's own file, so one account's expiry cannot disturb
another's sign-in.

The sign-in holds its tokens in memory until it knows which account
they belong to, so a refused sign-in leaves nothing on disk.

A scheduled run with no account runs every account that uses the
Windows task, one after another, and quits."
```

---

### Task 9: The IPC and the preload

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Test: `test/ipc.test.ts`

**Interfaces:**
- Consumes: `AccountRegistry` (Task 4), `AccountRuntime` (Task 6), `AppSettings` (Task 2), `AccountSettings` (Task 3).
- Produces: the 27 channels and the preload API.

- [ ] **Step 1: Write the failing test**

In `test/ipc.test.ts`, replace the channel list at `:26-50` with the 27 names from the spec, and add:

```ts
it('has one channel per action in the design', () => {
  expect(handlers.size).toBe(PRELOAD_CHANNELS.length)
  expect(PRELOAD_CHANNELS.length).toBe(27)
})

it('routes an account-scoped call to the account it names', async () => {
  await handlers.get('drive-mirror:get-state')!(null, 'acc_7f3a2b')
  expect(stateCalls).toEqual(['acc_7f3a2b'])
})

it('refuses an account-scoped call when there is no current account', async () => {
  const result = await handlers.get('drive-mirror:remove-mirror')!(null, 'acc_missing')
  expect(result).toEqual({ ok: false, message: 'no account is selected' })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ipc.test.ts`
Expected: FAIL — the channel count and the account-aware channels are not there.

- [ ] **Step 3: Change the IPC surface**

`AppState` gains `accountId: string`. `RunSummary` gains `skipped?: true`. Every `AppEvent` variant gains `accountId: string | null`.

The channels are the 27 in the spec's §7.11 table. The rules:

- Every **account-scoped** channel takes the account id as its first argument, and **the id is optional on every one of them** and means "the current account". One convention, not three.
- When there is no current account, a read returns an empty state and a mutation returns `{ ok: false, message: 'no account is selected' }`.
- The **app-wide** channels take no account id.

`drive-mirror:authenticate` returns `{ ok, email?, accountId?, message? }`, and it creates or attaches the account as `src/main/index.ts` describes. `drive-mirror:sign-out` takes an account id. `drive-mirror:start-fresh-manifest` becomes `drive-mirror:reset-account-history`.

**`validateMirror` is called with the current account's mirrors only.** It
takes the list of existing mirrors as its second argument and enforces the
name-uniqueness and root-overlap rules against it. Passing the whole app's
list would forbid two accounts from holding a mirror with the same name, or
the same local root, which the spec allows. The same applies to every other
caller that looks a mirror up: it looks it up in the current account's list
and in the current account's manifest, never in another's.

- [ ] **Step 4: Change the preload**

`src/preload/index.ts` mirrors the channels exactly. Every account-scoped method takes an optional account id first. `onEvent` keeps its shape, but the event type now carries `accountId`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the suite green.

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts test/ipc.test.ts
git commit -m "feat: the interface can talk about any account

Twenty-three channels become twenty-seven. Four are new - the account
settings, the forget action and the switch - and the rest take an
account id. The id is optional on every account-scoped channel and
means the current account, so there is one convention rather than
three.

Every event carries the account it belongs to, so the interface can
ignore another account's progress instead of painting it."
```

---

### Task 10: The renderer shows the switcher

**Files:**
- Create: `src/renderer/components/AccountSwitcher.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/global.d.ts`
- Modify: `src/renderer/styles.css`

**Interfaces:**
- Consumes: the preload API (Task 9); `AccountSummary` (Task 2).
- Produces: the switcher component and the account-scoped application state.

- [ ] **Step 1: Write the change**

`src/renderer/components/AccountSwitcher.tsx` is a button that opens a list. Its props:

```ts
export interface AccountSwitcherProps {
  accounts: AccountSummary[]
  currentAccountId: string | null
  onSwitch: (id: string) => void
  onConnect: () => void
  onForget: (id: string) => void
}
```

The button shows the current account's email, or "Connect an account" when there is none. The list shows, for each account, the email, a mark when it is signed in, the number of mirrors, and a mark when it has an unshown notice. At the bottom: "Connect another account", and "Forget this account" for the current one.

- [ ] **Step 2: Change `src/renderer/App.tsx`**

The application state gains `accounts: AccountSummary[]` and `currentAccountId: string | null`, both from `get-app-settings`. The top bar's account label becomes `<AccountSwitcher …>`.

Every event handler checks the account before it acts:

```ts
if (event.type === 'progress' && event.accountId !== currentAccountId) return
if (event.type === 'finished' && event.accountId !== currentAccountId) return
if (event.type === 'guard' && event.accountId !== currentAccountId) return
```

The mirror grid, the guard banner, the progress panel and the summary bar show the current account's world only. The empty state has two forms: no accounts at all → "Connect an account"; accounts exist but the current one is not signed in → "Sign in".

- [ ] **Step 3: Change `src/renderer/global.d.ts` and `src/renderer/styles.css`**

The preload types match the new API. The stylesheet gets a `.switcher` button, a `.switcher__list` list and its rows, using the same colours and spacing as the rest of the sheet. The list closes when the user clicks away, and `Escape` closes it.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean; the build succeeds. The renderer has no test setup and none is added.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/AccountSwitcher.tsx src/renderer/App.tsx src/renderer/global.d.ts src/renderer/styles.css
git commit -m "feat: the switcher in the top bar

The account label becomes a dropdown. You are in one account at a time,
and the screen shows that account's mirrors, schedule and notices only.

Events carry the account they belong to, and the interface ignores the
ones that are not the account on screen, so one account's progress
never paints into another's."
```

---

### Task 11: The settings dialog and the account actions

**Files:**
- Modify: `src/renderer/components/SettingsDialog.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: the preload API (Task 9); `AccountSwitcher` (Task 10).

- [ ] **Step 1: Write the change**

`SettingsDialog.tsx` splits into two sections.

**The app-wide section:** the client id and the client secret, a **Connect an account** button, start with Windows, the guard threshold, the extra backup location, and **Reset the connection**.

**The current account's section:** the schedule, the account's backup copies, **Sign out of this account**, **Forget this account**, and **Reset this account's history**.

The "Test connection" button is gone. In its place is "Connect an account", which calls `authenticate()` and shows the reason for a refusal in the `message` field of the result.

"Reset the connection" and "Forget this account" ask for confirmation before they run, naming what they will remove. "Sign out of this account" does not.

- [ ] **Step 2: Handle the results in `src/renderer/App.tsx`**

Signing out of the account on screen moves to another connected account, or to the "connect an account" screen when there is none. Forgetting the account on screen does the same.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean; the build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/SettingsDialog.tsx src/renderer/App.tsx
git commit -m "feat: the settings, split into the app's and an account's

The app-wide half holds the client id, start with Windows, the guard
threshold, the extra backup location and Reset the connection. The
account's half holds its schedule, its backup copies and the three
actions that act on that account alone.

Test connection becomes Connect an account, because that is what it now
does: it signs you in, and it creates or attaches the account."
```

---

### Task 12: The log, the documentation, and the rulings

**Files:**
- Modify: `src/core/logger.ts`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/superpowers/decisions/2026-10-21-v2-rulings.md`
- Modify: `docs/superpowers/specs/2026-10-21-drive-mirror-v2-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new; this task makes the code and the documents agree.

- [ ] **Step 1: Give the log an account**

`src/core/logger.ts`: `LogEvent` gains `account?: string`. The logger writes it into the line when it is there.

Every call site that knows its account passes it. The app-level calls — the migration, the start-up — pass nothing.

- [ ] **Step 2: Update the README**

The "Where things are kept" table gains the accounts folder, the sign-in, and the per-account backup copies. A new section, **"More than one Google account"**, says what an account is, what follows it and what does not, how to connect a second one, what the four actions do, and that the client id is entered once and used by every account.

The "What it will not do" list gains: an account's file list is never used with another account's sign-in, and a run that could not happen is never recorded as having happened.

- [ ] **Step 3: Update CONTRIBUTING**

The "one rule" section gains a second rule: **the app must never mix two accounts' data.** Every rule that touches a file, a folder or a mirror names the account it belongs to, and the core stays account-free.

- [ ] **Step 4: Record the rulings**

In `docs/superpowers/decisions/2026-10-21-v2-rulings.md`, add a section "After the multi-account work" with the decisions from the spec's §5 that were not already recorded, and the two the user was told about: forgetting an account cannot be undone, and a Google account whose address changes becomes a different account.

In `docs/superpowers/specs/2026-10-21-drive-mirror-v2-design.md`, amend the line "Multiple Google accounts at once. One account per app, always." — it was a design constraint and it no longer holds. Point at the new spec.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean; the suite green; the build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/core/logger.ts README.md CONTRIBUTING.md docs/
git commit -m "docs: several accounts, and what they cost

The log says which account every line came from. The README explains
what an account is, what follows it, and the four things you can do to
one. The rulings record the two costs the user was told about and
accepted: forgetting an account cannot be undone, and a Google account
whose address changes becomes a different account."
```

---

## The five Review Focus conditions, and where each test lives

| # | Condition | Task | Test |
|---|---|---|---|
| 1 | The same folder in two accounts; a local deletion trashes both Drives and the manifests stay apart | Task 6 | `test/runner.test.ts`, "keeps two accounts apart when they hold a mirror with the same name" plus a new test that deletes a local file and asserts both accounts' Drives were trashed |
| 2 | Sign out and sign back in with the same address; everything is as it was | Task 4 | `test/accounts.test.ts`, "forgets an account and leaves the others alone" and "signing out keeps the manifest and the mirrors" |
| 3 | A scheduled slot arrives while the app is busy; the slot is caught up, not lost | Task 7 | `test/scheduler.test.ts`, "does not advance the clock when the run was skipped" |
| 4 | An account's token expires while the app is closed; the refresh touches only that account's file | Task 8 | `test/runner.test.ts`, a new test that expires a token, refreshes it, and asserts the other account's token file is unchanged |
| 5 | A second account is connected while the first account's run is in progress | Task 6 | `test/runner.test.ts`, "gives the caller its own summary when another account is running" |

## Order of execution

This is a chain, and each link needs the one before it:

| Task | Needs |
|---|---|
| 1 — the account layout | nothing |
| 2 — the app-wide settings | nothing |
| 3 — the per-account stores | 1, 2 |
| 4 — the account registry | 1, 2, 3 |
| 5 — the migration | 1, 2, 3, 4 |
| 6 — the runner is per account | 1, 2, 3 |
| 7 — the scheduler and the task | 2, 3, 6 |
| 8 — the app wiring | 1 through 7 |
| 9 — the IPC and the preload | 6, 7, 8 |
| 10 — the switcher | 9 |
| 11 — the settings dialog | 9, 10 |
| 12 — the log and the documents | everything |

Tasks 1 and 2 can be done in either order, and Task 6 can be done in parallel
with Tasks 4 and 5. Every task ends with a green suite, a clean typecheck and
a commit, so the work can be stopped after any task and the app still runs.
