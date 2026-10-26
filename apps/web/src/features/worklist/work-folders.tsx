/**
 * THE CALM SIDEBAR'S FOLDERS (POD-2074, design 4a / 7a / 7b).
 *
 * The column used to stack, per project, a 35px mono band, the open rows, a
 * `4 snoozed` tail and a `1 closed` tail with its own Archive all. Now one
 * Open / Snoozed / Closed switch at the top picks the lane, and each project is
 * a plain folder under a hairline: chevron, name, count. The rarer controls
 * (drag grip, ⋯ options, +) appear only on hover, so the resting column is
 * names and rows.
 */
import { shallowEqual } from '@podium/client-core/shallow-equal'
import { mergeVisibleProjectOrder } from '@podium/client-core/values'
import { Archive, ChevronRight, Ellipsis, GripVertical, Pin, Plus } from 'lucide-react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { openAddProject } from '@/app/desktop-menu'
import { useRuntimeSelector } from '@/app/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RepoBaseBranchMenu } from '@/lib/BaseBranchMenu'
import { useReducedMotion } from '@/lib/use-reduced-motion'
import { cn } from '@/lib/utils'
import { cssEase, EASE_OUT, MOTION_S } from './worklist-motion-tokens'

export type WorkLane = 'open' | 'snoozed' | 'closed'

const LANES: readonly { lane: WorkLane; label: string }[] = [
  { lane: 'open', label: 'Open' },
  { lane: 'snoozed', label: 'Snoozed' },
  { lane: 'closed', label: 'Closed' },
]

/** The segmented switch under the filter: three lanes, each with its count.
 *  The raised chip is ONE element sliding under the labels on a transform
 *  (POD-2080), so a lane change reads as the selection moving, not as one chip
 *  going out and another coming on. */
