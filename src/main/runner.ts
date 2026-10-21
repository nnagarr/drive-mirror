/**
 * The sync runner.
 *
 * This is the part that ties everything together for one mirror: it scans
 * the disk, checks the guards, builds the Drive tree, asks the diff engine
 * what should happen, and runs the plan.
 *
 * The guards come first, and they come before anything that writes. A guard
 * that trips skips the whole mirror: not a subtree, not a file. Trashing
 * the tree one level at a time is how a partial unmount becomes a mass
 * deletion.
 *
 * The guards also have a memory. A mirror that was skipped keeps its
 * previous file counts, so the next run compares against the same baseline
 * and trips again. Only a run that completed - including one the user
 * explicitly overrode - updates them.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { buildDriveTree, buildListQuery, FOLDER_MIME } from '../core/driveTree'
import { checkCountDrop, rebaseMirror } from '../core/guards'
import { exportInfoFor } from '../core/googleMime'
import { scanLocal } from '../core/localScan'
import { buildClaimIndex, planExportPaths } from '../core/claims'
import { canon } from '../core/paths'
import { diffMirror } from '../core/diff'
import { executePlan, localDisplayName } from '../core/sync'
import type { DiffIo, DriveTree, LocalTree, Manifest, MirrorManifest, Report } from '../core/types'
import type { ManifestStore } from '../core/manifest'
import type { DriveClient } from '../drive/client'
import type { Settings } from './settings'
import type { AppEvent, AppState, MirrorCard, RunSummary } from './ipc'

/** One of the trees being mirrored. */
export interface MirrorSpec {
  /** The name of the folder on Drive, and of the tree on disk. */
  name: string
  /** The local root. */
  root: string
}

/** The trees the user asked for. */
export const DEFAULT_MIRRORS: MirrorSpec[] = [
  { name: 'Medicine', root: 'E:\\Medicine' },
  { name: 'graphicDesign', root: 'E:\\graphicDesign' },
  { name: 'videoEditing', root: 'E:\\videoEditing' },
  { name: 'whoami', root: 'E:\\whoami' },
]

/** The id of the user's Drive root folder. */
export const MY_DRIVE_ID = 'root'

/** What the runner needs from the outside world. */
export interface RunnerDeps {
  client: DriveClient
  store: ManifestStore
  settings: Settings
  emit: (event: AppEvent) => void
  /** The trees to mirror. Defaults to the four the user asked for. */
  mirrors?: MirrorSpec[]
  /** Whether the app holds usable credentials. */
  hasCredentials?: () => boolean
  /** The signed-in account, when it is known. */
  accountEmail?: () => string | null
}

/** The runner's public surface. */
export interface Runner {
  syncNow(mirrorName?: string, options?: { overrideGuard?: boolean }): Promise<RunSummary>
  state(): AppState
  /** Fill in the file counts without syncing anything. */
  prime(): Promise<void>
}

/** The counts a mirror reports. */
interface Counts {
  uploaded: number
  updated: number
  downloaded: number
  trashed: number
  errors: number
}

/** An empty set of counts. */
function noCounts(): Counts {
  return { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 0 }
}

/**
 * Create the runner.
 */
