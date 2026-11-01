/**
 * The OAuth flow.
 *
 * The app signs in as the user themselves: their own Google account, their
 * own files, their own Drive. There is no service account and no shared
 * drive, because the thing being mirrored is a personal working tree.
 *
 * The flow is the loopback one. The app opens a browser to Google's sign-in
 * page with a redirect address of `http://localhost:<port>`, and Google
 * sends the code back to that port, which the app is listening on. No
 * client secret is embedded in a binary that could be copied; the user
 * enters their own client id and secret in Settings, and those are stored
 * encrypted.
 *
 * `prompt=consent` is deliberate. Without it Google only issues a refresh
 * token the first time, and a user who signed in before would find the app
 * unable to keep working after the access token expired.
 */

import { escapeDriveString } from './resumable'

export { escapeDriveString as escapeDriveQuery }

/** The scope the app needs: the whole Drive, read and write. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

/** Where the user signs in. */
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Where codes and refresh tokens are exchanged for access tokens. */
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** The tokens the app holds after a successful sign-in. */
export interface OAuthTokens {
  access_token: string
  refresh_token: string
  expiry_date: number
  scope: string
  token_type: string
}

/**
 * The address the user is sent to in order to sign in.
 *
 * The `state` is a random value the app checks when the code comes back;
 * it is what stops another program from feeding the app a code of its own.
 */
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

/**
 * Exchange an authorisation code for tokens.
 *
 * The client secret is sent to Google and to nobody else. It is never
 * logged, never put in an error message, and never written to disk in
 * plain text.
 */
export async function exchangeCode(
  opts: {
    clientId: string
    clientSecret: string
    code: string
    redirectUri: string
  },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  })

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`the token exchange was refused: ${response.status} ${text}`)
  }

  const json = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    token_type?: string
  }

  if (!json.access_token) {
    throw new Error('the token exchange returned no access token')
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? '',
    expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? DRIVE_SCOPE,
    token_type: json.token_type ?? 'Bearer',
  }
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The refresh token does not change, so the app keeps it and asks for a new
 * access token whenever the old one is close to expiring.
 */
export async function refreshAccessToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ access_token: string; expiry_date: number }> {
  const body = new URLSearchParams({
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'refresh_token',
  })

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`the token refresh was refused: ${response.status} ${text}`)
  }

  const json = (await response.json()) as {
    access_token?: string
    expires_in?: number
  }

  if (!json.access_token) {
    throw new Error('the token refresh returned no access token')
  }

  return {
    access_token: json.access_token,
    expiry_date: Date.now() + (json.expires_in ?? 3600) * 1000,
  }
}
