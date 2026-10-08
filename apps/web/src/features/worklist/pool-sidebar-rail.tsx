import { sidebarView } from '@podium/client-graph/worklist/sidebar'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/shallow-equal'
import { agentBadge, type MotionPhase, mostUrgentSession, STALE_INACTIVE_MS } from '@podium/client-core/values'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { compareStructural, computed, observer, WorklistProvider, useWorklistModel } from '@podium/client-graph/react'
import { motionPhase } from '@podium/client-graph/worklist/rollup'
import type { SidebarWorktree } from '@podium/client-graph/worklist/sidebar'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'
import { machinePathBasename, machinePathsEqual } from '@podium/model/browser'

import { FolderPlus, GitBranch, Plus, Search } from 'lucide-react'
import { Fragment, type JSX, useEffect, useMemo, useState } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { useRuntimeSelector } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { IdSquare, idSquareLabel } from '@/components/IdSquare'
import { useFeature } from '@/lib/use-feature'
import { useNewTask } from './new-task'
import { navigationIssue, worklistIssueStatus } from './pool-row-data'
import { usePoolLayoutState } from './pool-sidebar'
import { RowShortcutBadge } from './RowShortcutBadge'
import { RailProgressMeter } from './row-progress'
import { MAX_ROW_SHORTCUTS, useRowShortcuts } from './row-shortcuts'
import { RailHoverCard, RailSpine, railBadge } from './SidebarRail'
import { type PoolWorkActions, usePoolUnifiedWork } from './use-pool-unified-work'

export function PoolSidebarRail(): JSX.Element | null {
  const pool = useWorklistPool()
  return pool ? <WorklistProvider model={worklistView(pool)}><PoolRail pool={pool} /></WorklistProvider> : null
}

/** The rail's waiting pick shows no time: read the clock untracked and pair it
 * with the exact per-seat rank deadlines, so a minute tick wakes the tile only
 * when the pick can change. Snooze expiry flips `isSnoozed` at `until`
 * (`reached`); the 16 h stale line flips recency past `lastActiveAt + 16 h`
 * (`passed`). Anything else that moves the pick is a row-field change, tracked
 * through the session rows themselves. */
export function railWaitingNow(pool: MobxPool, waiting: readonly SessionView[]): number {
  const now = pool.clock.peekNow()
  for (const seat of waiting) {
    if (typeof seat.snoozedUntil === 'string') {
      const until = Date.parse(seat.snoozedUntil)
      if (Number.isFinite(until)) pool.clock.reached(until)
    }
    const active = Date.parse(seat.lastActiveAt)
    if (Number.isFinite(active)) pool.clock.passed(active + STALE_INACTIVE_MS)
  }
  return now
}