export function createRunner(deps: RunnerDeps): Runner {
  const mirrors = deps.mirrors ?? DEFAULT_MIRRORS
  const cards = new Map<string, MirrorCard>()
  const lastRun: { value: RunSummary | null } = { value: null }
  const running = { value: false }
  const phase = { value: 'idle' }

  for (const mirror of mirrors) {
    cards.set(mirror.name, {
      name: mirror.name,
      localRoot: mirror.root,
      drivePath: `My Drive/${mirror.name}`,
      fileCount: 0,
      lastSyncedAt: null,
      status: 'idle',
      counts: noCounts(),
    })
  }

  function card(name: string): MirrorCard {
    const existing = cards.get(name)
    if (existing) return existing
    const created: MirrorCard = {
      name,
      localRoot: '',
      drivePath: `My Drive/${name}`,
      fileCount: 0,
      lastSyncedAt: null,
      status: 'idle',
      counts: noCounts(),
    }
    cards.set(name, created)
    return created
  }

  function emitState(): void {
    deps.emit({
      type: 'state',
      state: {
        mirrors: [...cards.values()],
        running: running.value,
        phase: phase.value,
        lastRun: lastRun.value,
        accountEmail: deps.accountEmail?.() ?? null,
        needsAuth: !(deps.hasCredentials?.() ?? false),
      },
    })
  }

  /**
   * Run one mirror.
   */
  async function runMirror(
    spec: MirrorSpec,
    manifest: Manifest,
    overrideGuard: boolean,
  ): Promise<{ counts: Counts; changed: Array<{ mirror: string; relPath: string; action: string }>; reports: Report[]; skipped: boolean }> {
    const changed: Array<{ mirror: string; relPath: string; action: string }> = []
    const reports: Report[] = []
    const counts = noCounts()
    const mirrorCard = card(spec.name)

    const mirrorManifest = manifest.mirrors[spec.name] ?? emptyManifestFor(spec.root)

    // --- Guard 1: the local root must exist -------------------------
    let rootStat: ReturnType<typeof statSync>
    try {
      rootStat = statSync(spec.root)
    } catch {
      skipMirror(spec.name, 'missing-root', `the folder ${spec.root} does not exist`, false)
      return { counts, changed, reports, skipped: true }
    }

    // --- Guard 2: the volume must be the same one -------------------
    const driveLetter = driveLetterOf(spec.root)
    const recorded = manifest.volumes[driveLetter]
    const currentDev = rootStat.dev
    if (recorded && recorded.dev !== currentDev) {
      skipMirror(
        spec.name,
        'volume-changed',
        `the drive ${driveLetter} is now a different volume, so the files on it are not the ones that were mirrored`,
        true,
      )
      return { counts, changed, reports, skipped: true }
    }

    // The scan tells us what is on disk, and how many files each folder
    // holds.
    const knownPaths = [
      ...Object.keys(mirrorManifest.files),
      ...Object.values(mirrorManifest.files).map((entry) => entry.localPath),
      ...Object.values(mirrorManifest.retired).map((record) => record.path),
    ]
    const local = await scanLocal({ root: spec.root, knownPaths })

    // --- Guard 3: no folder may have lost more than half its files --
    if (!overrideGuard) {
      const hits = checkCountDrop(
        mirrorManifest.lastCounts,
        local.recursiveCounts,
        deps.settings.guardThreshold,
      )
      if (hits.length > 0) {
        const where = hits.map((hit) => hit.dir || 'the root').join(', ')
        skipMirror(
          spec.name,
          'count-drop',
          `the number of files fell by more than half in: ${where}`,
          true,
        )
        return { counts, changed, reports, skipped: true }
      }
    }

    // --- Guard 4: resolve the Drive folder ---------------------------
    phase.value = 'folders'
    const folderId = await resolveMirrorFolder(deps.client, spec.name)
    if (folderId === null) {
      skipMirror(
        spec.name,
        'ambiguous-folder',
        `more than one folder called ${spec.name} exists on Drive`,
        false,
      )
      return { counts, changed, reports, skipped: true }
    }

    // --- The Drive tree ----------------------------------------------
    const nodes = await listTree(deps.client, folderId)
    const drive: DriveTree = buildDriveTree(nodes)

    // The only ids this run may write under are the ones inside the
    // resolved folder. They are rebuilt from the tree, so a stale id in
    // the manifest cannot point somewhere else.
    mirrorManifest.driveFolderId = folderId
    mirrorManifest.dirs = {}
    for (const [path, id] of drive.dirs) {
      mirrorManifest.dirs[path] = { driveFolderId: id }
    }

    // A folder that exists on disk but not on Drive is created, parents
    // first, so an empty folder is mirrored as an empty folder.
    await createMissingFolders(deps.client, spec.root, local, mirrorManifest, folderId)

    // --- The plan ----------------------------------------------------
    const io = buildIo(deps.client, spec.root, drive)
    const exportPlan = planExportPaths(drive, mirrorManifest, local)
    buildClaimIndex(mirrorManifest, exportPlan, drive)

    const plan = await diffMirror({
      local,
      drive,
      manifest: mirrorManifest,
      io,
      mergeOnly: mirrorManifest.rebase?.pending ?? false,
      driveWins: (mirrorManifest.rebase?.mergePolicy ?? 'local-wins') === 'drive-wins',
    })

    // --- Run it ------------------------------------------------------
    phase.value = 'uploads'
    const result = await executePlan(plan, {
      client: deps.client,
      store: deps.store,
      manifest: mirrorManifest,
      root: spec.root,
      archiveDir: deps.settings.supersededPath,
      onProgress: (event) => {
        deps.emit({
          type: 'progress',
          mirror: spec.name,
          relPath: event.relPath,
          phase: event.phase,
          done: 0,
          total: 0,
        })
      },
    })

    counts.uploaded = result.uploaded
    counts.updated = result.replaced
    counts.downloaded = result.downloaded + result.exported
    counts.trashed = result.trashed
    counts.errors = result.errors.length
    reports.push(...result.reports)

    for (const step of plan.steps) {
      if (step.action) {
        changed.push({
          mirror: spec.name,
          relPath: step.action.relPath,
          action: step.action.kind,
        })
      }
    }

    // --- Remember what was there -------------------------------------
    // The counts are merged: a folder that has since been deleted is
    // recorded as empty rather than forgotten, so its disappearance is
    // visible next time.
    const merged: Record<string, number> = {}
    for (const dir of Object.keys(mirrorManifest.lastCounts)) merged[dir] = 0
    for (const [dir, count] of Object.entries(local.recursiveCounts)) {
      merged[dir] = count
    }
    mirrorManifest.lastCounts = merged
    mirrorManifest.lastSyncAt = new Date().toISOString()

    manifest.volumes[driveLetter] = {
      dev: currentDev,
      checkedAt: new Date().toISOString(),
    }
    manifest.mirrors[spec.name] = mirrorManifest

    mirrorCard.status = 'idle'
    mirrorCard.fileCount = local.recursiveCounts[''] ?? 0
    mirrorCard.lastSyncedAt = mirrorManifest.lastSyncAt ?? null
    mirrorCard.counts = counts

    return { counts, changed, reports, skipped: false }
  }

  function skipMirror(
    name: string,
    reason: string,
    message: string,
    canOverride: boolean,
  ): void {
    const mirrorCard = card(name)
    mirrorCard.status = 'skipped'
    deps.emit({
      type: 'guard',
      mirror: name,
      reason,
      message,
      canOverride,
    })
  }

  const runner: Runner = {
    async prime(): Promise<void> {
      const manifest = await deps.store.read()
      for (const spec of mirrors) {
        const mirrorCard = card(spec.name)
        mirrorCard.localRoot = spec.root
        mirrorCard.drivePath = `My Drive/${spec.name}`
        const mirrorManifest = manifest.mirrors[spec.name]
        mirrorCard.lastSyncedAt = mirrorManifest?.lastSyncAt ?? null
        try {
          const local = await scanLocal({ root: spec.root, knownPaths: [] })
          mirrorCard.fileCount = local.recursiveCounts[''] ?? 0
        } catch {
          // The folder is not there. A run will say so.
        }
      }
      emitState()
    },

    async syncNow(mirrorName?: string, options?: { overrideGuard?: boolean }) {
      const startedAt = new Date().toISOString()
      running.value = true
      phase.value = 'starting'
      emitState()

      const manifest = await deps.store.read()
      const selected = mirrorName
        ? mirrors.filter((m) => m.name === mirrorName)
        : mirrors

      const summary: RunSummary = {
        startedAt,
        finishedAt: startedAt,
        uploaded: 0,
        updated: 0,
        downloaded: 0,
        trashed: 0,
        errors: 0,
        mirrors: [],
        changed: [],
        reports: [],
      }

      for (const spec of selected) {
        const outcome = await runMirror(spec, manifest, options?.overrideGuard ?? false)
        summary.uploaded += outcome.counts.uploaded
        summary.updated += outcome.counts.updated
        summary.downloaded += outcome.counts.downloaded
        summary.trashed += outcome.counts.trashed
        summary.errors += outcome.counts.errors
        summary.mirrors.push({ name: spec.name, counts: outcome.counts })
        summary.changed.push(...outcome.changed)
        summary.reports.push(...outcome.reports)
      }

      summary.finishedAt = new Date().toISOString()
      await deps.store.checkpoint(manifest)

      running.value = false
      phase.value = 'idle'
      lastRun.value = summary
      emitState()
      deps.emit({ type: 'finished', summary })
      return summary
    },

    state(): AppState {
      return {
        mirrors: [...cards.values()],
        running: running.value,
        phase: phase.value,
        lastRun: lastRun.value,
        accountEmail: deps.accountEmail?.() ?? null,
        needsAuth: !(deps.hasCredentials?.() ?? false),
      }
    },
  }

  return runner
}

