/**
 * Resumable uploads to Drive.
 *
 * A large file is sent in 8 MB chunks, each with a `Content-Range` header.
 * The chunks are small enough that a dropped connection costs one chunk
 * rather than the whole file, and Drive assembles them server-side.
 *
 * The awkward part is the end of the upload. Drive's final response is
 * supposed to carry the new file's id, but it sometimes arrives empty or
 * malformed - a 200 with no body, most often. The naive answer is to
 * upload again, which would create a second copy of the file. The right
 * answer is to look the file up: the upload did happen, and Drive knows
 * about it.
 *
 * So a missing final status never causes a second upload. It causes a
 * lookup, retried for a few seconds while Drive catches up, and a candidate
 * is only adopted when its content hash and its size both match what was
 * sent.
 */

import type { Readable } from 'node:stream'

/** How big each chunk is. */
export const CHUNK_SIZE = 8 * 1024 * 1024

/** What the uploader learned about the file it sent. */
export interface ResumableResult {
  /** The Drive file id, or null when it could not be confirmed. */
  fileId: string | null
  /** True when the id came from a lookup rather than from the upload. */
  verifiedByLookup: boolean
}

/** Where the verification lookup looks. */
const VERIFY_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files'

/** How the verification lookup behaves. */
export interface VerifyControl {
  /** How many times the lookup is tried. */
  attempts?: number
  /** How long to wait between attempts, in milliseconds. */
  delayMs?: number
}

const DEFAULT_ATTEMPTS = 10
const DEFAULT_DELAY_MS = 500

/**
 * Escape a value for a Drive query string literal.
 *
 * Drive wraps string values in single quotes and escapes an embedded quote
 * with a backslash. A file called `Bob's.psd` becomes `'Bob\'s.psd'`.
 */
export function escapeDriveString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** The query that finds a file by name inside a folder. */
export function buildNameQuery(fileName: string, parentId: string): string {
  return `name = '${escapeDriveString(fileName)}' and '${escapeDriveString(parentId)}' in parents and trashed = false`
}

/**
 * Upload a file in chunks, and find out its Drive id.
 *
 * @param endpoint the upload endpoint, without the `uploadType` parameter
 * @param method `POST` to create a file, `PATCH` to replace a file's content
 */
export async function uploadResumable(
  fetchImpl: typeof fetch,
  accessToken: string,
  endpoint: string,
  metadata: Record<string, unknown>,
  body: Readable,
  opts: { md5: string; size: number; parentId: string; fileName: string },
  method: 'POST' | 'PATCH' = 'POST',
  control: VerifyControl = {},
): Promise<ResumableResult> {
  const total = opts.size
  const separator = endpoint.includes('?') ? '&' : '?'

  const sessionResponse = await fetchImpl(`${endpoint}${separator}uploadType=resumable`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(total),
    },
    body: JSON.stringify(metadata),
  })

  if (!sessionResponse.ok) {
    throw new Error(
      `the upload session could not be opened: ${sessionResponse.status} ${await sessionResponse.text()}`,
    )
  }

  const sessionUri = sessionResponse.headers.get('location')
  if (!sessionUri) {
    throw new Error('the upload session response carried no session address')
  }

  let offset = 0
  let pending = Buffer.alloc(0)
  let finalResponse: Response | undefined

  const put = async (payload: Buffer): Promise<Response | undefined> => {
    const from = offset
    const to = from + payload.length - 1
    const response = await fetchImpl(sessionUri, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.length),
        'Content-Range': `bytes ${from}-${to}/${total}`,
      },
      body: payload,
    })

    offset += payload.length

    if (response.status === 308) {
      // The chunk was accepted; the upload continues.
      await response.text()
      return undefined
    }
    if (!response.ok) {
      throw new Error(
        `the upload failed: ${response.status} ${await response.text()}`,
      )
    }
    return response
  }

  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf])
    while (pending.length >= CHUNK_SIZE) {
      const slice = pending.subarray(0, CHUNK_SIZE)
      pending = pending.subarray(CHUNK_SIZE)
      const response = await put(slice)
      if (response) finalResponse = response
    }
  }
  if (pending.length > 0) {
    const response = await put(pending)
    if (response) finalResponse = response
  }

  // The final response is supposed to carry the file. Sometimes it does
  // not, and a second upload would create a duplicate. Look it up instead.
  if (finalResponse) {
    const text = await finalResponse.text()
    if (text.trim().length > 0) {
      try {
        const parsed = JSON.parse(text) as { id?: string }
        if (parsed.id) {
          return { fileId: parsed.id, verifiedByLookup: false }
        }
      } catch {
        // Not JSON. Fall through to the lookup.
      }
    }
  }

  const fileId = await verifyUploadedFile(fetchImpl, accessToken, opts, control)
  return { fileId, verifiedByLookup: true }
}

/**
 * Find the file that an upload just created.
 *
 * The candidate must match on both the content hash and the size. Drive
 * allows exact duplicate names, so the name alone is not enough: adopting
 * the wrong one would leave the real upload unrecorded, and the next run
 * would upload it again.
 */
export async function verifyUploadedFile(
  fetchImpl: typeof fetch,
  accessToken: string,
  opts: { md5: string; size: number; parentId: string; fileName: string },
  control: VerifyControl = {},
): Promise<string | null> {
  const attempts = control.attempts ?? DEFAULT_ATTEMPTS
  const delayMs = control.delayMs ?? DEFAULT_DELAY_MS
  const query = buildNameQuery(opts.fileName, opts.parentId)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const url = `${VERIFY_ENDPOINT}?q=${encodeURIComponent(query)}&fields=${encodeURIComponent('files(id,name,size,md5Checksum)')}`
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (response.ok) {
        const body = (await response.json()) as {
          files?: Array<{ id?: string; size?: string; md5Checksum?: string }>
        }
        for (const candidate of body.files ?? []) {
          const sizeMatches = candidate.size !== undefined && Number(candidate.size) === opts.size
          const hashMatches = candidate.md5Checksum === opts.md5
          if (candidate.id && sizeMatches && hashMatches) {
            return candidate.id
          }
        }
      }
    } catch {
      // A failed lookup is not a failed upload. Try again.
    }
    if (attempt < attempts - 1) {
      await delay(delayMs)
    }
  }
  return null
}

/** Wait, without blocking the thread's work. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