export function WorkLaneSwitch({
  lane,
  counts,
  onChange,
}: {
  lane: WorkLane
  counts: Readonly<Record<WorkLane, number>>
  onChange: (lane: WorkLane) => void
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Task lanes"
      data-testid="work-lane-switch"
      className="relative mx-3 mb-[10px] flex flex-none gap-[2px] rounded-[8px] bg-(--work-well) p-[2px] text-[12px]"
    >
      <span
        aria-hidden="true"
        data-testid="work-lane-thumb"
        className="pointer-events-none absolute top-[2px] bottom-[2px] left-[2px] rounded-[6px] bg-chip shadow-[0_1px_2px_rgb(29_28_25/0.08)] transition-transform duration-(--motion-move) ease-(--motion-ease-out) motion-reduce:transition-none"
        style={{
          width: `calc((100% - ${4 + 2 * (LANES.length - 1)}px) / ${LANES.length})`,
          transform: `translateX(calc(${LANES.findIndex((item) => item.lane === lane)} * (100% + 2px)))`,
        }}
      />
      {LANES.map((item) => {
        const selected = item.lane === lane
        return (
          <button
            key={item.lane}
            data-pressable
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={`work-lane-${item.lane}`}
            onClick={() => onChange(item.lane)}
            className={cn(
              'relative flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[6px] py-[5px] transition-colors duration-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong',
              selected
                ? 'font-medium text-text-strong'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="truncate">{item.label}</span>
            <span className="flex-none font-mono text-[11px] tabular-nums text-text-faint">
              {counts[item.lane]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** The Closed lane's count and the most recent bulk archive's Undo. */
export function ClosedLaneHeader({
  count,
  archivedCount = 0,
  archiving = false,
  onArchiveAll,
  onUndo,
}: {
  count: number
  archivedCount?: number
  archiving?: boolean
  onArchiveAll: () => void
  onUndo: () => void
}): JSX.Element | null {
  const content = useRef<HTMLDivElement | null>(null)
  const hasUndo = archivedCount > 0
  const shownUndo = useRef(hasUndo)
  const reduceMotion = useReducedMotion()
  useLayoutEffect(() => {
    if (shownUndo.current === hasUndo) return
    shownUndo.current = hasUndo
    if (reduceMotion || typeof content.current?.animate !== 'function') return
    const animation = content.current.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: MOTION_S.lane * 1000,
      easing: cssEase(EASE_OUT),
    })
    return () => animation.cancel()
  }, [hasUndo, reduceMotion])
  if (count === 0 && archivedCount === 0) return null
  return (
    <div
      className="closed-lane-card mx-3 mt-[10px] mb-[10px] flex-none rounded-[8px] bg-(--work-well) py-[10px] pr-[10px] pl-3"
      data-testid="closed-lane-header"
    >
      <div ref={content} className="closed-lane-content flex items-center gap-[10px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span aria-live="polite" className="text-[12px] font-medium text-text-strong">
            {archiving
              ? 'Archiving…'
              : archivedCount > 0
                ? `${archivedCount} ${archivedCount === 1 ? 'task' : 'tasks'} archived`
                : `${count} closed this week`}
          </span>
          {archivedCount === 0 && (
            <span title="Cleared after 7 days" className="truncate text-[11px] text-text-dim">
              Cleared after 7 days
            </span>
          )}
        </div>
        {archivedCount > 0 ? (
          <button
            data-pressable
            type="button"
            onClick={onUndo}
            disabled={archiving}
            data-testid="closed-issues-undo"
            className="h-7 flex-none rounded-[6px] px-2 text-[11.5px] font-medium text-text-strong underline decoration-border-strong underline-offset-[3px] hover:decoration-text-dim disabled:cursor-default disabled:text-text-dim disabled:no-underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
          >
            Undo
          </button>
        ) : (
          <button
            data-pressable
            type="button"
            aria-label={`Archive all ${count} closed ${count === 1 ? 'task' : 'tasks'}`}
            onClick={onArchiveAll}
            data-testid="closed-issues-archive-all"
            className="closed-lane-archive flex h-7 flex-none items-center gap-[5px] rounded-[6px] border border-border-strong bg-chip px-[10px] text-[11.5px] font-medium text-foreground hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
          >
            <Archive size={12} className="text-text-dim" aria-hidden="true" />
            Archive all
          </button>
        )}
      </div>
    </div>
  )
}

/** What a folder's ⋯ menu can do. Absent entries are not offered. */
export interface FolderMenu {
  onMoveUp?: () => void
  onMoveDown?: () => void
  onToggle: () => void
  onCollapseAll?: () => void
  onExpandAll?: () => void
  /** The project's registered repository, when it is one: offers "Base branch…". */
  repo?: { repoId: string; path: string }
}

/**
 * One project's folder header (design 7a). Chevron, name and count rest;
 * the grip (left), ⋯ and + come in on hover or focus. An EMPTY project is the
 * same header greyed with its chevron shut — it keeps its place in the order
 * instead of moving to a separate "No open tasks" list.
 */
export function ProjectFolderHeader({
  label,
  count,
  collapsed,
  empty = false,
  pinned = false,
  dragging = false,
  onToggle,
  onGripDown,
  onNewTask,
  menu,
  testId = 'project-group-label',
}: {
  label: string
  count: number
  collapsed: boolean
  /** Nothing in this lane: greyed, shut, and not a disclosure. */
  empty?: boolean
  /** The Pinned folder above every project: a pin, no grip, no +. */
  pinned?: boolean
  /** This header is being dragged. */
  dragging?: boolean
  onToggle: () => void
  onGripDown?: (event: ReactPointerEvent) => void
  onNewTask?: () => void
  menu?: FolderMenu
  testId?: string
}): JSX.Element {
  const shut = collapsed || empty
  return (
    <div
      className={cn(
        'group/folder relative mx-1 flex h-[30px] flex-none items-center rounded-[7px] transition-[background-color,box-shadow] duration-100',
        dragging
          ? 'bg-chip shadow-[0_0_0_1px_var(--border-strong),0_4px_12px_-4px_rgb(29_28_25/0.18)]'
          : 'hover:bg-(--work-row-hover-bg)',
      )}
      data-testid="project-folder-header"
      data-dragging={dragging ? 'true' : undefined}
    >
      {onGripDown && (
        <span
          title="Drag to reorder"
          aria-hidden="true"
          data-testid="folder-grip"
          onPointerDown={onGripDown}
          style={{ touchAction: 'none' }}
          className={cn(
            'absolute top-[9px] -left-[3px] z-[1] flex size-3 cursor-grab items-center justify-center text-text-faint opacity-0 transition-opacity duration-100 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100',
            dragging && 'cursor-grabbing opacity-100',
          )}
        >
          <GripVertical size={12} />
        </span>
      )}
      <button
        data-pressable
        type="button"
        data-testid={testId}
        data-collapsed={shut ? 'true' : 'false'}
        aria-expanded={empty ? undefined : !collapsed}
        disabled={empty}
        onClick={onToggle}
        title={empty ? `${label} — nothing here` : `${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[7px] pr-1 pl-2 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong focus-visible:outline-offset-[-2px] disabled:cursor-default"
      >
        {pinned ? (
          <Pin size={10} aria-hidden="true" className="mx-px flex-none text-text-faint" />
        ) : (
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={cn(
              // Turns with the fold it opens: same length, same curve (POD-2080).
              'flex-none text-text-faint transition-transform duration-(--motion-fold) ease-(--motion-ease-fold)',
              !shut && 'rotate-90',
            )}
          />
        )}
        <span
          className={cn(
            'min-w-0 truncate text-[12.5px] font-semibold',
            empty ? 'text-text-dim' : 'text-foreground',
          )}
        >
          {label}
        </span>
        <span
          className="flex-none font-mono text-[10.5px] tabular-nums text-text-faint"
          data-testid="project-group-count"
        >
          {count}
        </span>
      </button>
      {menu && <FolderOptions label={label} collapsed={collapsed} empty={empty} menu={menu} />}
      {onNewTask && (
        <button
          data-pressable
          type="button"
          title={`New task in ${label}`}
          aria-label={`New task in ${label}`}
          data-testid="folder-new-task"
          onClick={onNewTask}
          className="mr-[6px] flex size-[22px] flex-none items-center justify-center rounded-[6px] text-text-dim transition-colors hover:bg-accent hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function FolderOptions({
  label,
  collapsed,
  empty,
  menu,
}: {
  label: string
  collapsed: boolean
  empty: boolean
  menu: FolderMenu
}): JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null)
  const [branchOpen, setBranchOpen] = useState(false)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              ref={trigger}
              data-pressable
              type="button"
              title="Project options"
              aria-label={`${label} options`}
              data-testid="folder-options"
              className="flex size-[22px] flex-none items-center justify-center rounded-[6px] text-text-dim opacity-0 transition-[opacity,color,background-color] duration-100 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 hover:bg-accent hover:text-text-strong focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong data-[popup-open]:opacity-100"
            />
          }
        >
          <Ellipsis size={14} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={!menu.onMoveUp} onClick={menu.onMoveUp}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!menu.onMoveDown} onClick={menu.onMoveDown}>
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {!empty && (
            <DropdownMenuItem onClick={menu.onToggle}>
              {collapsed ? 'Expand' : 'Collapse'}
            </DropdownMenuItem>
          )}
          {menu.onCollapseAll && (
            <DropdownMenuItem onClick={menu.onCollapseAll}>Collapse all projects</DropdownMenuItem>
          )}
          {menu.onExpandAll && (
            <DropdownMenuItem onClick={menu.onExpandAll}>Expand all projects</DropdownMenuItem>
          )}
          {menu.repo && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setBranchOpen(true)}>Base branch…</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A second menu on the same ⋯, so the branch field is not nested inside
        the options list's typeahead. It opens as the options menu closes. */}
      {menu.repo && (
        <DropdownMenu modal={false} open={branchOpen} onOpenChange={setBranchOpen}>
          {branchOpen && (
            <RepoBaseBranchMenu
              repoId={menu.repo.repoId}
              path={menu.repo.path}
              align="end"
              anchor={trigger.current}
              onDone={() => setBranchOpen(false)}
            />
          )}
        </DropdownMenu>
      )}
    </>
  )
}

/** A band as the order writer needs it: the key plus every alias it answers to. */
export interface OrderedProject {
  key: string
  name: string
  aliases: readonly string[]
}

/**
 * The project-order writer shared by the
 * folder drag and the ⋯ menu's Move up / Move down: the same `repoOrder`
 * setting, merged so projects not on screen keep their saved slots.
 */
export function useProjectOrderWriter(): (projects: readonly OrderedProject[]) => Promise<void> {
  const { setSidebarSettings, savedOrder } = useRuntimeSelector(
    (state) => ({
      setSidebarSettings: state.setSidebarSettings,
      savedOrder: state.sidebarSettings.repoOrder,
    }),
    shallowEqual,
  )
  return useCallback(
    async (projects) => {
      await setSidebarSettings({
        repoSort: 'custom',
        repoOrder: mergeVisibleProjectOrder(
          projects.map((project) => ({ ...project, aliases: [...project.aliases] })),
          savedOrder ?? [],
        ),
      })
    },
    [setSidebarSettings, savedOrder],
  )
}

/**
 * Move `key` within `full` so it lands where it now sits in `visible` (a
 * subset). Projects not on screen keep their relative places: the moved one is
 * inserted before the visible project that now follows it.
 */
export function placeInFullOrder(
  full: readonly string[],
  visible: readonly string[],
  key: string,
): string[] {
  const at = visible.indexOf(key)
  const rest = full.filter((item) => item !== key)
  const next = visible[at + 1]
  if (next === undefined) {
    const previous = visible[at - 1]
    const index = previous === undefined ? rest.length : rest.indexOf(previous) + 1
    rest.splice(index, 0, key)
    return rest
  }
  rest.splice(rest.indexOf(next), 0, key)
  return rest
}

/** Add repository, pinned under the list with a soft top shadow (design 4a). */
export function AddRepositoryFooter(): JSX.Element {
  return (
    <div className="relative z-[1] flex-none border-t border-hairline-bar px-[10px] pt-2 pb-[10px] shadow-[0_-8px_14px_-10px_rgb(29_28_25/0.18)]">
      <button
        data-pressable
        type="button"
        data-testid="add-repository"
        title="Add a local folder or clone a repository"
        onClick={openAddProject}
        className="group/addrepo flex h-10 w-full min-w-0 items-center gap-2.5 rounded-[8px] pr-2.5 pl-2 text-left text-muted-foreground transition-colors hover:bg-(--work-row-hover-bg) hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong"
      >
        <span className="flex size-6 flex-none items-center justify-center rounded-[6px] border border-dashed border-(--ghost-1) text-text-dim">
          <Plus size={12} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col gap-px">
          <span className="truncate text-[12.5px] font-medium">Add repository</span>
          <span className="truncate text-[11px] text-text-faint">Local folder or Git URL</span>
        </span>
      </button>
    </div>
  )
}
