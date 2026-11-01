import { useMemo } from 'react'
import type { JSX } from 'react'
import type { AppState, RunSummary } from '../../../main/ipc'
import type { AppSettings } from '../../../main/settings'
import { verdict } from '../../status'
import { Verdict } from './Verdict'
import { FolderList } from './FolderList'
import { LastRun } from './LastRun'
import { EmptyState } from './EmptyState'

interface GuardInfo {
  mirror: string
  reason: string
  message: string
  canOverride: boolean
}

interface ProgressInfo {
  mirror: string
  relPath: string
  phase: string
  done: number
  total: number
}

interface OverviewProps {
  state: AppState | null
  summary: RunSummary | null
  guard: GuardInfo | null
  progress: ProgressInfo | null
  settings: AppSettings | null
  onPrimary?: () => void
  onSecondary?: () => void
  onSync: (name?: string) => void
  onEdit: (name: string) => void
  onViewAll: () => void
  onSetupCredentials?: () => void
  onConnect: () => void
  onChooseAccount: () => void
  onSignIn: () => void
  onAddFolder: () => void
  onPauseResume?: (name: string, enabled: boolean) => void
}

export function Overview({
  state,
  summary,
  guard,
  progress,
  settings,
  onPrimary,
  onSecondary,
  onSync,
  onEdit,
  onViewAll,
  onSetupCredentials,
  onConnect,
  onChooseAccount,
  onSignIn,
  onAddFolder,
  onPauseResume,
}: OverviewProps): JSX.Element {
  const v = useMemo(
    () =>
      verdict({
        settings: settings ?? emptySettings(),
        state: state ?? emptyState(),
        summary,
        guard: guard ?? null,
        progress: progress
          ? { mirror: progress.mirror, done: progress.done, total: progress.total }
          : null,
        relativeTime: undefined,
      }),
    [state, summary, guard, progress, settings],
  )

  const mirrors = state?.mirrors ?? []
  const currentAccount = settings?.currentAccountId

  const handlePrimary = (): void => {
    switch (v.kind) {
      case 'setup':
        if (onSetupCredentials) {
          onSetupCredentials()
        } else {
          onConnect()
        }
        break
      case 'connect':
        onConnect()
        break
      case 'choose':
        onChooseAccount()
        break
      case 'signedout':
        onSignIn()
        break
      case 'empty':
        onAddFolder()
        break
      case 'error':
        onViewAll()
        break
      case 'paused': {
        const pausedMirror = mirrors.find((m) => !m.enabled)
        if (pausedMirror) {
          if (onPauseResume) {
            onPauseResume(pausedMirror.name, true)
          } else {
            onEdit(pausedMirror.name)
          }
        }
        break
      }
      default:
        if (onPrimary) {
          onPrimary()
        } else {
          onSync()
        }
        break
    }
  }

  const handleSecondary =
    v.kind === 'attention' || v.kind === 'error'
      ? () => (onSecondary ? onSecondary() : onSync())
      : undefined

  return (
    <section className="overview">
      <Verdict verdict={v} onPrimary={handlePrimary} onSecondary={handleSecondary} />

      {mirrors.length > 0 && (
        <div className="overview__filters">
          <button type="button" className="filter-tab active">
            All {mirrors.length}
          </button>
          {mirrors.some((m) => m.status === 'skipped' || m.status === 'attention' || m.counts.errors > 0) && (
            <button type="button" className="filter-tab">
              Needs you
            </button>
          )}
          {mirrors.some((m) => !m.enabled) && (
            <button type="button" className="filter-tab">Paused</button>
          )}
          <button type="button" className="button button--sage filter-tab__add" onClick={onAddFolder}>
            + Add folder
          </button>
        </div>
      )}

      <section className="overview__list">
        {emptyKind() ? (
          <EmptyState
            kind={emptyKind()!}
            onSetupCredentials={onSetupCredentials}
            onConnect={onConnect}
            onChooseAccount={onChooseAccount}
            onAddFolder={onAddFolder}
            onSignIn={onSignIn}
            onSync={() => onSync()}
          />
        ) : (
          <FolderList
            mirrors={mirrors}
            onSync={onSync}
            onEdit={onEdit}
            onPauseResume={onPauseResume}
          />
        )}
      </section>

      <LastRun summary={summary} onViewAll={onViewAll} />
    </section>
  )

  function emptyKind():
    | 'no-credentials'
    | 'no-accounts'
    | 'no-account-on-screen'
    | 'no-folders'
    | 'no-run'
    | 'first-backup'
    | 'signed-out'
    | null {
    if (!settings?.clientId || !settings?.clientSecretSet) return 'no-credentials'
    if ((settings?.accounts.length ?? 0) === 0) return 'no-accounts'
    if (currentAccount === null) return 'no-account-on-screen'
    if (mirrors.length === 0) return 'no-folders'
    if (state?.needsAuth) return 'signed-out'
    if (!summary && !mirrors.some((m) => m.lastSyncedAt)) return 'first-backup'
    if (!summary) return 'no-run'
    return null
  }
}

function emptySettings(): AppSettings {
  return {
    clientId: '',
    accounts: [],
    currentAccountId: null,
    clientSecretSet: false,
    guardThreshold: 5,
    startWithWindows: false,
    extraBackupPath: null,
    pendingNotice: null,
    autoCheckUpdates: true,
    autoDownloadUpdates: true,
  }
}

function emptyState(): AppState {
  return {
    accountId: '',
    mirrors: [],
    running: false,
    phase: 'idle',
    lastRun: null,
    accountEmail: null,
    needsAuth: false,
  }
}
