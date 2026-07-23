import type { IssueGitState } from '@podium/protocol'
import { GitBranch } from 'lucide-react'
import type { JSX } from 'react'
import { deriveGitStamp } from './git-stamp'

/**
 * The git stamp [POD-98]: has this task committed, and on which branch?
 * One grammar in four densities — `chip` (pane header), `stamp` (sidebar
 * line-2), `footer` (tray card), `panel` (Git dock header [POD-114]: larger
 * type, full branch name — never truncated). Pure state logic lives in
 * git-stamp.ts.
 */
export function GitStamp({
  issueBranch,
  git,
  density,
  onClick,
  className = '',
}: {
  issueBranch: string | null | undefined
  git: IssueGitState | null | undefined
  density: 'chip' | 'stamp' | 'footer' | 'panel'
  /** Chip densities are the click-through to the RightDock Git tab. */
  onClick?: () => void
  className?: string
}): JSX.Element | null {
  const m = deriveGitStamp(issueBranch, git)
  if (m.kind === 'hidden') return null

  // Sidebar rows are for decisions, not a miniature git dashboard. Clean/no-op
  // states stay silent; actionable exceptions use short copy instead of another
  // positional dot or expert-only arrow glyph (POD-236).
  if (density === 'stamp') {
    if (m.kind !== 'ready') return null
    const hasAction = m.mismatch || m.dirty !== undefined || m.ahead !== undefined
    if (!hasAction) return null
    return (
      <span
        data-testid="git-stamp"
        data-density="stamp"
        title={m.title}
        className={`inline-flex flex-none items-center gap-1 rounded-[4px] border px-1 font-mono text-[9px] leading-[13px] ${
          m.mismatch
            ? 'border-destructive/40 bg-destructive/10 text-destructive'
            : 'border-warning/35 bg-warning/10 text-warning'
        } ${className}`}
      >
        {m.mismatch && <span>Wrong branch</span>}
        {m.dirty !== undefined && <span>{m.dirty} uncommitted</span>}
        {m.ahead !== undefined && (
          <span>
            {m.ahead} commit{m.ahead === 1 ? '' : 's'} ahead
          </span>
        )}
      </span>
    )
  }

  const showBranch = m.branch !== null

  if (m.kind === 'loading') {
    // First probe in flight: shimmer skeleton in the same footprint so the
    // header doesn't jump when the real stamp lands.
    return (
      <span
        data-testid="git-stamp-loading"
        title={m.title}
        className={`inline-flex animate-pulse items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/60 ${
          density === 'chip'
            ? 'rounded-[6px] border issue-hairline-35 bg-background/50 px-2 py-1'
            : ''
        } ${className}`}
      >
        <GitBranch size={11} aria-hidden="true" />
        {showBranch && <span className="max-w-[16ch] truncate">{m.branch}</span>}
        <span className="size-[7px] rounded-full border border-dashed border-current" />
      </span>
    )
  }

  const dot = (
    <span
      data-testid={`git-stamp-dot-${m.dot}`}
      className={`size-[7px] flex-none rounded-full ${m.refreshing ? 'animate-pulse' : ''}`}
      style={
        m.dot === 'clean'
          ? { background: 'var(--live)', border: '1px solid var(--live)' }
          : m.dot === 'dirty'
            ? {
                border: '1px solid var(--warning)',
                background: 'linear-gradient(90deg, var(--warning) 50%, transparent 50%)',
              }
            : { border: '1px dashed var(--muted-foreground)' }
      }
      aria-hidden="true"
    />
  )

  const counters = (
    <>
      {m.merged && <span className="text-info">✓ merged</span>}
      {m.ahead !== undefined && <span className="font-semibold text-live">↑{m.ahead}</span>}
      {m.commits !== undefined && (
        <span className="font-semibold text-live">
          ✓ {m.commits} commit{m.commits === 1 ? '' : 's'}
        </span>
      )}
      {m.dirty !== undefined && (
        <span className="text-warning">
          +{m.dirty}
          {` ${m.dirtyLabel}`}
        </span>
      )}
      {m.unpushed && <span className="text-warning">⇡</span>}
      {m.note && <span className="text-muted-foreground/70">{m.note}</span>}
    </>
  )

  const body = (
    <>
      <GitBranch
        size={density === 'panel' ? 13 : 11}
        aria-hidden="true"
        className="flex-none text-muted-foreground/70"
      />
      {showBranch && (
        <span
          className={`${
            density === 'panel' ? 'break-all font-semibold' : 'max-w-[16ch] truncate'
          } ${m.mismatch ? 'font-semibold text-destructive' : density === 'panel' ? 'text-secondary-foreground' : 'text-muted-foreground'}`}
        >
          {m.branch}
        </span>
      )}
      {dot}
      {counters}
    </>
  )

  if (density === 'chip') {
    return (
      <button
        type="button"
        data-testid="git-stamp"
        data-density="chip"
        title={`${m.title} — open Git panel`}
        onClick={onClick}
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] border issue-hairline-35 bg-background/50 px-2 py-1 font-mono text-[10.5px] leading-none transition-colors hover:issue-hairline-60 ${className}`}
      >
        {body}
      </button>
    )
  }
  return (
    <span
      data-testid="git-stamp"
      data-density={density}
      title={m.title}
      className={`inline-flex items-center gap-1.5 font-mono ${
        density === 'footer'
          ? 'text-[10px]'
          : density === 'panel'
            ? 'flex-wrap text-[12.5px] leading-[1.35]'
            : 'text-[10.5px]'
      } ${density === 'panel' ? '' : 'leading-none'} ${className}`}
    >
      {body}
    </span>
  )
}