/** An empty manifest for a mirror that has never run. */
function emptyManifestFor(root: string): MirrorManifest {
  return {
    root,
    lastCounts: {},
    rebase: null,
    dirs: {},
    files: {},
    retired: {},
  }
}

/** The drive letter of a path, e.g. `E:`. */
function driveLetterOf(root: string): string {
  const match = /^([a-zA-Z]):/.exec(root)
  return match ? `${match[1]!.toUpperCase()}:` : 'E:'
}

/**
 * Find the Drive folder for a mirror.
 *
 * A folder that does not exist is created under My Drive, because a mirror
 * whose folder has been deleted should rebuild itself rather than stop.
 * More than one folder with the same name is refused: choosing one of them
 * would send the mirror into the wrong tree.
 */
async function resolveMirrorFolder(
  client: DriveClient,
  name: string,
): Promise<string | null> {
  const children = await client.listChildren(MY_DRIVE_ID)
  const matches = children.filter(
    (node) =>
      node.entry.mimeType === FOLDER_MIME &&
      node.entry.name.toLowerCase() === name.toLowerCase(),
  )
  if (matches.length > 1) return null
  if (matches.length === 1) return matches[0]!.entry.id
  const created = await client.createFolder(name, MY_DRIVE_ID)
  return created.id
}