const PoolRail = observer(function PoolRail({ pool }: { pool: MobxPool }): JSX.Element {
  const layout = usePoolLayoutState()
  const model = useWorklistModel()!
  useEffect(() => model.setLayout(layout), [model, layout])
  const sections = model.sections(layout)
  const actions = usePoolUnifiedWork(pool)
  const { startNewTask } = useNewTask({ bindChord: true })
  const setPaletteOpen = useRuntimeSelector((s) => s.setPaletteOpen)
  const commandPaletteEnabled = useFeature('command-palette')
  const [hover, setHover] = useState<{ key: string; anchor: DOMRect } | null>(null)
  const bands = [
    ...(sections.pinnedIds.length
      ? [
          {
            key: 'pinned',
            label: 'Pinned',
            issues: sections.pinnedIds,
            worktrees: [] as readonly string[],
          },
        ]
      : []),
    ...sections.bands.map((band) => ({
      key: band.key,
      label: band.label,
      issues: band.rowIds,
      worktrees: band.worktreeIds,
    })),
  ].filter((band) => band.issues.length || band.worktrees.length)
  const ids = bands.flatMap((band) => band.issues).slice(0, MAX_ROW_SHORTCUTS)
  const { numbers } = useRowShortcuts(
    ids.map((id) => ({ id, activate: () => actions.selectIssue(id) })),
  )
  return (
    <>
      <div className="flex flex-none flex-col items-center px-0 pt-[11px] pb-[10px]">
        <button
          data-pressable
          type="button"
          data-testid="rail-new-task"
          className="flex size-[34px] flex-none cursor-pointer items-center justify-center rounded-[9px] border border-border-strong bg-chip text-text-dim transition-colors hover:border-text-faint hover:bg-accent hover:text-foreground"
          title="New task"
          aria-label="New task"
          onClick={() => startNewTask()}
        >
          <Plus size={17} aria-hidden="true" className="flex-none" />
        </button>
      </div>
      <div
        data-testid="sidebar-rail"
        className="scroll-none flex min-h-0 w-full flex-1 flex-col items-center gap-[8px] overflow-y-auto pt-[8px] pb-[10px]"
        onScroll={() => setHover(null)}
      >
        {bands.map((band) => (
          <Fragment key={band.key}>
            <span
              data-testid="rail-group-label"
              className="label-mono mt-[8px] mb-[4px] w-full flex-none truncate px-[6px] text-center first:mt-0"
              style={{ fontSize: '9.5px' }}
              title={band.label}
            >
              {band.label}
            </span>
            {band.issues.map((id) => (
              <PoolRailTile
                key={`issue:${id}`}
                pool={pool}
                id={id}
                kind="issue"
                actions={actions}
                digit={numbers.get(id)}
                hover={hover}
                setHover={setHover}
              />
            ))}
            {band.worktrees.map((id) => (
              <PoolRailTile
                key={`wt:${id}`}
                pool={pool}
                id={id}
                kind="worktree"
                actions={actions}
                hover={hover}
                setHover={setHover}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div className="flex flex-none flex-col items-center gap-[13px] border-t border-hairline-soft py-[11px]">
        {commandPaletteEnabled && (
          <button
            data-pressable
            type="button"
            className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-text-strong"
            title="Search (⌘K)"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
          >
            <Search size={14} aria-hidden="true" />
          </button>
        )}
        <button
          data-pressable
          type="button"
          data-testid="rail-add-repository"
          className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-text-strong"
          title="Add repository"
          aria-label="Add repository"
          onClick={openAddProject}
        >
          <FolderPlus size={14} aria-hidden="true" />
        </button>
      </div>
    </>
  )
})

const PoolRailTile = observer(function PoolRailTile({
  pool,
  id,
  kind,
  actions,
  digit,
  hover,
  setHover,
}: {
  pool: MobxPool
  id: string
  kind: 'issue' | 'worktree'
  actions: PoolWorkActions
  digit?: number
  hover: { key: string; anchor: DOMRect } | null
  setHover: (value: { key: string; anchor: DOMRect } | null) => void
}): JSX.Element | null {
  const local = useRuntimeSelector(
    (s) => ({
      selected: kind === 'worktree' && s.selectedIssueId === null && s.selectedWorktree !== null && machinePathsEqual(s.selectedWorktree, id),
    }),
    shallowEqual,
  )
  const value = kind === 'issue' ? sidebarView(pool).row(id) : undefined
  const entity = kind === 'worktree' ? pool.model('worktree', id) : undefined
  const tree = entity ? worklistView(pool).tree(entity) : undefined
  if (
    (kind === 'issue' && (value === undefined || value === LOADING)) ||
    (kind === 'worktree' && !tree)
  )
    return null
  let phase: MotionPhase, count: number, title: string, status: string
  const selected = kind === 'issue' ? worklistView(pool).row(pool.issueObject(id)).selected : local.selected
  let mark: JSX.Element
  if (value !== undefined && value !== LOADING) {
    const issue = navigationIssue(value.issue)
    phase = value.timing.phase
    const waiting = value.aggregate.railWaiting
    count = ((value.ownFacts.state === 'ready' && value.ownFacts.finished ? waiting?.finished : waiting?.open) ?? 0) + (waiting?.decisions ?? 0)
    title = `${idSquareLabel(issue).full} ${issue.title}`
    status = worklistIssueStatus(value)
    mark = (
      <>
        <IdSquare
          issue={issue}
          state={phase}
          selected={selected}
          badge={railBadge(phase, count)}
          ringColor="var(--sidebar)"
          size={32}
          width={36}
          radius={9}
          numberOnly
          titleHint={null}
          onPrimary={() => actions.selectIssue(id)}
          onColorChange={(color) => actions.setIssueColor(id, color)}
        />
        <RailProgressMeter progress={value.progress === LOADING ? { total: 0, done: 0, run: 0, review: 0, stall: 0, block: 0, wait: 0 } : value.progress} />
        {digit !== undefined && <RowShortcutBadge digit={digit} size={32} radius={9} />}
      </>
    )
  } else {
    const sessions = tree!.sessions
    const phases = sessions.map(session => worklistView(pool).session(session).phase)
    phase = phases.includes('waiting')
      ? 'waiting'
      : phases.includes('working')
        ? 'working'
        : phases.length && phases.every((p) => p === 'done')
          ? 'done'
          : 'queued'
    count = phases.filter((p) => p === 'waiting').length
    title = tree!.worktree.branch ?? (machinePathBasename(id) || id)
    const head = sessions.length > 1 ? `${sessions.length} agents · ` : ''
    const working = phases.filter((p) => p === 'working').length
    const waiting = sessions.filter((_, index) => phases[index] === 'waiting') as SessionView[]
    const urgent = mostUrgentSession(waiting, railWaitingNow(pool, waiting))
    status =
      phase === 'waiting'
        ? head + (urgent ? (agentBadge(urgent as SessionView)?.label ?? 'needs you') : 'needs you')
        : phase === 'working'
          ? (working > 1 ? `${working} agents · ` : '') + 'working'
          : head + (phase === 'done' ? 'done' : 'idle')
    mark = (
      <button
        data-pressable
        type="button"
        data-testid="rail-worktree-square"
        className="phase-surface relative flex flex-none cursor-pointer items-center justify-center bg-secondary"
        style={{
          width: 36,
          height: 32,
          borderRadius: 9,
          borderWidth: 1,
          borderStyle: phase === 'queued' ? 'dashed' : 'solid',
          borderColor: phase === 'queued' ? 'var(--text-dim)' : 'var(--label)',
          color: phase === 'queued' ? 'var(--label)' : 'var(--foreground)',
          opacity: phase === 'queued' && !selected ? 0.6 : 1,
        }}
        aria-label={`Open worktree ${title}`}
        onClick={() => actions.selectWorktree(id)}
      >
        <GitBranch size={13} aria-hidden="true" />
      </button>
    )
  }
  const key = `${kind === 'issue' ? 'issue' : 'wt'}:${id}`
  const open = (event: { currentTarget: HTMLElement }) =>
    setHover({ key, anchor: event.currentTarget.getBoundingClientRect() })
  const close = () => {
    if (hover?.key === key) setHover(null)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: handlers reveal the descriptive card; the tile owns activation
    <span
      className="relative flex flex-none"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {mark}
      {selected && <RailSpine />}
      {hover?.key === key && (
        <RailHoverCard
          anchor={hover.anchor}
          title={title}
          meta={selected ? `selected · ${status}` : status}
          waiting={count > 0}
        />
      )}
    </span>
  )
})
