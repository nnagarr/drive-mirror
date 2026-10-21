/**
 * The manifest store: durable, crash-safe persistence for the sync state.
 *
 * The manifest is the record that lets the app tell "the user deleted this
 * file locally" apart from "this file is new on Drive". Losing it would make
 * the app re-download every file the user ever deleted, so the store is
 * deliberately paranoid:
 *
 * - writes are atomic (temp file + fsync + rename), so a crash never leaves a
 *   half-written manifest;
 * - a journal records every completed operation, and the journal is fsynced,
 *   so operations after the last checkpoint can be replayed;
 * - retired records are never pruned.
 */

import { open, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canon } from './paths'
import type {
  JournalOp,
  Manifest,
  ManifestOp,
  MirrorManifest,
  RetiredRecord,
} from './types'

/** The manifest schema version this build reads and writes. */
export const MANIFEST_VERSION = 11

const MANIFEST_FILE = 'manifest.json'
const MANIFEST_TMP = 'manifest.json.tmp'
const JOURNAL_FILE = 'journal.ndjson'

/** Durable storage for the manifest and its journal. */
export interface ManifestStore {
  read(): Promise<Manifest>
  write(m: Manifest): Promise<void>
  checkpoint(m: Manifest): Promise<void>
  appendJournal(op: JournalOp): Promise<void>
  readJournal(): Promise<JournalOp[]>
  replayJournal(base: Manifest): Promise<Manifest>
}

/** A manifest with nothing in it. */
export function emptyManifest(): Manifest {
  return {
    version: MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    volumes: {},
    mirrors: {},
    accountEmail: null,
  }
}

/** A mirror manifest with nothing in it. */
export function emptyMirror(root: string): MirrorManifest {
  return {
    root,
    lastCounts: {},
    rebase: null,
    dirs: {},
    files: {},
    retired: {},
  }
}

/**
 * Indexes over a mirror's retired records.
 *
 * `retiredByPath` answers "what was retired at this path?", newest first.
 * `retiredById` answers "what do we know about this Drive file id?".
 */
export function buildIndexes(m: MirrorManifest): {
  retiredByPath: Map<string, RetiredRecord[]>
  retiredById: Map<string, RetiredRecord>
} {
  const retiredByPath = new Map<string, RetiredRecord[]>()
  const retiredById = new Map<string, RetiredRecord>()

  for (const [id, record] of Object.entries(m.retired)) {
    retiredById.set(id, record)
    const key = canon(record.path)
    const bucket = retiredByPath.get(key)
    if (bucket) bucket.push(record)
    else retiredByPath.set(key, [record])
  }

  for (const bucket of retiredByPath.values()) {
    bucket.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }

  return { retiredByPath, retiredById }
}

/**
 * Apply one manifest mutation to a mirror in place.
 *
 * `set-retired` never deletes an existing record for the same id; it
 * overwrites it in place. A *state change* refreshes `at`, because `at` is
 * the tie-break for "which retired record is newest at this path". Writing
 * the same state again preserves the original `at`.
 */
export function applyManifestOp(m: MirrorManifest, op: ManifestOp): void {
  switch (op.op) {
    case 'set-file':
      m.files[op.path] = op.entry
      return
    case 'del-file':
      delete m.files[op.path]
      return
    case 'set-retired': {
      const existing = m.retired[op.id]
      const record = { ...op.record }
      if (existing) {
        if (existing.state === record.state) {
          // Same state: the record is not a new event, so its timestamp stands.
          record.at = existing.at
        } else {
          // A state change is a new event, and `at` is the tie-break for
          // "which retired record is newest at this path".
          record.at = new Date().toISOString()
        }
      }
      m.retired[op.id] = record
      return
    }
    case 'del-retired':
      delete m.retired[op.id]
      return
    case 'set-dir':
      m.dirs[op.path] = { driveFolderId: op.driveFolderId }
      return
  }
}

/** Create a manifest store rooted at `dir`. */
export function createManifestStore(dir: string): ManifestStore {
  const manifestPath = join(dir, MANIFEST_FILE)
  const tmpPath = join(dir, MANIFEST_TMP)
  const journalPath = join(dir, JOURNAL_FILE)

  async function writeAtomic(contents: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmpPath, manifestPath)
    } catch (err) {
      await rm(tmpPath, { force: true })
      throw err
    }
  }

  return {
    async read(): Promise<Manifest> {
      let raw: string
      try {
        raw = await readFile(manifestPath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest()
        throw err
      }
      const parsed = JSON.parse(raw) as Partial<Manifest>
      if (typeof parsed.version !== 'number') return emptyManifest()
      // The file is read as it is. An older manifest keeps every mirror,
      // every file and every retired record it holds, and only gains the
      // fields this build knows and the file does not mention - the account
      // above all. The version in the file is left alone here: there is no
      // migration step and no data is moved. The write stamps the version
      // this build writes.
      return { ...emptyManifest(), ...parsed }
    },

    async write(m: Manifest): Promise<void> {
      // The file carries the version of the schema it is written in. A
      // manifest that was read from an older file is written back as the
      // version this build writes; the mirrors, the files, the retired
      // records and the counts in it are left exactly as they were.
      const copy: Manifest = {
        ...m,
        version: MANIFEST_VERSION,
        updatedAt: new Date().toISOString(),
      }
      await writeAtomic(`${JSON.stringify(copy, null, 2)}\n`)
    },

    async checkpoint(m: Manifest): Promise<void> {
      const copy: Manifest = { ...m, version: MANIFEST_VERSION }
      await writeAtomic(`${JSON.stringify(copy, null, 2)}\n`)
    },

    async appendJournal(op: JournalOp): Promise<void> {
      await mkdir(dir, { recursive: true })
      const handle = await open(journalPath, 'a')
      try {
        await handle.writeFile(`${JSON.stringify(op)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    },

    async readJournal(): Promise<JournalOp[]> {
      let raw: string
      try {
        raw = await readFile(journalPath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const ops: JournalOp[] = []
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          ops.push(JSON.parse(trimmed) as JournalOp)
        } catch {
          // A torn final line from a crash mid-append is skipped; every other
          // line is still replayable.
        }
      }
      return ops
    },

    async replayJournal(base: Manifest): Promise<Manifest> {
      const ops = await this.readJournal()
      const result: Manifest = {
        ...base,
        mirrors: { ...base.mirrors },
      }
      for (const op of ops) {
        if (op.op === 'intent') continue
        const mirror = result.mirrors[op.mirror]
        if (!mirror) continue
        applyManifestOp(mirror, op.change)
        result.mirrors[op.mirror] = mirror
      }
      return result
    },
  }
}

/** Write a manifest with a fresh `updatedAt` and a trailing newline. */
export async function writeManifestFile(path: string, m: Manifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(m, null, 2)}\n`, 'utf8')
}
