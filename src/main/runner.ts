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
 *
 * Two locks stand in front of a run. The first is in this process: a second
 * "Sync now" while a run is going joins the run that is already happening
 * instead of starting a second one, because two runs that read the manifest
 * at the same time would both write it and the last writer would win. The
 * second is a file on disk, so a scheduled run in its own process and the
 * window the user is looking at cannot write the manifest at the same time
 * either. Both locks are released when the run ends, and a run that fails
 * releases them too.
 *
 * The settings are read when a run starts, not when the app starts. A
 * folder the user adds in the interface is mirrored by the next run, with
 * no restart in between.
 */

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { mkdir, open, readFile, rm, stat, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { writeAtomic } from '../core/atomic'
import { buildDriveTree, FOLDER_MIME } from '../core/driveTree'
import { resolveMirrorPath } from '../core/drivePath'
import { checkCountDrop, checkVolumeFingerprint, rebaseMirror } from '../core/guards'
import { exportInfoFor } from '../core/googleMime'
import { scanLocal } from '../core/localScan'
import { buildClaimIndex, planExportPaths } from '../core/claims'
import { canon } from '../core/paths'
import { diffMirror } from '../core/diff'
import { executePlan, localDisplayName } from '../core/sync'
import type {
  DiffIo,
  DriveTree,
  LocalTree,
  Manifest,
  MirrorManifest,
  Report,
} from '../core/types'
import { emptyMirror, serialiseManifest } from '../core/manifest'
import type { ManifestStore } from '../core/manifest'
import type { MirrorConfig } from '../core/mirrorConfig'
import type { DriveClient } from '../drive/client'
import { appDataDir } from './settings'
import type { Settings } from './settings'
import type { AppEvent, AppState, MirrorCard, RunSummary } from './ipc'

/** The id of the user's Drive root folder. */
export const MY_DRIVE_ID = 'root'

/** How long a lock file may be old before it is treated as stale. */
const LOCK_STALE_MS = 6 * 60 * 60 * 1000

/** How long a removed mirror is remembered before it is forgotten. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/** What the runner needs from the outside world. */
export interface RunnerDeps {
  client: DriveClient
  store: ManifestStore
  /**
   * The settings as they are now.
   *
   * A getter, not a value: the user can add a folder, pause a mirror or
   * change a destination while the app is running, and the next run must
   * see it without a restart.
   */
  settings: () => Promise<Settings>
  emit: (event: AppEvent) => void
  /**
   * Where the lock file lives.
   *
   * The lock is what stops a scheduled run and the window from writing the
   * manifest at the same time. It sits with the app's other files.
   */
  lockPath?: string
  /** Whether the app holds usable credentials. */
  hasCredentials?: () => boolean | Promise<boolean>
  /** The signed-in account, when it is known. */
  accountEmail?: () => string | null | Promise<string | null>
  /** Save part of the settings. */
  saveSettings?: (patch: Partial<Settings>) => Promise<Settings>
  /**
   * Where a message about the run that is not an error goes.
   *
   * A backup copy that could not be written is one of those: the run
   * itself is fine, but the user should be able to find out that their
   * safety net was not refreshed.
   */
  log?: (message: string) => void
}

/** The runner's public surface. */
export interface Runner {
  syncNow(mirrorName?: string, options?: { overrideGuard?: boolean }): Promise<RunSummary>
  state(): Promise<AppState>
  /** Fill in the file counts without syncing anything. */
  prime(): Promise<void>
  /**
   * Approve a new volume for a mirror.
   *
   * The mirror's live entries describe the volume it was mirrored from.
   * They become retired records, and the next run merges the two sides
   * with the Drive copy winning - the only surviving version of the work.
   */
  rebase(mirrorName: string): Promise<void>

  /**
   * Move a mirror's folder on Drive to a new destination.
   *
   * The folder is moved rather than copied: the file ids stay valid, so the
   * manifest keeps working and nothing is uploaded again.
   */
  moveMirrorDestination(
    mirrorName: string,
    drivePath: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>

  /**
   * Forget the mirrors the user removed more than thirty days ago.
   *
   * Their history goes: the file list, the retired records, the counts.
   * The superseded copies on disk are left alone - they are the only local
   * copies of the bytes the app replaced, and the user prunes those
   * themselves.
   */
  pruneRemovedMirrors(): Promise<number>

  /**
   * Pull a restored file back down to the disk.
   *
   * A file the app trashed, that the user then restored on Drive, can be
   * brought back. Nothing is overwritten: if something is already at the
   * path and it is not the same file, the download is refused.
   */
  downloadRestored(
    mirrorName: string,
    driveFileId: string,
  ): Promise<{ ok: true; path: string } | { ok: false; message: string }>
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
  const cards = new Map<string, MirrorCard>()
  const lastRun: { value: RunSummary | null } = { value: null }
  const running = { value: false }
  const phase = { value: 'idle' }
  /** The run that is going, when there is one. */
  let inFlight: Promise<RunSummary> | null = null
  const lockPath = deps.lockPath ?? defaultLockPath()

  /** The card for a mirror, created when it is not known yet. */
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
      recovered: [],
      enabled: true,
    }
    cards.set(name, created)
    return created
  }

  /** Whether the app is signed in, and as whom. */
  const auth = { signedIn: false, email: null as string | null }

  async function refreshAuth(): Promise<void> {
    auth.signedIn = deps.hasCredentials ? Boolean(await deps.hasCredentials()) : false
    auth.email = (await deps.accountEmail?.()) ?? null
  }

  /**
   * The state of the app, as the interface sees it.
   *
   * The mirrors come from the settings, which are the source of truth; the
   * cards are only what the last run learned about them. A mirror the user
   * added a moment ago therefore has a card at once.
   */
  function buildState(settings: Settings, manifest: Manifest): AppState {
    return {
      mirrors: configuredMirrors(settings).map((config) => {
        const mirrorCard = card(config.name)
        mirrorCard.localRoot = config.root
        mirrorCard.drivePath = `My Drive/${config.drivePath}`
        mirrorCard.enabled = config.enabled
        // The files the user restored on Drive, waiting to be pulled back.
        mirrorCard.recovered = Object.values(manifest.mirrors[config.name]?.retired ?? {})
          .filter((record) => record.state === 'restored')
          .map((record) => {
            const relPath = record.localPath ?? record.path
            const target = join(config.root, ...relPath.split('/'))
            let blocked: string | undefined
            try {
              statSync(target)
              blocked = 'There is already a file at that path. Move it or delete it first.'
            } catch {
              // Nothing is there, so the file can come back.
            }
            return {
              driveFileId: record.id,
              path: record.path,
              at: record.at,
              blocked,
            }
          })
        return { ...mirrorCard }
      }),
      running: running.value,
      phase: phase.value,
      lastRun: lastRun.value,
      accountEmail: auth.email,
      needsAuth: !auth.signedIn,
    }
  }

  function emitState(): void {
    void (async () => {
      try {
        await refreshAuth()
        const settings = await deps.settings()
        const manifest = await deps.store.read()
        deps.emit({ type: 'state', state: buildState(settings, manifest) })
      } catch {
        // The state event is a picture of the app for the interface. A
        // failure to draw it must not take the run down with it.
      }
    })()
  }

  /**
   * Run one mirror.
   */
  async function runMirror(
    config: MirrorConfig,
    manifest: Manifest,
    overrideGuard: boolean,
    settings: Settings,
  ): Promise<{ counts: Counts; changed: Array<{ mirror: string; relPath: string; action: string }>; reports: Report[]; skipped: boolean }> {
    const changed: Array<{ mirror: string; relPath: string; action: string }> = []
    const reports: Report[] = []
    const counts = noCounts()
    const mirrorCard = card(config.name)

    const mirrorManifest = manifest.mirrors[config.name] ?? emptyMirror(config.root)

    // --- Guard 1: the local root must exist -------------------------
    let rootStat: ReturnType<typeof statSync>
    try {
      rootStat = statSync(config.root)
    } catch {
      skipMirror(
        config.name,
        'missing-root',
        `the folder ${config.root} does not exist`,
        false,
        reports,
      )
      return { counts, changed, reports, skipped: true }
    }

    // --- Guard 2: the volume must be the same one -------------------
    // Two things have to hold: the drive letter must still be the same
    // volume it was, and the mirror's own root must be on that volume.
    // A reassigned drive letter or a swapped disk would otherwise look
    // exactly like "every file was deleted".
    //
    // A path with no drive letter - a UNC share, say - has no letter to
    // check, so there is nothing to compare and the root's own device is
    // all there is.
    const driveLetter = driveLetterOf(config.root)
    if (driveLetter) {
      const driveDev = volumeDevOf(driveLetter)

      // 1. The drive letter must still be the volume it was. A reassigned
      //    letter or a swapped disk changes the serial.
      const recorded = manifest.volumes[driveLetter]
      if (checkVolumeFingerprint(recorded, { dev: driveDev ?? rootStat.dev })) {
        skipMirror(
          config.name,
          'volume-changed',
          `the drive ${driveLetter} is now a different volume, so the files on it are not the ones that were mirrored`,
          true,
          reports,
        )
        return { counts, changed, reports, skipped: true }
      }

      // 2. The mirror's own root must be on that drive. A folder that has
      //    become a junction to another disk would otherwise look like
      //    every file was deleted.
      if (driveDev !== null && driveDev !== rootStat.dev) {
        skipMirror(
          config.name,
          'volume-changed',
          `the folder ${config.root} is on a different volume from the drive ${driveLetter}`,
          true,
          reports,
        )
        return { counts, changed, reports, skipped: true }
      }
    }

    // The scan tells us what is on disk, and how many files each folder
    // holds.
    const knownPaths = [
      ...Object.keys(mirrorManifest.files),
      ...Object.values(mirrorManifest.files).map((entry) => entry.localPath),
      ...Object.values(mirrorManifest.retired).map((record) => record.path),
    ]
    const local = await scanLocal({ root: config.root, knownPaths })

    // --- Guard 3: no folder may have lost more than half its files ---
    if (!overrideGuard) {
      const hits = checkCountDrop(
        mirrorManifest.lastCounts,
        local.recursiveCounts,
        settings.guardThreshold,
      )
      if (hits.length > 0) {
        const where = hits.map((hit) => hit.dir || 'the root').join(', ')
        skipMirror(
          config.name,
          'count-drop',
          `the number of files fell by more than half in: ${where}`,
          true,
          reports,
        )
        return { counts, changed, reports, skipped: true }
      }
    }

    // --- Guard 4: resolve the Drive folder ---------------------------
    phase.value = 'folders'
    // The destination is a path under My Drive. The stored id wins, so a
    // folder the user renamed in the Drive browser is honoured rather
    // than duplicated.
    const resolved = await resolveMirrorPath(
      deps.client,
      config.drivePath,
      MY_DRIVE_ID,
      mirrorManifest.driveFolderId,
    )
    if ('ambiguous' in resolved) {
      skipMirror(
        config.name,
        'ambiguous-folder',
        `there is more than one folder called ${resolved.segment} on Drive, so the mirror was left alone`,
        false,
        reports,
      )
      return { counts, changed, reports, skipped: true }
    }
    const folderId = resolved.id

    // --- The Drive tree ----------------------------------------------
    const nodes = await listTree(deps.client, folderId)
    const drive: DriveTree = buildDriveTree(nodes)

    // The only ids this run may write under are the ones inside the
    // resolved folder. They are rebuilt from the tree, so a stale id in
    // the manifest cannot point somewhere else.
    mirrorManifest.driveFolderId = folderId
    mirrorManifest.driveFolderName = resolved.name
    mirrorManifest.drivePath = config.drivePath
    mirrorManifest.dirs = {}
    for (const [path, id] of drive.dirs) {
      mirrorManifest.dirs[path] = { driveFolderId: id }
    }

    // A folder that exists on disk but not on Drive is created, parents
    // first, so an empty folder is mirrored as an empty folder.
    await createMissingFolders(deps.client, config.root, local, mirrorManifest, folderId)

    // --- The plan ----------------------------------------------------
    const io = buildIo(deps.client, config.root, drive)
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
      root: config.root,
      archiveDir: settings.supersededPath,
      onProgress: (event) => {
        deps.emit({
          type: 'progress',
          mirror: config.name,
          relPath: event.relPath,
          phase: event.phase,
          done: event.done,
          total: event.total,
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
          mirror: config.name,
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

    // The volume is only remembered when the path has a drive letter.
    // There is no letter to key it by otherwise.
    if (driveLetter) {
      manifest.volumes[driveLetter] = {
        dev: rootStat.dev,
        checkedAt: new Date().toISOString(),
      }
    }
    manifest.mirrors[config.name] = mirrorManifest

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
    reports: Report[],
  ): void {
    const mirrorCard = card(name)
    mirrorCard.status = 'skipped'
    // A skipped mirror is something the user has to know about. Without
    // this in the summary, a run that skipped half the mirrors reads as
    // "everything is up to date".
    reports.push({ code: 'anomaly', relPath: '', message })
    deps.emit({
      type: 'guard',
      mirror: name,
      reason,
      message,
      canOverride,
    })
  }

  /**
   * The run itself, without the in-process lock.
   *
   * The lock file is taken first and given back in the `finally`, so a run
   * that fails does not leave the next one waiting for a lock nobody
   * holds.
   */
  async function runSync(
    mirrorName?: string,
    options?: { overrideGuard?: boolean },
  ): Promise<RunSummary> {
    const locked = await acquireSyncLock(lockPath, new Date())
    if (!locked) {
      const message = 'another sync was already running, so this run was skipped'
      note(deps.log, message)
      const skipped = emptySummary()
      // The run did nothing, but the user has to be told that. A summary
      // with no numbers reads as "everything is up to date", which is the
      // opposite of the truth.
      skipped.reports.push({ code: 'anomaly', relPath: '', message })
      return skipped
    }

    try {
      const startedAt = new Date().toISOString()
      running.value = true
      phase.value = 'starting'
      emitState()

      // The settings are read now, not when the app started: a folder the
      // user added a moment ago is mirrored by this run.
      const settings = await deps.settings()
      const manifest = await deps.store.read()
      const selected = mirrorName
        ? mirrorsToSync(settings).filter((config) => config.name === mirrorName)
        : mirrorsToSync(settings)

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

      // The manifest belongs to one Google account. A file id in it
      // points at a file that account can see, so a different account
      // cannot use it at all. The run is blocked rather than quietly
      // producing a broken mirror.
      const signedIn = await deps.accountEmail?.()
      const owner =
        typeof manifest.accountEmail === 'string' ? manifest.accountEmail : null
      if (signedIn && owner && owner !== signedIn) {
        const message =
          `this manifest belongs to ${owner}, but you are signed in as ${signedIn}. ` +
          'Start a new manifest for this account before syncing.'
        deps.emit({ type: 'error', message })
        note(deps.log, message)
        summary.errors = 1
        summary.reports.push({ code: 'anomaly', relPath: '', message })
        return summary
      }
      if (signedIn && !owner) {
        // The first run on this account. The manifest now belongs to it.
        manifest.accountEmail = signedIn
      }

      for (const config of selected) {
        const outcome = await runMirror(config, manifest, options?.overrideGuard ?? false, settings)
        summary.uploaded += outcome.counts.uploaded
        summary.updated += outcome.counts.updated
        summary.downloaded += outcome.counts.downloaded
        summary.trashed += outcome.counts.trashed
        summary.errors += outcome.counts.errors
        summary.mirrors.push({ name: config.name, counts: outcome.counts })
        summary.changed.push(...outcome.changed)
        summary.reports.push(...outcome.reports)
      }

      summary.finishedAt = new Date().toISOString()
      await deps.store.checkpoint(manifest)
      const backups = await writeBackups(settings.backupPaths, manifest, deps.log)
      for (const path of backups.failed) {
        // The sync itself is fine, but the safety net is not being
        // refreshed, and the user has to know that.
        deps.emit({
          type: 'notice',
          message: `the backup copy at ${path} could not be written, so the manifest has no safety net there`,
        })
      }
      // A manual "Sync now" is a run too. It resets the missed-slot
      // clock, so the app does not also do a catch-up run on top of it.
      if (deps.saveSettings) {
        const current = await deps.settings()
        await deps.saveSettings({
          schedule: { ...current.schedule, lastRunAt: summary.finishedAt },
        })
      }

      lastRun.value = summary
      deps.emit({ type: 'finished', summary })
      return summary
    } finally {
      // Whatever happened, the app is not syncing any more and the lock
      // is free again.
      running.value = false
      phase.value = 'idle'
      emitState()
      try {
        await releaseSyncLock(lockPath)
      } catch (err) {
        // A lock that cannot be removed is stale in six hours' time. It
        // must not hide the error the run failed with.
        note(
          deps.log,
          `the sync lock could not be removed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  const runner: Runner = {
    async prime(): Promise<void> {
      const settings = await deps.settings()
      const manifest = await deps.store.read()
      for (const config of configuredMirrors(settings)) {
        const mirrorCard = card(config.name)
        mirrorCard.localRoot = config.root
        mirrorCard.drivePath = `My Drive/${config.drivePath}`
        const mirrorManifest = manifest.mirrors[config.name]
        mirrorCard.lastSyncedAt = mirrorManifest?.lastSyncAt ?? null
        try {
          const local = await scanLocal({ root: config.root, knownPaths: [] })
          mirrorCard.fileCount = local.recursiveCounts[''] ?? 0
        } catch {
          // The folder is not there. A run will say so.
        }
      }
      emitState()
    },

    async rebase(mirrorName: string): Promise<void> {
      // A re-approve must not interleave with a run. The run holds the
      // manifest in memory and would write it back over this change, so
      // the user's approval would be lost without a word. Wait for a run
      // in this process, and take the lock for the rest.
      if (inFlight) {
        await inFlight.catch(() => undefined)
      }
      const locked = await acquireSyncLock(lockPath, new Date())
      if (!locked) {
        throw new Error(
          'another sync is running, so the drive could not be re-approved yet',
        )
      }

      try {
        const settings = await deps.settings()
        const manifest = await deps.store.read()
        const config = settings.mirrors.find((m) => m.name === mirrorName)
        if (!config) return

        const mirrorManifest = manifest.mirrors[mirrorName] ?? emptyMirror(config.root)

        // The live entries describe the OLD volume. They become retired
        // records, so the engine can later tell "the same file came back"
        // from "a different file took its place".
        manifest.mirrors[mirrorName] = rebaseMirror(
          mirrorManifest,
          new Date().toISOString(),
        )

        // The new volume's serial is what is recorded from now on.
        const driveLetter = driveLetterOf(config.root)
        if (driveLetter) {
          const dev = volumeDevOf(driveLetter)
          if (dev !== null) {
            manifest.volumes[driveLetter] = {
              dev,
              checkedAt: new Date().toISOString(),
            }
          }
        }

        await deps.store.checkpoint(manifest)
        await writeBackups(settings.backupPaths, manifest, deps.log)
      } finally {
        try {
          await releaseSyncLock(lockPath)
        } catch (err) {
          // A lock that cannot be removed is stale in six hours' time. It
          // must not hide the error the re-approve failed with.
          note(
            deps.log,
            `the sync lock could not be removed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    },

    async moveMirrorDestination(
      mirrorName: string,
      drivePath: string,
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      const settings = await deps.settings()
      const config = settings.mirrors.find((m) => m.name === mirrorName)
      if (!config) {
        return { ok: false, message: `There is no mirror called ${mirrorName}.` }
      }
      if (config.drivePath === drivePath) return { ok: true }

      const manifest = await deps.store.read()
      const mirrorManifest = manifest.mirrors[mirrorName]
      const folderId = mirrorManifest?.driveFolderId
      if (!folderId) {
        // Nothing is on Drive for this mirror yet, so there is nothing to
        // move. The next run puts it where it belongs.
        return { ok: true }
      }

      const segments = drivePath.split('/').filter((s) => s.length > 0)
      const newName = segments[segments.length - 1] ?? config.name
      const parentPath = segments.slice(0, -1).join('/')

      let parentId = MY_DRIVE_ID
      if (parentPath) {
        const resolved = await resolveMirrorPath(deps.client, parentPath, MY_DRIVE_ID)
        if ('ambiguous' in resolved) {
          return {
            ok: false,
            message:
              `There is more than one folder called ${resolved.segment} on Drive, ` +
              'so the folder was not moved.',
          }
        }
        parentId = resolved.id
      }

      try {
        await deps.client.moveFolder(folderId, parentId, newName)
      } catch (err) {
        return {
          ok: false,
          message:
            'The folder on Drive could not be moved: ' +
            (err instanceof Error ? err.message : String(err)),
        }
      }

      // The id does not change when a folder moves, so the manifest keeps
      // working and nothing is uploaded again.
      if (mirrorManifest) {
        mirrorManifest.driveFolderName = newName
        mirrorManifest.drivePath = drivePath
      }
      await deps.store.checkpoint(manifest)
      return { ok: true }
    },

    async pruneRemovedMirrors(): Promise<number> {
      const settings = await deps.settings()
      const manifest = await deps.store.read()
      const cutoff = Date.now() - THIRTY_DAYS_MS
      const forgotten: string[] = []
      for (const config of settings.mirrors) {
        if (!config.removedAt) continue
        if (Date.parse(config.removedAt) > cutoff) continue
        if (!manifest.mirrors[config.name]) continue
        delete manifest.mirrors[config.name]
        forgotten.push(config.name)
      }
      if (forgotten.length === 0) return 0
      await deps.store.checkpoint(manifest)
      // The configuration goes too, so the mirror is forgotten entirely.
      if (deps.saveSettings) {
        const current = await deps.settings()
        await deps.saveSettings({
          mirrors: current.mirrors.filter((m) => !forgotten.includes(m.name)),
        })
      }
      return forgotten.length
    },

    async downloadRestored(
      mirrorName: string,
      driveFileId: string,
    ): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
      const settings = await deps.settings()
      const config = settings.mirrors.find((m) => m.name === mirrorName)
      if (!config) {
        return { ok: false, message: `There is no mirror called ${mirrorName}.` }
      }

      const manifest = await deps.store.read()
      const mirrorManifest = manifest.mirrors[mirrorName]
      const record = Object.values(mirrorManifest?.retired ?? {}).find(
        (r) => r.id === driveFileId,
      )
      if (!record) {
        return {
          ok: false,
          message: 'That file is not one this app stopped tracking.',
        }
      }
      if (record.state !== 'restored') {
        return { ok: false, message: 'That file is not waiting to be recovered.' }
      }

      // The path it lands at: the export path for a Google-native file,
      // and the relative path for anything else.
      const relPath = record.localPath ?? record.path
      const dest = join(config.root, ...relPath.split('/'))

      const node = await deps.client.getFile(driveFileId)
      if (!node) {
        return { ok: false, message: 'That file is not on Drive any more.' }
      }

      // The bytes are fetched first, into a temporary file. The comparison
      // is then between the file that is there and the file that is
      // coming - which works for a Google-native file too, where Drive
      // has no hash of its own to compare against.
      const tempPath = join(appDataDir(), `recovered-${driveFileId}.tmp`)
      try {
        const native = exportInfoFor(record.driveMimeType)
        if (native) {
          await deps.client.exportTo(driveFileId, tempPath, native.exportMime)
        } else {
          await deps.client.downloadTo(driveFileId, tempPath)
        }
      } catch (err) {
        await rm(tempPath, { force: true })
        return {
          ok: false,
          message:
            'The file could not be brought back: ' +
            (err instanceof Error ? err.message : String(err)),
        }
      }

      // Something already at that path is only replaced when it is the
      // same file.
      const incoming = await md5OfFile(tempPath)
      const existing = await md5OfFile(dest)
      if (existing !== null && existing !== incoming) {
        await rm(tempPath, { force: true })
        return {
          ok: false,
          message:
            `There is already a file at ${relPath}, and it is not the same one. ` +
            'Nothing was replaced.',
        }
      }

      try {
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(tempPath, dest)
      } catch (err) {
        await rm(tempPath, { force: true })
        return {
          ok: false,
          message:
            'The file could not be put back: ' +
            (err instanceof Error ? err.message : String(err)),
        }
      }
      await rm(tempPath, { force: true })

      // The file is live again.
      const info = await stat(dest).catch(() => null)
      const localMd5 = (await md5OfFile(dest)) ?? incoming
      record.state = 'resynced'
      record.at = new Date().toISOString()
      if (mirrorManifest) {
        mirrorManifest.files[record.path] = {
          displayPath: record.path,
          driveFileId,
          driveMd5: node.entry.md5Checksum ?? null,
          driveModifiedTime: node.entry.modifiedTime,
          driveMimeType: node.entry.mimeType,
          exportMime: exportInfoFor(node.entry.mimeType)?.exportMime ?? null,
          localPath: relPath,
          localMd5,
          localSize: info?.size ?? 0,
          localMtimeMs: info?.mtimeMs ?? 0,
        }
      }
      await deps.store.checkpoint(manifest)
      return { ok: true, path: relPath }
    },

    async syncNow(mirrorName?: string, options?: { overrideGuard?: boolean }) {
      // A run that is already going is the run. A second "Sync now"
      // joins it rather than starting a second one, because two runs
      // that read the manifest at the same time would both write it.
      if (inFlight) return inFlight
      inFlight = runSync(mirrorName, options).finally(() => {
        inFlight = null
      })
      return inFlight
    },

    async state(): Promise<AppState> {
      const settings = await deps.settings()
      const manifest = await deps.store.read()
      return buildState(settings, manifest)
    },
  }

  return runner
}

/**
 * The mirrors the app is configured with.
 *
 * A mirror the user removed is not one of them: it keeps its name and its
 * folder until it is forgotten, but it is not mirrored any more.
 */
function configuredMirrors(settings: Settings): MirrorConfig[] {
  return settings.mirrors.filter((config) => !config.removedAt)
}

/**
 * The mirrors a run should sync: the ones that are enabled and have not
 * been removed.
 */
function mirrorsToSync(settings: Settings): MirrorConfig[] {
  return settings.mirrors.filter((config) => config.enabled && !config.removedAt)
}

/** A summary of a run that did not happen. */
function emptySummary(): RunSummary {
  const now = new Date().toISOString()
  return {
    startedAt: now,
    finishedAt: now,
    uploaded: 0,
    updated: 0,
    downloaded: 0,
    trashed: 0,
    errors: 0,
    mirrors: [],
    changed: [],
    reports: [],
  }
}

/**
 * The lock file's place: with the app's other files.
 */
function defaultLockPath(): string {
  return join(appDataDir(), 'sync.lock')
}

/**
 * Take the lock that says a sync is running.
 *
 * The file is created with the exclusive-create flag, so only one process
 * can hold it: the other one is told the lock is taken. A lock older than
 * six hours is stale - the run that took it is long gone - and is taken
 * over, so a crash cannot wedge the schedule forever.
 *
 * The lock is held for the duration of a run, not for the lifetime of the
 * app. A scheduled run therefore still happens while the app is open and
 * idle, and is skipped only when a sync is genuinely in progress.
 */
export async function acquireSyncLock(lockPath: string, now: Date): Promise<boolean> {
  await mkdir(dirname(lockPath), { recursive: true }).catch(() => {
    // The directory may already be there, or it may not be ours to make.
    // Creating the lock file is the real test either way.
  })
  if (await createLockFile(lockPath)) return true

  const info = await stat(lockPath).catch(() => null)
  if (!info) {
    // The lock was given back between the two calls. Try once more.
    return await createLockFile(lockPath)
  }
  // A lock that is exactly this old is taken over. With a schedule of
  // every six hours, a lock left behind by a crashed run would
  // otherwise block the very next slot.
  if (now.getTime() - info.mtimeMs < LOCK_STALE_MS) return false

  // The lock is stale: the run that took it is long gone.
  await rm(lockPath, { force: true })
  return await createLockFile(lockPath)
}

/**
 * Give the lock back.
 *
 * A lock that is not there is not a problem: the run is over either way.
 */
export async function releaseSyncLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true })
}

/** Create the lock file, if it is not already there. */
async function createLockFile(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx')
    await handle.close()
    return true
  } catch {
    // The lock is taken, or it cannot be created at all. Either way this
    // run does not hold it.
    return false
  }
}

