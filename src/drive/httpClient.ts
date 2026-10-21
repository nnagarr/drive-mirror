/**
 * The Drive REST client.
 *
 * This is the only file in the app that talks to Google. Everything else
 * works through the `DriveClient` interface, so the sync logic can be
 * tested without a network.
 *
 * Three things here are deliberate.
 *
 * **Every listing filters out the trash.** The Drive API returns trashed
 * files by default. An unfiltered listing would bring every file the app
 * has ever trashed back into the mirror, and the engine would either
 * re-trash it or re-download it - undoing the user's deletions in bulk.
 *
 * **No request ever deletes.** Trashing is a `PATCH` that sets
 * `trashed: true`. There is no code path here that issues a `DELETE`.
 *
 * **A 401 is retried exactly once.** The token is refreshed and the
 * request is repeated; a second 401 is an error, not a loop.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { buildListQuery } from '../core/driveTree'
import { FOLDER_MIME } from '../core/googleMime'
import { uploadResumable } from './resumable'
import type { DriveClient } from './client'
import type { DriveNode } from '../core/types'

/** How the client reaches Drive. */
export interface DriveHttpOptions {
  /** The fetch implementation. Defaults to the global one. */
  fetchImpl?: typeof fetch
  /** The API host. Defaults to Google's. */
  baseUrl?: string
}

/** The fields the app reads from a Drive file. */
const LIST_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,trashed,parents'

/**
 * The `fields` selector for a listing.
 *
 * A listing is a list of files, so the fields of each file have to be
 * selected through the `files(...)` wrapper. A bare field name is read as a
 * field of the list itself, which has almost none, and the API answers
 * "Invalid field selection id".
 */
const LIST_SELECTOR = `files(${LIST_FIELDS}),nextPageToken`

/** How many times a 5xx or a network error is retried. */
const MAX_SERVER_RETRIES = 3

/** How many times a rate-limited request is retried. */
const MAX_RATE_LIMIT_RETRIES = 5

/** The shape of a file entry as Drive returns it. */
interface DriveEntry {
  id: string
  name: string
  mimeType: string
  size?: string
  md5Checksum?: string
  modifiedTime: string
  trashed?: boolean
  parents?: string[]
}

