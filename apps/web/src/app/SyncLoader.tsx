import type { JSX } from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import logoUrl from '@/lib/icons/podium-logo.svg'
import type { SyncProgressSnapshot, SyncProgressStore } from '@/lib/sync-progress'

/**
 * THE FIRST-SYNC SCREEN (POD-1249, design: "Podium App Loader").
 *
 * Shown instead of the ASCII splash when this launch opened a COLD replica —
 * the one boot where the wait is real work (the whole world downloads and
 * installs) rather than a beat of housekeeping. Everything rendered here is a
 * measured number from `SyncProgressStore` or the engine's repo enrichment;
 * denominators appear only when the server stamped them on the bootstrap
 * frames, and the "saving" step is indeterminate on purpose — the install is
 * one opaque IndexedDB transaction, and a fabricated percentage is the one
 * thing this screen must never show (operation-view rule).
 */

/** The wordmark 'P', traced from the app icon (design handoff). */
const P_PATH =
  'M366.5 237.84C382.17 237.71 397.83 237.84 413.5 237.78C425.68 237.74 439.18 238.04 448.67 246.85C460.33 257.68 459.8 274.99 458.13 289.5C455.82 309.57 451.8 329.66 448.22 349.54C444.43 370.55 440.9 393.5 423.35 407.89C414.65 415.02 403.67 419.09 392.5 419.97C382.97 420.71 372.86 419.07 363.5 420.64C355.77 457.07 348.03 493.51 340.3 529.94C325.83 529.94 311.37 529.94 296.9 529.94C320.1 432.57 343.3 335.21 366.5 237.84ZM394.5 273.09C386.93 309.23 379.35 345.36 371.78 381.5C374.8 382.45 377.72 382.46 380.97 382.5C384.65 382.54 388.56 382.49 392.13 381.56C405.6 378.03 406.84 360.73 409.13 349.53C411.59 337.55 413.67 325.5 416.04 313.5C417.79 304.62 423.82 285.42 418.98 277.55C414.65 270.5 401.34 272.07 394.5 273.09Z'

/**
 * The bisque letter [POD-1427]. Flat, not the stone ramp the 9a tile used — the
 * hero tile is the app icon reproduced in SVG, so it tracks
 * apps/web/public/icon.svg rather than carrying a palette of its own.
 */
const LETTER = '#f5eddd'

/** Shared paint definitions for the hero tile and the ledger's charge glyph. */
function SyncDefs(): JSX.Element {
  return (
    <svg width="0" height="0" className="sync-loader-defs" aria-hidden="true">
      <defs>
        <linearGradient id="podsync-ground" x1="12" y1="4" x2="90" y2="98" gradientUnits="userSpaceOnUse">
          <stop stopColor="#232019" />
          <stop offset="1" stopColor="#0b0a08" />
        </linearGradient>
        <linearGradient id="podsync-charge" x1="0" y1="0" x2="0" y2="106" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffe0a8" />
          <stop offset=".08" stopColor="var(--sync-acc, #d9b477)" />
          <stop offset="1" stopColor="var(--sync-acc, #d9b477)" stopOpacity=".72" />
        </linearGradient>
        <clipPath id="podsync-tile">
          <rect width="100" height="100" rx="22" />
        </clipPath>
        <mask id="podsync-letter" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <path
            transform="translate(50 50) scale(.285) translate(-378.45 -383.85)"
            fill="#fff"
            d={P_PATH}
          />
        </mask>
      </defs>
    </svg>
  )
}

/** The app-icon tile with the accent tide lapping behind the stone 'P'. Dark in
 *  both themes on purpose — it is the app icon, not a themed surface. */
function HeroTile(): JSX.Element {
  return (
    <svg viewBox="0 0 100 100" width="84" height="84" aria-hidden="true">
      <g clipPath="url(#podsync-tile)">
        <rect width="100" height="100" fill="url(#podsync-ground)" />
        <polygon
          className="sync-loader-tide-b"
          points="-24,96 124,72 124,150 -24,150"
          opacity=".4"
          fill="var(--sync-acc, #d9b477)"
        />
        <polygon
          className="sync-loader-tide-a"
          points="-24,92 124,70 124,150 -24,150"
          fill="var(--sync-acc, #d9b477)"
        />
        <path
          transform="translate(50 46) scale(.235) translate(-378.45 -383.85)"
          fill={LETTER}
          d={P_PATH}
        />
      </g>
      <rect width="100" height="100" rx="22" fill="none" stroke="rgba(255,255,255,.08)" />
    </svg>
  )
}

/** The 'P' filling with accent — the ledger's "in progress" glyph. */
function ChargeGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 100 100" width="14" height="14" className="sync-loader-row-icon" aria-hidden="true">
      <g mask="url(#podsync-letter)">
        <rect width="100" height="100" fill="var(--sync-glyph-well)" />
        <rect className="sync-loader-charge-fill" width="100" height="106" fill="url(#podsync-charge)" />
      </g>
    </svg>
  )
}

