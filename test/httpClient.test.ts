import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { createDriveClient } from '../src/drive/httpClient'
import { uploadResumable, verifyUploadedFile } from '../src/drive/resumable'

/** A request the stub received. */
interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A fetch stub that records every request. */
function stub(
  handler: (r: Recorded) => Response | Promise<Response>,
): { impl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const rec: Recorded = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ?? null,
    }
    calls.push(rec)
    return handler(rec)
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** A JSON response. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The `q` parameter of a recorded URL, decoded. */
function qOf(url: string): string {
  return new URL(url).searchParams.get('q') ?? ''
}

/** A Drive file entry. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'D1',
    name: 'a.psd',
    mimeType: 'application/octet-stream',
    size: '1024',
    md5Checksum: 'm1',
    modifiedTime: '2026-10-20T18:00:00.000Z',
    trashed: false,
    parents: ['F1'],
    ...overrides,
  }
}

describe('the Drive REST client', () => {
  it('every list request carries trashed = false', async () => {
    const { impl, calls } = stub(() => json({ files: [] }))
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    await client.listChildren('F1')

    expect(calls).toHaveLength(1)
    expect(qOf(calls[0]!.url)).toContain('trashed = false')
  })

  it('a batched list parenthesises its OR clause', async () => {
    const { impl, calls } = stub(() => json({ files: [] }))
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    await client.listMany(['a', 'b'])

    expect(qOf(calls[0]!.url)).toBe(
      "trashed = false and ('a' in parents or 'b' in parents)",
    )
  })

  it('requests pageSize 1000 and follows nextPageToken', async () => {
    let page = 0
    const { impl, calls } = stub(() => {
      page += 1
      if (page === 1) {
        return json({ files: [entry()], nextPageToken: 'tok2' })
      }
      return json({ files: [entry({ id: 'D2' })] })
    })
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    const nodes = await client.listChildren('F1')

    expect(calls).toHaveLength(2)
    expect(new URL(calls[0]!.url).searchParams.get('pageSize')).toBe('1000')
    expect(new URL(calls[1]!.url).searchParams.get('pageToken')).toBe('tok2')
    expect(nodes).toHaveLength(2)
  })

  it('trashes with a PATCH setting trashed true, never a delete', async () => {
    const { impl, calls } = stub(() => json({}))
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    await client.trash('D1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ trashed: true })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('untrashes with a PATCH setting trashed false', async () => {
    const { impl, calls } = stub(() => json({}))
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    await client.untrash('D1')

    expect(calls[0]!.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ trashed: false })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('exports a native file through the export endpoint', async () => {
    const { impl, calls } = stub(() => new Response('csv bytes'))
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    await client.exportTo('D1', 'C:\\tmp\\out.csv', 'text/csv')

    expect(calls[0]!.url).toContain('/export?mimeType=text%2Fcsv')
  })

  it('downloads through alt=media', async () => {
    const { impl, calls } = stub(() => new Response('file bytes'))
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    await client.downloadTo('D1', 'C:\\tmp\\out.psd')

    expect(calls[0]!.url).toContain('alt=media')
  })

  it('retries a 401 once after refreshing the token', async () => {
    let attempts = 0
    let tokens = 0
    const { impl, calls } = stub(() => {
      attempts += 1
      if (attempts === 1) return new Response('expired', { status: 401 })
      return json({ files: [] })
    })
    const client = createDriveClient(
      async () => {
        tokens += 1
        return `token-${tokens}`
      },
      { fetchImpl: impl },
    )

    await client.listChildren('F1')

    expect(calls).toHaveLength(2)
    expect(tokens).toBe(2)
    expect(calls[0]!.headers.Authorization).toBe('Bearer token-1')
    expect(calls[1]!.headers.Authorization).toBe('Bearer token-2')
  })

  it('never issues a delete request for any operation', async () => {
    const { impl, calls } = stub(() => json({ files: [] }))
    const client = createDriveClient(async () => 'token', { fetchImpl: impl })

    await client.listChildren('F1')
    await client.trash('D1')
    await client.untrash('D1')

    expect(calls.every((c) => c.method !== 'DELETE')).toBe(true)
  })
})

describe('resumable uploads', () => {
  /** A stub that opens a session and answers the chunk uploads. */
  function uploadStub(options: {
    chunkSize: number
    finalBody: string
    lookup?: () => Response
  }): { impl: typeof fetch; calls: Recorded[]; puts: Recorded[] } {
    const calls: Recorded[] = []
    const puts: Recorded[] = []
    let putIndex = 0
    const impl = (async (input: unknown, init: RequestInit = {}) => {
      const rec: Recorded = {
        url: String(input),
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ?? null,
      }
      calls.push(rec)

      if (rec.method === 'POST' || rec.method === 'PATCH') {
        return new Response('', {
          status: 200,
          headers: { Location: 'https://upload.example/session/1' },
        })
      }
      if (rec.method === 'PUT') {
        puts.push(rec)
        putIndex += 1
        const range = String(rec.headers['Content-Range'] ?? '')
        const [, end] = range.match(/bytes \d+-(\d+)\//) ?? []
        const isLast = end !== undefined && Number(end) + 1 === options.chunkSize
        if (isLast) {
          return new Response(options.finalBody, { status: 200 })
        }
        return new Response('', { status: 308 })
      }
      // The verification lookup.
      return options.lookup ? options.lookup() : json({ files: [] })
    }) as unknown as typeof fetch
    return { impl, calls, puts }
  }

  it('uploads in 8 MB chunks', async () => {
    const size = 20 * 1024 * 1024
    const { impl, puts } = uploadStub({
      chunkSize: size,
      finalBody: JSON.stringify({ id: 'NEW1' }),
    })

    const body = Readable.from([Buffer.alloc(size, 1)])
    const result = await uploadResumable(
      impl,
      'token',
      'https://upload.example/files',
      { name: 'big.psd' },
      body,
      { md5: 'm1', size, parentId: 'P1', fileName: 'big.psd' },
    )

    expect(puts).toHaveLength(3)
    expect(puts[0]!.headers['Content-Range']).toBe(`bytes 0-8388607/${size}`)
    expect(puts[1]!.headers['Content-Range']).toBe(`bytes 8388608-16777215/${size}`)
    expect(puts[2]!.headers['Content-Range']).toBe(`bytes 16777216-20971519/${size}`)
    expect(result.fileId).toBe('NEW1')
    expect(result.verifiedByLookup).toBe(false)
  })

  it('does not retry when the final chunk returns an empty body', async () => {
    const size = 1024
    const { impl, calls, puts } = uploadStub({
      chunkSize: size,
      finalBody: '',
      lookup: () => json({ files: [] }),
    })

    const body = Readable.from([Buffer.alloc(size, 1)])
    const result = await uploadResumable(
      impl,
      'token',
      'https://upload.example/files',
      { name: 'a.psd' },
      body,
      { md5: 'm1', size, parentId: 'P1', fileName: 'a.psd' },
      'POST',
      { attempts: 2, delayMs: 1 },
    )

    // One session, one chunk, and a lookup - never a second upload.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(puts).toHaveLength(1)
    expect(result.fileId).toBeNull()
    expect(result.verifiedByLookup).toBe(true)
  })

  it('recovers the file id by matching md5 and size', async () => {
    const size = 1024
    const { impl } = uploadStub({
      chunkSize: size,
      finalBody: '',
      lookup: () =>
        json({
          files: [
            { id: 'WRONG', size: '1024', md5Checksum: 'other' },
            { id: 'RIGHT', size: '1024', md5Checksum: 'm1' },
          ],
        }),
    })

    const body = Readable.from([Buffer.alloc(size, 1)])
    const result = await uploadResumable(
      impl,
      'token',
      'https://upload.example/files',
      { name: 'a.psd' },
      body,
      { md5: 'm1', size, parentId: 'P1', fileName: 'a.psd' },
      'POST',
      { attempts: 2, delayMs: 1 },
    )

    expect(result.fileId).toBe('RIGHT')
    expect(result.verifiedByLookup).toBe(true)
  })

  it('does not adopt a candidate whose md5 differs', async () => {
    const size = 1024
    const { impl } = uploadStub({
      chunkSize: size,
      finalBody: '',
      lookup: () =>
        json({ files: [{ id: 'OTHER', size: '1024', md5Checksum: 'other' }] }),
    })

    const body = Readable.from([Buffer.alloc(size, 1)])
    const result = await uploadResumable(
      impl,
      'token',
      'https://upload.example/files',
      { name: 'a.psd' },
      body,
      { md5: 'm1', size, parentId: 'P1', fileName: 'a.psd' },
      'POST',
      { attempts: 2, delayMs: 1 },
    )

    expect(result.fileId).toBeNull()
  })

  it('retries the verification lookup before giving up', async () => {
    let lookups = 0
    const { impl } = uploadStub({
      chunkSize: 1024,
      finalBody: '',
      lookup: () => {
        lookups += 1
        return json({ files: [] })
      },
    })

    const body = Readable.from([Buffer.alloc(1024, 1)])
    const result = await uploadResumable(
      impl,
      'token',
      'https://upload.example/files',
      { name: 'a.psd' },
      body,
      { md5: 'm1', size: 1024, parentId: 'P1', fileName: 'a.psd' },
      'POST',
      { attempts: 5, delayMs: 1 },
    )

    expect(lookups).toBe(5)
    expect(result.fileId).toBeNull()
  })

  it('escapes single quotes in Drive query strings', async () => {
    const { impl, calls } = stub(() => json({ files: [] }))

    await verifyUploadedFile(impl, 'token', {
      md5: 'm1',
      size: 10,
      parentId: 'P1',
      fileName: "Bob's.psd",
    })

    const q = qOf(calls[0]!.url)
    expect(q).toContain("name = 'Bob\\'s.psd'")
  })

  it('never opens a second session for the same upload', async () => {
    const size = 1024
    const { impl, calls } = uploadStub({
      chunkSize: size,
      finalBody: '',
      lookup: () => json({ files: [] }),
    })

    const body = Readable.from([Buffer.alloc(size, 1)])
    await uploadResumable(
      impl,
      'token',
      'https://upload.example/files',
      { name: 'a.psd' },
      body,
      { md5: 'm1', size, parentId: 'P1', fileName: 'a.psd' },
      'POST',
      { attempts: 3, delayMs: 1 },
    )

    const sessions = calls.filter((c) => c.method === 'POST')
    expect(sessions).toHaveLength(1)
  })
})
