import type { IssueId, MachineId } from '@podium/model'
import { asIssueId, machinePathBasename } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { ListTree } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { IssuePanelView } from '../IssuePanelView'
import { IssueViewsContext, useIssueViews } from '../issue-page/opening-context'
import { useIssueExplorer } from './explorer-context'
import { crumbTrail } from './explorer-nav'
import { useExplorerCrumbs } from './explorer-pool-data'
import { IssueExplorerList } from './IssueExplorerList'
import { ExplorerViewsContext, useExplorerViews } from './opening-context'

/** How long a level takes to come in. Matches the shell's one-shot morph band
 *  (150–400ms) — structural motion, not a status signal. */
const MOVE_MS = 260

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

interface Frame {
  key: number
  id: IssueId | null
  move: 'push' | 'pop' | null
  leaving?: boolean
}

/**
 * The right dock's task surface: a navigable explorer over every task in the
 * repo, replacing the inspector that could only ever show the mission already
 * on screen (POD-743).
 *
 * Level 0 is the searchable list; every level above it is one task's detail.
 * Going deeper slides in from the right and going back slides it off again, so
 * the trail has a direction the operator can feel and the breadcrumb is a
 * readout of a movement rather than the only evidence one happened.
 */
export function IssueExplorer({
  cwd,
  machineId,
}: {
  cwd: string
  machineId?: MachineId
}): JSX.Element {
  const views = useIssueViews()
  const explorer = useExplorerViews()
  return (
    <IssueViewsContext.Provider value={views}>
      <ExplorerViewsContext.Provider value={explorer}>
        <IssueExplorerBody cwd={cwd} machineId={machineId} />
      </ExplorerViewsContext.Provider>
    </IssueViewsContext.Provider>
  )
}

function IssueExplorerBody({
  cwd,
  machineId,
}: {
  /** The active worktree — artifacts of a task with no checkout of its own are
   *  served from it, exactly as the old panel did. */
  cwd: string
  machineId?: MachineId
}): JSX.Element {
  const { current, seq, motion, push } = useIssueExplorer()
  const [frames, setFrames] = useState<Frame[]>([
    { key: seq, id: current === null ? null : asIssueId(current), move: null },
  ])
  const lastSeq = useRef(seq)

  useEffect(() => {
    if (seq === lastSeq.current) return
    lastSeq.current = seq
    const next: Frame = { key: seq, id: current === null ? null : asIssueId(current), move: motion }
    // A silent retarget has no gesture behind it and gets no transition: a
    // panel that slides every time another column is clicked is a panel that
    // is always moving.
    if (!motion || prefersReducedMotion()) {
      setFrames([next])
      return
    }
    setFrames((prev) => {
      const outgoing = prev[prev.length - 1]
      return outgoing ? [{ ...outgoing, move: motion, leaving: true }, next] : [next]
    })
    const timer = setTimeout(() => setFrames([next]), MOVE_MS)
    return () => clearTimeout(timer)
  }, [seq, current, motion])

  // A level whose task is gone goes home — but that rule belongs to the pointer,
  // not to this view, so it lives in the provider, where it also runs while the
  // dock is shut (POD-1471). Nothing to do here: this component renders whatever
  // the pointer currently says, and the pointer retires its own dead levels.

  return (
    <div className="explorer-stack" data-testid="issue-explorer">
      {frames.map((frame) => (
        <div
          key={frame.key}
          className="explorer-level"
          data-move={frame.move ? `${frame.move}-${frame.leaving ? 'out' : 'in'}` : undefined}
          // The level on its way out is scenery for 260ms: no tab stops into
          // it, and nothing in it announced.
          aria-hidden={frame.leaving || undefined}
          inert={frame.leaving || undefined}
        >
          {frame.id ? (
            <IssuePanelView cwd={cwd} machineId={machineId} issueId={frame.id} onNavigate={push} />
          ) : (
            <IssueExplorerList />
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * The trail, rendered in the dock's title bar.
 *
 * It sits there rather than above the panel body because the bar is every
 * panel's one header (POD-516 item 10) — and on this panel what the header has
 * to say is not a name but a position. The task's own name is the subject line
 * inside the detail, where it can wrap.
 */
export function IssueExplorerCrumbs(): JSX.Element {
  const { stack, popTo } = useIssueExplorer()
  const trail = crumbTrail(stack)
  const issues = useExplorerCrumbs(
    trail.flatMap((crumb) => (crumb.kind === 'issue' ? [crumb.id] : [])),
  )
  // The root reads as the PROJECT once a task is open (POD-2077: "Pipp /
  // PIPP-150"): level 0 is every task in that repo, so its name is the honest
  // label for the step back. With no task open it stays "Tasks".
  const project = issues[0]?.repoPath ? machinePathBasename(issues[0].repoPath) : ''
  return (
    <nav
      className="flex min-w-0 flex-1 items-center gap-px"
      aria-label="Explorer trail"
      data-testid="explorer-crumbs"
    >
      {trail.map((crumb, index) => {
        const last = index === trail.length - 1
        const sep = index > 0 && (
          <span
            className="flex-none px-0.5 font-mono text-[11px] text-text-faint/70"
            aria-hidden="true"
          >
            /
          </span>
        )
        if (crumb.kind === 'gap') {
          return (
            <span key="gap" className="contents">
              {sep}
              <span className="px-1 font-mono text-[10.5px] text-text-faint" aria-hidden="true">
                …
              </span>
            </span>
          )
        }
        const issue = crumb.kind === 'issue' ? issues.find((i) => i.id === crumb.id) : undefined
        const label =
          crumb.kind === 'root' ? project || 'Tasks' : issue ? issueDisplayRef(issue) : crumb.id
        return (
          <span key={crumb.kind === 'root' ? 'root' : crumb.id} className="contents">
            {sep}
            <button
              data-pressable
              type="button"
              disabled={last}
              aria-current={last ? 'page' : undefined}
              aria-label={
                crumb.kind === 'root' ? `All tasks${project ? ` in ${project}` : ''}` : undefined
              }
              title={
                crumb.kind === 'root'
                  ? 'All tasks'
                  : issue
                    ? `${issue.title}${issue.archived ? ' · archived' : ''}`
                    : undefined
              }
              onClick={() => popTo(crumb.depth)}
              className={cn(
                'flex h-6 min-w-0 flex-none items-center gap-1.5 rounded-md px-1 font-mono text-[11px] whitespace-nowrap',
                last
                  ? 'text-muted-foreground'
                  : 'text-text-dim hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {crumb.kind === 'root' && !project && <ListTree size={12} aria-hidden="true" />}
              {label}
              {issue?.archived ? ' · archived' : ''}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
