import type { SessionView as SessionMeta } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/store'
import { agentBadge, type MotionPhase, mostUrgentSession } from '@podium/client-core/viewmodels'
import { LOADING, type MobxPool } from '@podium/client-graph'
import { compareStructural, computed, observer } from '@podium/client-graph/react'
import { motionPhase } from '@podium/client-graph/worklist/rollup'
import type { SidebarWorktree } from '@podium/client-graph/worklist/sidebar'
import type { SidebarRowValues } from '@podium/client-graph/worklist/sidebar-row'

import { FolderPlus, GitBranch, Plus, Search } from 'lucide-react'
import { Fragment, type JSX, useMemo, useState } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { useStoreSelector } from '@/app/store'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { IdSquare, idSquareLabel } from '@/components/IdSquare'
import { useFeature } from '@/lib/use-feature'
import { useNewTask } from './new-task'
import { navigationIssue, poolIssueStatus } from './pool-row-data'
import { usePoolLayoutState } from './pool-sidebar'
import { RowShortcutBadge } from './RowShortcutBadge'
import { RailProgressMeter } from './row-progress'
import { MAX_ROW_SHORTCUTS, useRowShortcuts } from './row-shortcuts'
import { RailHoverCard, RailSpine, railBadge } from './SidebarRail'
import { type PoolWorkActions, usePoolUnifiedWork } from './use-pool-unified-work'

export function PoolSidebarRail(): JSX.Element | null {
  const pool = useWorklistPool()
  return pool ? <PoolRail pool={pool} /> : null
}

const PoolRail = observer(function PoolRail({ pool }: { pool: MobxPool }): JSX.Element {
  const layout = usePoolLayoutState()
  const sections = pool.sidebar.sections(layout)
  const actions = usePoolUnifiedWork(pool)
  const { startNewTask } = useNewTask({ bindChord: true })
  const setPaletteOpen = useStoreSelector((s) => s.setPaletteOpen)
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
  const local = useStoreSelector(
    (s) => ({
      selected: kind === 'worktree' && s.selectedIssueId === null && s.selectedWorktree === id,
    }),
    shallowEqual,
  )
  const draw = useMemo(
    () =>
      computed<{
        value: SidebarRowValues | typeof LOADING | undefined
        tree: SidebarWorktree | undefined
        count: number
        paint: unknown
      }>(
        () => {
          const value = kind === 'issue' ? pool.sidebar.row(id) : undefined
          const tree = kind === 'worktree' ? pool.sidebar.worktree(id) : undefined
          let count = 0
          if (value !== undefined && value !== LOADING) {
            const model = pool.issue(id)!
            const waiting = model.aggregate.railWaiting
            count =
              ((model.ownFacts.state === 'ready' && model.ownFacts.finished
                ? waiting?.finished
                : waiting?.open) ?? 0) + (waiting?.decisions ?? 0)
          }
          const paint =
            value !== undefined && value !== LOADING
              ? {
                  count,
                  phase: value.timing.phase,
                  title: value.issue.title,
                  ref: value.issue.displayRef,
                  seq: value.issue.seq,
                  color: value.issue.color,
                  status: poolIssueStatus(value),
                  progress: value.progress,
                }
              : (tree ?? value)
          return { value, tree, count, paint }
        },
        { equals: (a, b) => compareStructural(a.paint, b.paint) },
      ),
    [pool, id, kind],
  ).get()
  const { value, tree } = draw
  if (
    (kind === 'issue' && (value === undefined || value === LOADING)) ||
    (kind === 'worktree' && !tree)
  )
    return null
  let phase: MotionPhase, count: number, title: string, status: string
  const selected = kind === 'issue' ? pool.selection.has(id) : local.selected
  let mark: JSX.Element
  if (value !== undefined && value !== LOADING) {
    const issue = navigationIssue(value.issue)
    phase = value.timing.phase
    count = draw.count
    title = `${idSquareLabel(issue).full} ${issue.title}`
    status = poolIssueStatus(value)
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
        <RailProgressMeter progress={value.progress} />
        {digit !== undefined && <RowShortcutBadge digit={digit} size={32} radius={9} />}
      </>
    )
  } else {
    const sessions = tree!.sessions
    const phases = sessions.map((session) => motionPhase(session, false))
    phase = phases.includes('waiting')
      ? 'waiting'
      : phases.includes('working')
        ? 'working'
        : phases.length && phases.every((p) => p === 'done')
          ? 'done'
          : 'queued'
    count = phases.filter((p) => p === 'waiting').length
    title = tree!.worktree.branch ?? id.split('/').pop() ?? id
    const head = sessions.length > 1 ? `${sessions.length} agents · ` : ''
    const working = phases.filter((p) => p === 'working').length
    const urgent = mostUrgentSession(
      sessions.filter((_, index) => phases[index] === 'waiting') as SessionMeta[],
      pool.clock.current,
    )
    status =
      phase === 'waiting'
        ? head + (urgent ? (agentBadge(urgent as SessionMeta)?.label ?? 'needs you') : 'needs you')
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
