/**
 * A sign-in that belongs to one account.
 *
 * The tokens for one Google account live in that account's own folder, and
 * the refresh belongs to the account too: one account's expiry must not
 * disturb another account's sign-in.
 *
 * Nothing here writes a file. The caller decides where the tokens go, and
 * it is the account's own file - so a refresh cannot land in the wrong
 * place, and that is what the tests check.
 */

import { refreshAccessToken } from '../drive/oauth'
import type { OAuthTokens } from '../drive/oauth'

/** The OAuth client the app signs in with. It is shared by every account. */
export interface Credentials {
  clientId: string
  clientSecret: string
}

/** Somewhere an account's tokens are kept. */
export interface TokenStore {
  read(id: string): Promise<OAuthTokens | null>
  write(id: string, tokens: OAuthTokens): Promise<void>
}

/** How close to expiring a token is still good enough. */
const FRESH_FOR_MS = 60_000

/**
 * A valid access token for one account, refreshed when it is about to
 * expire.
 *
 * The refreshed token is written back to the same account, and to no other.
 */
export async function accessTokenFor(
  id: string,
  store: TokenStore,
  credentials: Credentials | null,
  now: number = Date.now(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const tokens = await store.read(id)
  if (!tokens) throw new Error('the app is not signed in')
  if (tokens.expiry_date - now > FRESH_FOR_MS) return tokens.access_token

  if (!credentials || !credentials.clientId || !credentials.clientSecret) {
    throw new Error('the OAuth client id or secret is missing')
  }

  const refreshed = await refreshAccessToken(
    {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: tokens.refresh_token,
    },
    fetchImpl,
  )

  const next: OAuthTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_date: refreshed.expiry_date,
  }
  await store.write(id, next)
  return next.access_token
}
