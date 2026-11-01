import type { AppState, MirrorCard, RunSummary } from '../main/ipc'
import type { AppSettings } from '../main/settings'

export type VerdictKind =
  | 'setup'
  | 'connect'
  | 'choose'
  | 'signedout'
  | 'syncing'
  | 'waiting'
  | 'empty'
  | 'paused'
  | 'attention'
  | 'error'
  | 'first'
  | 'lastchecked'
  | 'safe'

export type Dot = 'safe' | 'attention' | 'danger' | 'sage' | 'muted' | 'signedout' | 'neutral'

export interface Counts {
  uploaded: number
  updated: number
  downloaded: number
  trashed: number
  errors: number
}

export interface Verdict {
  kind: VerdictKind
  sentence: string
  subline: string
  action: string
  dot: Dot
  counts: Counts
  files: number
}

export type RowStatus = 'paused' | 'syncing' | 'needs-you' | 'error' | 'not-synced' | 'up-to-date'

export interface StatusInput {
  settings: AppSettings
  state: AppState
  summary: RunSummary | null
  guard: { mirror: string; reason: string; message: string; canOverride: boolean } | null
  progress?: { mirror: string; done: number; total: number } | null
  relativeTime?: (iso: string) => string
}

export function verdict(input: StatusInput): Verdict {
  const { settings, state, summary, guard, progress, relativeTime } = input
  const rtFn = relativeTime ?? ((iso: string) => iso)

  const mirrors = state.mirrors
  const files = mirrors.reduce((n, m) => n + (m.fileCount ?? 0), 0)
  const run = summary ?? state.lastRun
  const counts: Counts = run
    ? { uploaded: run.uploaded, updated: run.updated, downloaded: run.downloaded, trashed: run.trashed, errors: run.errors }
    : { uploaded: 0, updated: 0, downloaded: 0, trashed: 0, errors: 0 }

  const allPaused = mirrors.length > 0 && mirrors.every((m) => !m.enabled)
  const anySkipped = mirrors.some((m) => m.status === 'skipped' || m.status === 'attention')
  const anyErrorStatus = mirrors.some((m) => m.status === 'error')
  const anyBlocked = mirrors.some((m) => m.recovered.some((r) => !!r.blocked))
  const hasGuard = !!guard
  const hasRunErrors = !!run && run.errors > 0
  const hasCountsErrors = mirrors.some((m) => m.counts.errors > 0)
  const everSynced = mirrors.some((m) => m.lastSyncedAt !== null)
  const latestSynced = mirrors.reduce((max: string | null, m) => {
    if (!m.lastSyncedAt) return max
    if (!max) return m.lastSyncedAt
    return m.lastSyncedAt > max ? m.lastSyncedAt : max
  }, null as string | null)

  // 1. Credentials missing / incomplete
  if (!settings.clientId || !settings.clientSecretSet) {
    return { kind: 'setup', sentence: 'Finish setting up Google.', subline: 'The app needs your own Google client id and secret.', action: 'Finish setup', dot: 'danger', counts, files }
  }
  // 2. No accounts configured
  if (!settings.accounts || settings.accounts.length === 0) {
    return { kind: 'connect', sentence: 'Connect your Google account.', subline: 'The app needs an account before it can back anything up.', action: 'Connect account', dot: 'sage', counts, files }
  }
  // 3. Accounts exist, none current
  if (settings.currentAccountId === null) {
    return { kind: 'choose', sentence: 'Choose an account.', subline: 'Pick an account to see its folders, or connect a new one.', action: 'Choose account', dot: 'neutral', counts, files }
  }
  // 4. Signed out
  if (state.needsAuth) {
    return { kind: 'signedout', sentence: 'This account is signed out.', subline: 'Sign in to resume. Your folders and history are safe.', action: 'Sign in', dot: 'danger', counts, files }
  }
  // 5. Syncing
  if (state.running && state.phase !== 'waiting') {
    const subline = progress && progress.total > 0
      ? `${progress.mirror} · uploading ${progress.done} of ${progress.total} files`
      : 'Backing up now.'
    return { kind: 'syncing', sentence: 'Backing up now.', subline, action: 'Syncing…', dot: 'sage', counts, files }
  }
  // 6. Waiting
  if (state.phase === 'waiting') {
    return { kind: 'waiting', sentence: 'Waiting for the other account.', subline: 'Another account is syncing. This one starts when it finishes.', action: 'Waiting…', dot: 'sage', counts, files }
  }
  // 7. No mirrors
  if (mirrors.length === 0) {
    return { kind: 'empty', sentence: 'Nothing is mirrored yet.', subline: 'Add a folder to start backing it up.', action: 'Add a folder', dot: 'muted', counts, files }
  }
  // 8. All paused
  if (allPaused) {
    return { kind: 'paused', sentence: 'Everything is paused.', subline: 'No folder will sync until you resume one.', action: 'Review paused', dot: 'muted', counts, files }
  }
  // 9. Attention (guard / blocked / skipped)
  if (hasGuard || anyBlocked || anySkipped) {
    const needsYouMirrors = mirrors.filter((m) => m.status === 'skipped' || m.status === 'attention' || m.recovered.some((r) => !!r.blocked))
    const n = Math.max(1, needsYouMirrors.length)
    const reason = guard?.message ?? 'A folder needs your attention.'
    const other = Math.max(0, mirrors.length - n)
    const subline = other > 0
      ? `${reason} The other ${other} folder${other === 1 ? '' : 's'} are backed up.`
      : reason
    const sentence = `${n} folder${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you.`
    return { kind: 'attention', sentence, subline, action: 'Review', dot: 'attention', counts, files }
  }
  // 10. Error (status error or counts errors or last run errors)
  if (anyErrorStatus || hasCountsErrors || hasRunErrors) {
    const errFiles = run?.errors ?? mirrors.reduce((n, m) => n + m.counts.errors, 0)
    const erroredMirrors = mirrors.filter((m) => m.status === 'error' || m.counts.errors > 0).length || 1
    const other = Math.max(0, mirrors.length - erroredMirrors)
    const subline = other > 0
      ? `${errFiles} files could not be uploaded. The other ${other} folder${other === 1 ? '' : 's'} are backed up.`
      : `${errFiles} files could not be uploaded.`
    return { kind: 'error', sentence: 'The last backup hit a problem.', subline, action: 'View details', dot: 'danger', counts, files }
  }
  // 11. First backup: no last run, never synced
  if (!run && !everSynced) {
    return { kind: 'first', sentence: 'Ready for the first backup.', subline: 'Your folders are set up. The first sync will copy them to Drive.', action: 'Sync now', dot: 'sage', counts, files }
  }
  // 12. Last checked (migration): no last run, but some synced before
  if (!run && everSynced) {
    const when = latestSynced ? rtFn(latestSynced) : ''
    return { kind: 'lastchecked', sentence: `Last checked ${when}.`, subline: 'The app has not run since it was updated. These times come from each folder\'s record.', action: 'Sync now', dot: 'sage', counts, files }
  }
  // 13. Safe
  const when = latestSynced ? rtFn(latestSynced) : (run ? rtFn(run.finishedAt) : '')
  const folderWord = mirrors.length === 1 ? 'folder' : 'folders'
  const subline = `Last checked ${when} · ${mirrors.length} ${folderWord}, ${files.toLocaleString('en-US')} files.`
  return { kind: 'safe', sentence: 'Everything is backed up.', subline, action: 'Sync now', dot: 'safe', counts, files }
}

export function rowStatus(card: MirrorCard): RowStatus {
  if (!card.enabled) return 'paused'
  if (card.status === 'syncing') return 'syncing'
  if (card.status === 'skipped' || card.status === 'attention') return 'needs-you'
  if (card.status === 'error' || card.counts.errors > 0) return 'error'
  if (card.lastSyncedAt === null) return 'not-synced'
  return 'up-to-date'
}

export function folderNeedsYou(card: MirrorCard): boolean {
  if (card.status === 'skipped' || card.status === 'attention') return true
  if (card.status === 'error' || card.counts.errors > 0) return true
  if (card.recovered.some((r) => !!r.blocked)) return true
  return false
}