/** Build a query string without turning spaces into plus signs. */
function query(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

/** True when a 403 is the API saying "slow down". */
function isRateLimit(status: number, body: string): boolean {
  if (status !== 403) return false
  return (
    body.includes('rateLimitExceeded') || body.includes('userRateLimitExceeded')
  )
}

/**
 * Create a Drive client.
 *
 * `getAccessToken` is called for every request, and called again when a
 * request is refused with a 401, which is the signal that the token has
 * expired.
 */
export function createDriveClient(
  getAccessToken: () => Promise<string>,
  opts: DriveHttpOptions = {},
): DriveClient & { listMany(parentIds: string[]): Promise<DriveNode[]> } {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const baseUrl = opts.baseUrl ?? 'https://www.googleapis.com'

  /**
   * Make a request, retrying only where retrying is safe.
   */
  async function request(
    method: string,
    url: string,
    init: { body?: RequestInit['body']; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    let token = await getAccessToken()
    let refreshed = false
    let serverRetries = 0
    let rateLimitRetries = 0

    for (;;) {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
          body: init.body ?? null,
        })
      } catch (err) {
        if (serverRetries >= MAX_SERVER_RETRIES) {
          throw err
        }
        serverRetries += 1
        await delay(backoffMs(serverRetries))
        continue
      }

      if (response.status === 401) {
        if (refreshed) {
          throw new Error('the Drive request was refused twice with 401')
        }
        refreshed = true
        token = await getAccessToken()
        continue
      }

      if (response.status === 403 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        const body = await response.text()
        if (!isRateLimit(403, body)) {
          throw new Error(`the Drive request was refused: 403 ${body}`)
        }
        rateLimitRetries += 1
        await delay(retryAfterMs(response, rateLimitRetries))
        continue
      }

      if (response.status >= 500 && serverRetries < MAX_SERVER_RETRIES) {
        serverRetries += 1
        await delay(backoffMs(serverRetries))
        continue
      }

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`the Drive request failed: ${response.status} ${body}`)
      }
      return response
    }
  }

  /** List the children of one or more folders. */
  async function listMany(parentIds: string[]): Promise<DriveNode[]> {
    const out: DriveNode[] = []
    let pageToken: string | undefined

    do {
      const params: Record<string, string> = {
        q: buildListQuery(parentIds),
        fields: LIST_SELECTOR,
        pageSize: '1000',
      }
      if (pageToken) params.pageToken = pageToken

      const response = await request(
        'GET',
        `${baseUrl}/drive/v3/files?${query(params)}`,
      )
      const body = (await response.json()) as {
        files?: DriveEntry[]
        nextPageToken?: string
      }
      for (const entry of body.files ?? []) {
        out.push({ entry: toNodeEntry(entry), parentPath: '' })
      }
      pageToken = body.nextPageToken
    } while (pageToken)

    return out
  }

  /** Write a response body to a file, through a temporary file. */
  async function streamToFile(response: Response, destPath: string): Promise<void> {
    if (!response.body) {
      throw new Error('the Drive response carried no body')
    }
    await mkdir(dirname(destPath), { recursive: true })
    const temp = `${destPath}.part`
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    await pipeline(source, createWriteStream(temp))
    await rename(temp, destPath)
  }

  const client: DriveClient & { listMany(parentIds: string[]): Promise<DriveNode[]> } = {
    listChildren(folderId: string): Promise<DriveNode[]> {
      return listMany([folderId])
    },

    listMany(parentIds: string[]): Promise<DriveNode[]> {
      return listMany(parentIds)
    },

    async getFile(fileId: string): Promise<DriveNode | null> {
      let response: Response
      try {
        response = await request(
          'GET',
          `${baseUrl}/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(LIST_FIELDS)}`,
        )
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
      const entry = (await response.json()) as DriveEntry
      return { entry: toNodeEntry(entry), parentPath: '' }
    },

    async createFolder(name: string, parentId: string): Promise<{ id: string }> {
      const response = await request('POST', `${baseUrl}/drive/v3/files`, {
        body: JSON.stringify({
          name,
          mimeType: FOLDER_MIME,
          parents: [parentId],
        }),
        headers: { 'Content-Type': 'application/json' },
      })
      const body = (await response.json()) as { id?: string }
      if (!body.id) throw new Error('the folder was created but carried no id')
      return { id: body.id }
    },

    async createFile(
      name: string,
      parentId: string,
      body: Readable,
      fileOpts: { md5: string; size: number; mimeType?: string },
    ): Promise<{ id: string }> {
      const token = await getAccessToken()
      const result = await uploadResumable(
        fetchImpl,
        token,
        `${baseUrl}/upload/drive/v3/files`,
        { name, parents: [parentId], mimeType: fileOpts.mimeType },
        body,
        { md5: fileOpts.md5, size: fileOpts.size, parentId, fileName: name },
      )
      if (!result.fileId) {
        throw new Error(
          `the upload of "${name}" finished but the file could not be found on Drive`,
        )
      }
      return { id: result.fileId }
    },

    async updateContent(
      fileId: string,
      body: Readable,
      fileOpts: { md5: string; size: number },
    ): Promise<void> {
      const token = await getAccessToken()
      const result = await uploadResumable(
        fetchImpl,
        token,
        `${baseUrl}/upload/drive/v3/files/${encodeURIComponent(fileId)}`,
        {},
        body,
        {
          md5: fileOpts.md5,
          size: fileOpts.size,
          parentId: '',
          fileName: fileId,
        },
        'PATCH',
      )
      if (!result.fileId) {
        throw new Error(
          `the replacement of "${fileId}" finished but the file could not be found on Drive`,
        )
      }
    },

    async downloadTo(fileId: string, destPath: string): Promise<void> {
      const response = await request(
        'GET',
        `${baseUrl}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      )
      await streamToFile(response, destPath)
    },

    async exportTo(fileId: string, destPath: string, mimeType: string): Promise<void> {
      const response = await request(
        'GET',
        `${baseUrl}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`,
      )
      await streamToFile(response, destPath)
    },

    async trash(fileId: string): Promise<void> {
      await request('PATCH', `${baseUrl}/drive/v3/files/${encodeURIComponent(fileId)}`, {
        body: JSON.stringify({ trashed: true }),
        headers: { 'Content-Type': 'application/json' },
      })
    },

    async untrash(fileId: string): Promise<void> {
      await request('PATCH', `${baseUrl}/drive/v3/files/${encodeURIComponent(fileId)}`, {
        body: JSON.stringify({ trashed: false }),
        headers: { 'Content-Type': 'application/json' },
      })
    },

    async moveFolder(
      fileId: string,
      newParentId: string,
      newName?: string,
    ): Promise<void> {
      // One request moves the folder and renames it, so a destination
      // change is a single round trip and never half-applied.
      const body: { parents: string[]; name?: string } = { parents: [newParentId] }
      if (newName !== undefined) body.name = newName
      await request(
        'PATCH',
        `${baseUrl}/drive/v3/files/${encodeURIComponent(fileId)}?addParents=true`,
        {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        },
      )
    },

    async getAccountEmail(): Promise<string | null> {
      const response = await request(
        'GET',
        `${baseUrl}/drive/v3/about?fields=${encodeURIComponent('user(emailAddress)')}`,
      )
      const body = (await response.json()) as { user?: { emailAddress?: string } }
      return body.user?.emailAddress ?? null
    },
  }

  return client
}

/** Normalise a Drive entry into the shape the app reads. */
function toNodeEntry(entry: DriveEntry): DriveNode['entry'] {
  return {
    id: entry.id,
    name: entry.name,
    mimeType: entry.mimeType,
    size: entry.size,
    md5Checksum: entry.md5Checksum,
    modifiedTime: entry.modifiedTime,
    trashed: entry.trashed ?? false,
    parents: entry.parents ?? [],
  }
}

/** True when the error is Drive's "no such file". */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && /failed: 404/.test(err.message)
}

/** How long to wait before retrying, with jitter. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 15000)
  return base + Math.floor(Math.random() * 250)
}

/** How long to wait before retrying a rate-limited request. */
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  }
  return backoffMs(attempt)
}

/** Wait, without blocking the thread's work. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