/**
 * Create the Drive folders for the local directories that do not have one.
 *
 * The order is by depth, so a folder is always created after the folder
 * that holds it. Every folder created here is inside the resolved mirror
 * folder: the run never writes outside the tree it was given.
 */
async function createMissingFolders(
  client: DriveClient,
  root: string,
  local: LocalTree,
  mirrorManifest: MirrorManifest,
  mirrorFolderId: string,
): Promise<void> {
  const directories = [...local.dirs]
    .filter((dir) => dir !== '')
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))

  for (const dir of directories) {
    if (mirrorManifest.dirs[dir]) continue
    const parent = parentPathOf(dir)
    const parentId =
      parent === ''
        ? mirrorFolderId
        : mirrorManifest.dirs[parent]?.driveFolderId
    if (!parentId) continue
    const name =
      (await localDisplayName(root, dir)) ?? dir.split('/').pop() ?? dir
    const created = await client.createFolder(name, parentId)
    mirrorManifest.dirs[dir] = { driveFolderId: created.id }
  }
}

/** How deep a canonical path is. */
function depth(path: string): number {
  return path.split('/').filter((p) => p.length > 0).length
}

/** The containing directory of a canonical path. */
function parentPathOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/**
 * List a Drive subtree, and assemble the paths.
 */
async function listTree(
  client: DriveClient,
  rootFolderId: string,
): Promise<Array<{ entry: import('../core/types').DriveNode['entry']; parentPath: string }>> {
  const out: Array<{ entry: import('../core/types').DriveNode['entry']; parentPath: string }> = []
  const seen = new Set<string>()
  const queue: Array<{ id: string; path: string }> = [{ id: rootFolderId, path: '' }]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (seen.has(current.id)) continue
    seen.add(current.id)

    const children = await client.listChildren(current.id)
    for (const node of children) {
      const childPath =
        current.path === ''
          ? canon(node.entry.name)
          : `${current.path}/${canon(node.entry.name)}`
      out.push({ entry: node.entry, parentPath: current.path })
      if (node.entry.mimeType === FOLDER_MIME) {
        queue.push({ id: node.entry.id, path: childPath })
      }
    }
  }

  return out
}

/**
 * The port through which the diff engine reaches the outside world.
 */
function buildIo(client: DriveClient, root: string, drive: DriveTree): DiffIo {
  // Where each Drive file id lives now, so a probe can say whether a file
  // moved.
  const pathById = new Map<string, string>()
  for (const [path, files] of drive.files) {
    for (const file of files) pathById.set(file.id, path)
  }

  const mimeById = new Map<string, string>()
  for (const files of drive.files.values()) {
    for (const file of files) mimeById.set(file.id, file.mimeType)
  }

  return {
    async probe(driveFileId: string) {
      let node: Awaited<ReturnType<DriveClient['getFile']>>
      try {
        node = await client.getFile(driveFileId)
      } catch {
        return { status: 'missing' as const }
      }
      if (!node) return { status: 'missing' as const }
      if (node.entry.trashed) return { status: 'trashed' as const }
      return {
        status: 'alive' as const,
        currentPath: pathById.get(driveFileId) ?? '',
      }
    },

    async md5Of(relPath: string) {
      return md5OfFile(join(root, relPath))
    },

    async readLocalBytes(relPath: string) {
      try {
        return await readFile(join(root, relPath))
      } catch {
        return null
      }
    },

    async exportNative(driveFileId: string) {
      const info = exportInfoFor(mimeById.get(driveFileId) ?? '')
      if (!info) return null
      const temp = join(tmpdir(), `drive-mirror-export-${driveFileId}`)
      try {
        await client.exportTo(driveFileId, temp, info.exportMime)
        return await readFile(temp)
      } catch {
        return null
      } finally {
        await rm(temp, { force: true })
      }
    },
  }
}

/** The MD5 of a file, or null when it cannot be read. */
async function md5OfFile(abs: string): Promise<string | null> {
  try {
    const hash = createHash('md5')
    await pipeline(createReadStream(abs), hash)
    return hash.digest('hex')
  } catch {
    return null
  }
}

/** The size of a local file, for the mirror card. */
function fileSize(abs: string): number {
  try {
    return statSync(abs).size
  } catch {
    return 0
  }
}

/** Re-exported so the runner's helpers are usable elsewhere. */
export { buildListQuery, rebaseMirror, readFileSync, fileSize }
