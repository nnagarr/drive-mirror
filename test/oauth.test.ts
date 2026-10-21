import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAuthUrl,
  escapeDriveQuery,
  exchangeCode,
  refreshAccessToken,
} from '../src/drive/oauth'
import { createCredentialStore, createSettingsStore } from '../src/main/settings'

/** A fetch stub that answers with a fixed body. */
function stub(body: unknown, status = 200): { impl: typeof fetch; calls: any[] } {
  const calls: any[] = []
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method, body: init.body })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/**
 * A stand-in for Electron's safeStorage.
 *
 * The point of the test is that the secret is not in the file in plain
 * text, so the fake has to actually transform it.
 */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8').reverse(),
    decryptString: (b: Buffer) =>
      Buffer.from(b).reverse().toString('utf8').replace(/^enc:/, ''),
  }
}

describe('buildAuthUrl', () => {
  it('builds an auth URL with the drive scope and offline access', () => {
    const url = buildAuthUrl('CID', 'http://localhost:53219', 'st8')
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url).toContain(
      'scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive'),
    )
    expect(url).toContain('access_type=offline')
    expect(url).toContain('prompt=consent')
    expect(url).toContain(
      'redirect_uri=' + encodeURIComponent('http://localhost:53219'),
    )
    expect(url).toContain('state=st8')
  })

  it('escapes single quotes and backslashes in Drive query strings', () => {
    expect(escapeDriveQuery("Bob's.psd")).toBe("Bob\\'s.psd")
    expect(escapeDriveQuery('a\\b.psd')).toBe('a\\\\b.psd')
  })
})

describe('the token endpoints', () => {
  it('exchanges the code for a refresh token', async () => {
    const { impl, calls } = stub({
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/drive',
      token_type: 'Bearer',
    })

    const tokens = await exchangeCode(
      {
        clientId: 'CID',
        clientSecret: 'CS',
        code: 'CODE',
        redirectUri: 'http://localhost:1234',
      },
      impl,
    )

    expect(tokens.refresh_token).toBe('RT')
    expect(tokens.access_token).toBe('AT')
    expect(typeof tokens.expiry_date).toBe('number')
    expect(calls[0].url).toContain('oauth2.googleapis.com/token')
    expect(String(calls[0].body)).toContain('grant_type=authorization_code')
    expect(String(calls[0].body)).toContain('code=CODE')
  })

  it('refreshes an access token', async () => {
    const { impl, calls } = stub({ access_token: 'AT2', expires_in: 3600 })

    const refreshed = await refreshAccessToken(
      { clientId: 'CID', clientSecret: 'CS', refreshToken: 'RT' },
      impl,
    )

    expect(refreshed.access_token).toBe('AT2')
    expect(typeof refreshed.expiry_date).toBe('number')
    expect(String(calls[0].body)).toContain('grant_type=refresh_token')
    expect(String(calls[0].body)).toContain('refresh_token=RT')
  })

  it('does not put the client secret in the error message', async () => {
    const { impl } = stub({ error: 'invalid_grant' }, 400)

    let message = ''
    try {
      await exchangeCode(
        {
          clientId: 'CID',
          clientSecret: 'SUPER-SECRET-VALUE',
          code: 'CODE',
          redirectUri: 'http://localhost:1234',
        },
        impl,
      )
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }

    expect(message).not.toContain('SUPER-SECRET-VALUE')
    expect(message.length).toBeGreaterThan(0)
  })
})

describe('the credential store', () => {
  it('never writes the secret in plain text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-cred-'))
    const file = join(dir, 'credentials.json')
    const store = createCredentialStore(file, fakeSafeStorage())

    await store.setCredentials('CID', 'GOCSPX-SECRET-VALUE')

    const onDisk = await readFile(file, 'utf8')
    expect(onDisk).not.toContain('GOCSPX-SECRET-VALUE')
    expect(store.getClientSecret()).toBe('GOCSPX-SECRET-VALUE')
    expect(store.getClientId()).toBe('CID')
  })

  it('refuses to write when encryption is not available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-cred-'))
    const file = join(dir, 'credentials.json')
    const store = createCredentialStore(file, fakeSafeStorage(false))

    await expect(store.setCredentials('CID', 'SECRET')).rejects.toThrow()

    // Nothing was written.
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('reports no credentials before any are set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-cred-'))
    const file = join(dir, 'credentials.json')
    const store = createCredentialStore(file, fakeSafeStorage())

    expect(store.getClientId()).toBeNull()
    expect(store.getClientSecret()).toBeNull()
  })

  it('clears the stored credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-cred-'))
    const file = join(dir, 'credentials.json')
    const store = createCredentialStore(file, fakeSafeStorage())

    await store.setCredentials('CID', 'SECRET')
    await store.clear()

    expect(store.getClientId()).toBeNull()
    expect(store.getClientSecret()).toBeNull()
  })
})

describe('the settings store', () => {
  it('reads the defaults when there is no file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)

    const settings = await store.read()

    expect(settings.guardThreshold).toBe(5)
    expect(settings.clientId).toBe('')
    expect(settings.clientSecretSet).toBe(false)
    expect(settings.backupPath).toContain('.drive-mirror-backup')
    expect(settings.manifestPath).toContain('manifest.json')
    expect(settings.supersededPath).toContain('superseded')
  })

  it('writes and reads back the settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dm-settings-'))
    const file = join(dir, 'settings.json')
    const store = createSettingsStore(file)

    const settings = await store.read()
    await store.write({ ...settings, guardThreshold: 9, clientId: 'CID' })

    const read = await store.read()
    expect(read.guardThreshold).toBe(9)
    expect(read.clientId).toBe('CID')
  })
})
