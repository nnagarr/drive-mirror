import { describe, expect, it } from 'vitest'
import { accessTokenFor } from '../src/main/refreshToken'
import type { TokenStore } from '../src/main/refreshToken'
import type { OAuthTokens } from '../src/drive/oauth'

/** The tokens of an account, as they are on disk. */
function tokens(accessToken: string, expiry: number): OAuthTokens {
  return {
    access_token: accessToken,
    refresh_token: 'the-refresh-token',
    expiry_date: expiry,
    scope: 'https://www.googleapis.com/auth/drive',
    token_type: 'Bearer',
  }
}

/** A token store over a map, so a test can see what was written where. */
function storeOver(accounts: Record<string, OAuthTokens>): TokenStore & {
  written: Record<string, OAuthTokens[]>
} {
  const written: Record<string, OAuthTokens[]> = {}
  return {
    written,
    async read(id: string): Promise<OAuthTokens | null> {
      return accounts[id] ?? null
    },
    async write(id: string, value: OAuthTokens): Promise<void> {
      written[id] = [...(written[id] ?? []), value]
    },
  }
}

/** A fetch that answers the token endpoint. */
function fakeFetch(accessToken: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ access_token: accessToken, expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch
}

const CREDENTIALS = { clientId: 'the-client-id', clientSecret: 'the-secret' }

describe('the sign-in of one account', () => {
  it('uses a token that is still good', async () => {
    const store = storeOver({ acc_a: tokens('good', 2_000_000) })
    const token = await accessTokenFor('acc_a', store, CREDENTIALS, 0)
    expect(token).toBe('good')
    expect(store.written.acc_a).toBeUndefined()
  })

  it('refreshes a token that has expired, and writes it back', async () => {
    const store = storeOver({ acc_a: tokens('stale', 0) })
    const token = await accessTokenFor('acc_a', store, CREDENTIALS, 1_000_000, fakeFetch('fresh'))
    expect(token).toBe('fresh')
    expect(store.written.acc_a?.[0]?.access_token).toBe('fresh')
    // The refresh token is kept: the account is still signed in.
    expect(store.written.acc_a?.[0]?.refresh_token).toBe('the-refresh-token')
  })

  it('writes a refreshed token to that account and to no other', async () => {
    const store = storeOver({
      acc_a: tokens('stale', 0),
      acc_b: tokens('the other one', 2_000_000),
    })
    await accessTokenFor('acc_a', store, CREDENTIALS, 1_000_000, fakeFetch('fresh'))
    expect(Object.keys(store.written)).toEqual(['acc_a'])
    // The other account's sign-in is untouched.
    expect(store.written.acc_b).toBeUndefined()
  })

  it('has nothing to offer an account that is not signed in', async () => {
    const store = storeOver({})
    await expect(accessTokenFor('acc_a', store, CREDENTIALS, 0)).rejects.toThrow(
      'not signed in',
    )
  })

  it('says so when the client id or the secret is missing', async () => {
    const store = storeOver({ acc_a: tokens('stale', 0) })
    await expect(
      accessTokenFor('acc_a', store, null, 1_000_000, fakeFetch('fresh')),
    ).rejects.toThrow('client id or secret is missing')
    await expect(
      accessTokenFor('acc_a', store, { clientId: '', clientSecret: '' }, 1_000_000, fakeFetch('fresh')),
    ).rejects.toThrow('client id or secret is missing')
  })
})