type RowState = 'done' | 'active' | 'queued'

function LedgerRow({
  state,
  label,
  value,
}: {
  state: RowState
  label: string
  value: string
}): JSX.Element {
  return (
    <div className="sync-loader-row" data-state={state}>
      {state === 'active' ? (
        <ChargeGlyph />
      ) : (
        <span className="sync-loader-row-icon">{state === 'done' ? '✓' : '–'}</span>
      )}
      <span className="sync-loader-row-label">{label}</span>
      <span className="sync-loader-row-value">{value}</span>
    </div>
  )
}

const count = (n: number): string => n.toLocaleString('en-US')

/** "n / total" while arriving, plain totals when landed, 'queued' before. */
function entityRow(
  snapshot: SyncProgressSnapshot,
  entity: 'issue' | 'session',
): { state: RowState; value: string } {
  const seen = snapshot.seenByEntity[entity] ?? 0
  const total = snapshot.totalsByEntity?.[entity] ?? null
  if (snapshot.phase === 'connecting') return { state: 'queued', value: 'queued' }
  if (snapshot.phase === 'downloading') {
    return {
      state: 'active',
      value: total === null ? count(seen) : `${count(seen)} / ${count(total)}`,
    }
  }
  return { state: 'done', value: count(total ?? seen) }
}

export interface SyncLoaderProps {
  readonly store: SyncProgressStore
  /** The enrichment axis: repos/worktrees arrive over tRPC, not the feed. */
  readonly reposLoaded: boolean
  readonly repoCount: number
  readonly worktreeCount: number
}

export function SyncLoader({
  store,
  reposLoaded,
  repoCount,
  worktreeCount,
}: SyncLoaderProps): JSX.Element {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  useEffect(() => {
    const tick = (): void =>
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - snapshot.startedAt) / 1000)))
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [snapshot.startedAt])

  const issuesSeen = snapshot.seenByEntity.issue ?? 0
  const issuesTotal = snapshot.totalsByEntity?.issue ?? null
  const pct =
    snapshot.totalRows !== null && snapshot.totalRows > 0
      ? Math.min(100, Math.round((snapshot.rowsSeen / snapshot.totalRows) * 100))
      : null

  const headline =
    snapshot.phase === 'connecting' ? (
      <span>connecting…</span>
    ) : issuesTotal === null ? (
      <span>
        <span className="sync-loader-meta-strong">{count(issuesSeen)}</span> issues
      </span>
    ) : (
      <span>
        <span className="sync-loader-meta-strong">{count(issuesSeen)}</span> of{' '}
        {count(issuesTotal)} issues
      </span>
    )
  const metaRight =
    snapshot.phase === 'saving'
      ? 'saving…'
      : snapshot.phase === 'ready'
        ? '100%'
        : pct === null
          ? ''
          : `${pct}%`
  const barDone = snapshot.phase === 'saving' || snapshot.phase === 'ready'
  const indeterminate = pct === null && snapshot.phase === 'downloading'

  const issues = entityRow(snapshot, 'issue')
  const sessions = entityRow(snapshot, 'session')
  const clock = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`

  return (
    <div className="sync-loading" role="status" aria-live="polite">
      <SyncDefs />
      <div className="sync-loader">
        <HeroTile />
        <span
          className="sync-loader-wordmark"
          style={{
            WebkitMaskImage: `url(${logoUrl})`,
            maskImage: `url(${logoUrl})`,
          }}
        />
        <div className="sync-loader-subtitle">Syncing your workspace</div>

        <div className="sync-loader-meta">
          {headline}
          <span className="sync-loader-meta-pct">{metaRight}</span>
        </div>
        <div className="sync-loader-track">
          <div
            className="sync-loader-fill"
            data-indeterminate={indeterminate || undefined}
            style={indeterminate ? undefined : { width: `${barDone ? 100 : (pct ?? 0)}%` }}
          />
        </div>

        <div className="sync-loader-ledger">
          <LedgerRow
            state={reposLoaded ? 'done' : 'active'}
            label="Repositories"
            value={reposLoaded ? count(repoCount) : 'loading'}
          />
          <LedgerRow state={issues.state} label="Issues and tasks" value={issues.value} />
          <LedgerRow state={sessions.state} label="Agent sessions" value={sessions.value} />
          <LedgerRow
            state={reposLoaded ? 'done' : 'queued'}
            label="Worktrees"
            value={reposLoaded ? count(worktreeCount) : 'queued'}
          />
        </div>

        <div className="sync-loader-foot">
          <span className="sync-loader-foot-clock">{clock}</span>
          <span>·</span>
          <span>first sync on this machine — later launches read the local cache</span>
        </div>
      </div>
      <span className="sr-only">Syncing your workspace for the first time…</span>
    </div>
  )
}