/**
 * Write a copy of the manifest to every place the user keeps one.
 *
 * The manifest is the app's memory: without it, every file would look
 * deleted. The first copy sits beside the manifest itself, and the rest
 * are the places the user names - usually a copy on another disk, which
 * is the copy that survives a failure of the app's own disk.
 *
 * Writing a copy is best-effort. A copy that cannot be written is
 * reported, the other copies are still written, and the run carries on:
 * the manifest has already been written where the app reads it, and a
 * mirror is a mirror whether or not its safety net could be refreshed.
 *
 * The copy is written atomically, and it holds the same bytes the store
 * writes - the same version stamp, the same formatting, the same trailing
 * newline. A copy that is half written would be worse than no copy: the
 * act of refreshing the safety net would destroy the previous good one.
 */
export async function writeBackups(
  paths: string[],
  manifest: Manifest,
  log?: (message: string) => void,
): Promise<{ written: string[]; failed: string[] }> {
  const written: string[] = []
  const failed: string[] = []
  if (paths.length === 0) {
    note(log, 'no backup copy is configured, so the manifest has no safety net')
  }
  for (const path of paths) {
    try {
      await mkdir(path, { recursive: true })
      await writeAtomic(join(path, 'manifest.json'), serialiseManifest(manifest))
      written.push(path)
    } catch (err) {
      failed.push(path)
      note(
        log,
        `the backup copy at ${path} could not be written: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  return { written, failed }
}

/**
 * Say what happened, without letting the saying break the run.
 *
 * A logger that cannot be written is not a reason to fail a sync.
 */
function note(log: ((message: string) => void) | undefined, message: string): void {
  try {
    log?.(message)
  } catch {
    // The message is lost, and the run goes on.
  }
}

/**
 * The drive letter of a path, or null when it has none.
 *
 * A UNC path and a path that is not absolute have no drive letter, and
 * guessing one would report the wrong volume - or a volume that is not
 * there at all.
 */
export function driveLetterOf(root: string): string | null {
  const match = /^([a-zA-Z]):/.exec(root)
  return match ? `${match[1]!.toUpperCase()}:` : null
}

/**
 * The volume serial number of a drive letter, or null when it cannot be
 * read.
 *
 * On Windows, `fs.statSync(path).dev` IS the volume serial number, so a
 * change in it means a different physical volume is now mounted at the
 * same letter.
 */
/**
 * The volume a drive letter points at.
 */
function volumeDevOf(driveLetter: string): number | null {
  try {
    return statSync(`${driveLetter}\\`).dev
  } catch {
    return null
  }
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

