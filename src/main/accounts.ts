/**
 * The accounts this install knows about.
 *
 * An account is one Google account, and it is a whole world of its own:
 * its mirrors, its schedule, its file list, its sign-in. The registry is
 * the app's knowledge of those worlds - which ones exist, which one is on
 * screen, and which of them are signed in.
 *
 * The list itself lives in the app's settings file, because it belongs to
 * the machine rather than to any one account. Each account's own state
 * lives in its folder, and the registry is what reads across the two.
 */

import { rm } from 'node:fs/promises'
import { accountDir, newAccountId } from './accountPaths'
import type { AccountSettingsStore } from './accountSettings'
import type { AccountTokenStore } from './accountTokens'
import type { AccountRecord, AccountSummary, AppSettings } from './settings'
import type { OAuthTokens } from '../drive/oauth'

/** What the app can do with the accounts it knows about. */
export interface AccountRegistry {
  /** Every account, with the state the switcher draws. */
  list(): Promise<AccountSummary[]>
  /** The account with this address, or null. The comparison ignores case. */
  findByEmail(email: string): Promise<AccountRecord | null>
  /**
   * The account to sign in to.
   *
   * An account with the same address is signed back in, so everything it
   * knew comes back with it. An address the app has never seen makes a
   * new account.
   */
  signIn(email: string, tokens: OAuthTokens): Promise<AccountRecord>
  /** A new account with an empty world. */
  create(email: string): Promise<AccountRecord>
  /** Delete the account's folder and take it off the list. */
  forget(id: string): Promise<void>
  /** Which account the app is showing. */
  setCurrent(id: string | null): Promise<void>
  /** Which account the app is showing, and the address it is signed in as. */
  current(): Promise<AccountSummary | null>
}

/**
 * The accounts on this machine.
 *
 * The list lives in the app's settings; each account's own state lives in
 * its folder, and the two are read together here.
 */
export function createAccountRegistry(deps: {
  /** The app's data directory. */
  root: string
  appSettings: () => Promise<AppSettings>
  saveAppSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  accountSettings: AccountSettingsStore
  tokens: AccountTokenStore
}): AccountRegistry {
  /** The state of one account, worked out from the account's own files. */
  async function summarise(record: AccountRecord): Promise<AccountSummary> {
    const settings = await deps.accountSettings.read(record.id)
    return {
      ...record,
      signedIn: await deps.tokens.has(record.id),
      mirrorCount: settings.mirrors.length,
      hasNotice: settings.pendingNotice !== null,
    }
  }

  async function list(): Promise<AccountSummary[]> {
    const app = await deps.appSettings()
    const summaries: AccountSummary[] = []
    for (const record of app.accounts) {
      summaries.push(await summarise(record))
    }
    return summaries
  }

  async function create(email: string): Promise<AccountRecord> {
    const record: AccountRecord = {
      id: newAccountId(),
      email,
      addedAt: new Date().toISOString(),
    }
    const app = await deps.appSettings()
    await deps.saveAppSettings({
      accounts: [...app.accounts, { ...record, signedIn: false, mirrorCount: 0, hasNotice: false }],
    })
    return record
  }

  return {
    list,

    async findByEmail(email: string): Promise<AccountRecord | null> {
      const found = findAccountByEmail(await list(), email)
      return found ? { id: found.id, email: found.email, addedAt: found.addedAt } : null
    },

    async signIn(email: string, tokens: OAuthTokens): Promise<AccountRecord> {
      const app = await deps.appSettings()
      const known = findAccountByEmail(app.accounts, email)
      const record = known ?? (await create(email))
      await deps.tokens.write(record.id, tokens)
      return { id: record.id, email: record.email, addedAt: record.addedAt }
    },

    create,

    async forget(id: string): Promise<void> {
      // The account's folder goes: its manifest, its journal, its sign-in,
      // its settings and its retired manifests. The copies of its manifest
      // in the backup folders are outside it, and they stay, so the file
      // list can be recovered by hand.
      await rm(accountDir(deps.root, id), { recursive: true, force: true })
      const app = await deps.appSettings()
      const accounts = app.accounts.filter((account) => account.id !== id)
      const patch: Partial<AppSettings> = { accounts }
      if (app.currentAccountId === id) {
        patch.currentAccountId = accounts.length > 0 ? accounts[0]!.id : null
      }
      await deps.saveAppSettings(patch)
    },

    async setCurrent(id: string | null): Promise<void> {
      await deps.saveAppSettings({ currentAccountId: id })
    },

    async current(): Promise<AccountSummary | null> {
      const app = await deps.appSettings()
      if (!app.currentAccountId) return null
      const found = app.accounts.find((account) => account.id === app.currentAccountId)
      return found ? summarise(found) : null
    },
  }
}

/**
 * The account with this address.
 *
 * A Google address is not case-sensitive, so the comparison ignores case.
 * A case-sensitive one would make a second account for the same person,
 * and that account would mirror the same folder into the same Drive.
 */
export function findAccountByEmail(
  accounts: AccountSummary[],
  email: string,
): AccountSummary | null {
  const wanted = email.trim().toLowerCase()
  for (const account of accounts) {
    if (account.email.trim().toLowerCase() === wanted) return account
  }
  return null
}
