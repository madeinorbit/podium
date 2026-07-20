import type { IssueGitState } from '@podium/protocol'
import { GitBranch } from 'lucide-react'
import type { JSX } from 'react'
import { deriveGitStamp } from './git-stamp'

/**
 * The git stamp [POD-98]: has this task committed, and on which branch?
 * One grammar in three densities — `chip` (pane header), `stamp` (sidebar
 * line-2), `footer` (tray card). Pure state logic lives in git-stamp.ts.
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
  density: 'chip' | 'stamp' | 'footer'
  /** Chip densities are the click-through to the RightDock Git tab. */
  onClick?: () => void
  className?: string
}): JSX.Element | null {
  const m = deriveGitStamp(issueBranch, git)
  if (m.kind === 'hidden') return null

  const showBranch = density !== 'stamp' && m.branch !== null

  if (m.kind === 'loading') {
    // First probe in flight: shimmer skeleton in the same footprint so the
    // header doesn't jump when the real stamp lands.
    return (
      <span
        data-testid="git-stamp-loading"
        title={m.title}
        className={`inline-flex animate-pulse items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/60 ${
          density === 'chip' ? 'rounded-[6px] border border-border bg-secondary/40 px-2 py-1' : ''
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
          {density !== 'stamp' && ` ${m.dirtyLabel}`}
        </span>
      )}
      {m.unpushed && <span className="text-warning">⇡</span>}
      {m.note && density !== 'stamp' && <span className="text-muted-foreground/70">{m.note}</span>}
    </>
  )

  const body = (
    <>
      {density !== 'stamp' && (
        <GitBranch size={11} aria-hidden="true" className="text-muted-foreground/70" />
      )}
      {showBranch && (
        <span
          className={`max-w-[16ch] truncate ${m.mismatch ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}
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
        className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-border bg-secondary/40 px-2 py-1 font-mono text-[10.5px] leading-none transition-colors hover:border-border-strong ${className}`}
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
        density === 'footer' ? 'text-[10px]' : 'text-[10.5px]'
      } leading-none ${className}`}
    >
      {body}
    </span>
  )
}
