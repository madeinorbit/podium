/**
 * THE COLLAPSED SIDEBAR RAIL (#41, redrawn to design 3b — POD-1178).
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY THE COLUMN GOT WIDER
 * ---------------------------------------------------------------------------
 *
 * 3a folded the wide list down to a 52px strip of 26px SQUARES: the same mark
 * the wide row wears, at the same size, with the row's text thrown away and
 * packed into a `title` attribute. It read as a list of stamps. Three facts the
 * operator collapses the sidebar to keep — which project a mission belongs to,
 * how far it has got, and what it is called — were either gone (the project was
 * a bare 1px hairline) or a second away behind an OS tooltip.
 *
 * 3b spends six more pixels of width, and buys all three back:
 *
 *   THE MARK IS A TILE, not a square. 36×32 with the number set alone at
 *   11.5px. The prefix is the same on every mark in the column, so dropping it
 *   is free, and what it frees is the one thing the strip had none of: room.
 *   `IdSquare` still draws it — geometry, tint, badge and colour picker all
 *   stay central (POD-1178 widened that component rather than forking it), so
 *   the rail cannot drift away from the square language it belongs to.
 *
 *   GROUPS ARE NAMED. The hairline said "a boundary is here"; the label says
 *   which project you are looking at, which is what the wide column says in the
 *   same place. It rides `label-mono` — the shell's 10.5px floor — not the
 *   mock's 8.5px, per POD-783: uppercase tracked mono is the hardest thing on
 *   the ramp to read small, and the floor exists precisely for this case.
 *
 *   PROGRESS IS ON THE MARK. `RailProgressMeter` insets the wide list's own
 *   meter into the foot of the tile — the only free surface a 58px column has.
 *
 *   THE TOOLTIP BECAME A CARD. Title on one line, the row's status phrase on
 *   the next in the motion grammar's own colours, opening instantly beside the
 *   tile instead of a second later on top of it. It is the menu surface
 *   (`MENU_HOVER_CARD`), because it opens from the same gesture one pixel off
 *   the same column as the colour picker and has to be the same object.
 *
 * AND THE SELECTION MARK MOVED. 3a grew a 10px gradient notch out of the square
 * and across the aside's border into the flight deck's column — a bridge, said
 * twice. 3b makes it the wide row's own 3px spine, flush with the column's
 * right edge: the same grammar in both states of the sidebar, and nothing to
 * paint across a border that the design no longer draws.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT NOW AGREES WITH THE WIDE LIST
 * ---------------------------------------------------------------------------
 *
 * The rail used to re-group `work` from scratch, which kept pinned missions
 * inside their project group where the wide column hoists them into a PINNED
 * section above everything. Two columns, two orders, one ⌘-digit — so ⌘3 could
 * name a different mission collapsed than expanded. 3b draws the pinned section
 * the design shows, which is the published split every other surface already
 * reads (`pinned` + `groups`), so the digits and both columns finally agree.
 *
 * The shell (#40) owns the 58px aside and the collapse flag; the ⟩ expand
 * control is its header band. This component fills everything under it.
 */

import {
  type MissionProgress,
  type MotionPhase,
  missionProgress,
  rowMotionPhase,
  rowStatusLine,
  rowWaitingCount,
  type UnifiedIssueRow,
  type UnifiedWorkRow,
} from '@podium/client-core/viewmodels'
import { GitBranch, Plus, Search } from 'lucide-react'
import { type CSSProperties, Fragment, type JSX, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStoreSelector } from '@/app/store'
import { IdSquare, type IdSquareBadge, idSquareLabel } from '@/components/IdSquare'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { NewIssueDialog } from '@/features/issues/NewIssueDialog'
import { agentBrandText } from '@/lib/agent-tone'
import { FLOW_CSS, issueColorHex } from '@/lib/issueColors'
import { MENU_HOVER_CARD } from '@/lib/menu-surface'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { useSidebarDerivation } from './derivation'
import { NewAgentMenu } from './NewAgentMenu'
import { RowShortcutBadge } from './RowShortcutBadge'
import { RailProgressMeter } from './row-progress'
import { MAX_ROW_SHORTCUTS, type RowShortcutTarget, useRowShortcuts } from './row-shortcuts'
import { useDefaultSpawn } from './spawn-row'
import { useUnifiedWork } from './use-unified-work'

/** The rail sits on the collapsed aside's surface — corner badges punch out of
 *  this colour, so it must track the theme's sidebar surface, not a literal. */
const RAIL_SURFACE = 'var(--sidebar)'

/** The design's tile: wider than it is tall, because the column has width to
 *  spend and height to save. Shared with the marks that overlay it (the ⌘
 *  digit) so a corner can never disagree with the corner beneath it. */
const TILE_WIDTH = 36
const TILE_HEIGHT = 32
const TILE_RADIUS = 9

function railBadge(phase: MotionPhase, waitingCount: number): IdSquareBadge | null {
  if (waitingCount > 0) return { kind: 'count', count: waitingCount }
  if (phase === 'working') return { kind: 'spinner' }
  if (phase === 'done') return { kind: 'check' }
  return null
}

function isIssueRow(row: UnifiedWorkRow): row is UnifiedIssueRow {
  return row.kind === 'issue'
}

/**
 * The selected mark's spine — the wide row's 3px rule, at the rail's scale.
 *
 * It sits at `right: -11px`, which with a 36px tile centred in a 58px column
 * lands its outer edge EXACTLY on the column's right edge: nothing overflows,
 * so the scroller needs no negative-margin trick to let it out, and the spine
 * reads as the column's own edge lighting up rather than as an object stuck to
 * the tile. Same `--issue` grammar as the wide row, so a colour pick animates
 * it through the registered transition.
 */
function RailSpine({ hex }: { hex: string | undefined }): JSX.Element {
  return (
    <span
      data-testid="rail-spine"
      aria-hidden="true"
      className="issue-scope pointer-events-none absolute top-1/2 right-[-11px] h-[20px] w-[3px] -translate-y-1/2 rounded-l-[2px]"
      style={{ '--issue': hex ?? FLOW_CSS, background: 'var(--issue)' } as CSSProperties}
    />
  )
}

/**
 * The hover card, portaled and fixed.
 *
 * It CANNOT live inside the tile's wrapper: the squares column scrolls, and an
 * `overflow-y: auto` box clips horizontally too, so a card reaching 200px to
 * the right would be cut off at the column's edge. Same reason — and the same
 * solution — as the colour picker two files over.
 *
 * `pointer-events-none`, so sweeping the mouse toward the card never lands the
 * cursor on the card itself and the tile underneath never loses its hover.
 */
function RailHoverCard({
  anchor,
  title,
  meta,
  waiting,
}: {
  anchor: DOMRect
  title: string
  meta: string
  /** Is the status line an ASK? Then it wears the attention ochre, exactly as
   *  the wide row's second line does — one colour rule across both columns. */
  waiting: boolean
}): JSX.Element {
  // Clamped only against the viewport's own edges. The card is ~46px tall and
  // the column's list is inset by a header and a footer, so this fires
  // essentially never — but a tile scrolled flush to the top edge should not
  // hang the card off the window.
  const centre = Math.min(
    Math.max(anchor.top + anchor.height / 2, 40),
    Math.max(40, window.innerHeight - 40),
  )
  return createPortal(
    <div
      data-testid="rail-hover-card"
      role="tooltip"
      className={cn(
        MENU_HOVER_CARD,
        'pointer-events-none fixed z-[70] flex -translate-y-1/2 flex-col gap-[5px] whitespace-nowrap',
      )}
      style={{ left: anchor.right + 11, top: centre }}
    >
      <span className="text-[12px] leading-none tracking-[-.005em] text-text-strong">{title}</span>
      <span
        className={cn(
          'font-mono shell-type-micro leading-none',
          waiting ? 'text-attention' : 'text-text-dim',
        )}
      >
        {meta}
      </span>
    </div>,
    document.body,
  )
}

export function SidebarRail(): JSX.Element {
  const derivation = useSidebarDerivation()
  const {
    pinned,
    groups,
    issues,
    sessions,
    selectedIssueId,
    selectedWorktree,
    selectIssue,
    selectWorktree,
    setIssueColor,
    now,
  } = useUnifiedWork(derivation)
  const {
    defaultAgent,
    defaultRepo,
    defaultTarget,
    menuRepos,
    machineViews,
    spawn,
    persistDefaultAgent,
  } = useDefaultSpawn(derivation.sections)
  const setPaletteOpen = useStoreSelector((s) => s.setPaletteOpen)
  const commandPaletteEnabled = useFeature('command-palette')
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  // What the pointer is on, and where that tile was when it arrived. The rect
  // is captured on enter rather than read on render because the card is fixed
  // to the viewport: a scroll invalidates it, and a scroll also dismisses.
  const [hover, setHover] = useState<{ key: string; anchor: DOMRect } | null>(null)

  // The design's sections, which are the published ones: PINNED above every
  // project group, exactly as the wide column draws them.
  const sections = useMemo(
    () => [
      ...(pinned.length > 0 ? [{ key: 'pinned', label: 'Pinned', rows: pinned }] : []),
      ...groups.map((group) => ({ key: group.key, label: group.label, rows: group.rows })),
    ],
    [pinned, groups],
  )
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections])

  // ⌘-hold shortcuts (POD-790): numbered down this column as drawn, which is
  // now the same order the wide list draws (see the header note).
  const shortcutRows = rows.filter(isIssueRow).slice(0, MAX_ROW_SHORTCUTS)
  const { numbers: shortcutNumbers } = useRowShortcuts(
    shortcutRows.map<RowShortcutTarget>((row) => ({
      id: row.issue.id,
      activate: () => selectIssue(row.issue),
    })),
  )

  // One walk of the issue graph for the whole column rather than one per tile:
  // `missionProgress` is the Flight Deck's derivation and it is not cheap, and
  // a rail with thirty tiles would otherwise run it thirty times on every tick
  // of the shell's clock. Keyed on the row set's identity, so a selection or a
  // `now` tick re-renders without re-walking.
  const missionIds = rows.filter(isIssueRow).map((row) => String(row.issue.id))
  const missionKey = missionIds.join('|')
  const progressByIssue = useMemo(() => {
    const map = new Map<string, MissionProgress>()
    for (const id of missionKey === '' ? [] : missionKey.split('|')) {
      map.set(id, missionProgress(issues, sessions, id))
    }
    return map
  }, [issues, sessions, missionKey])

  const totalWaiting = rows.reduce((sum, row) => sum + rowWaitingCount(row), 0)

  const renderIssueMark = (
    row: UnifiedIssueRow,
    phase: MotionPhase,
    waitingCount: number,
    selected: boolean,
  ): JSX.Element => {
    const { issue } = row
    const shortcutDigit = shortcutNumbers.get(issue.id)
    const progress = progressByIssue.get(String(issue.id))
    return (
      <>
        <IdSquare
          issue={issue}
          state={phase}
          selected={selected}
          badge={railBadge(phase, waitingCount)}
          ringColor={RAIL_SURFACE}
          size={TILE_HEIGHT}
          width={TILE_WIDTH}
          radius={TILE_RADIUS}
          numberOnly
          // The card says everything the OS tooltip did, immediately.
          titleHint={null}
          onPrimary={() => selectIssue(issue)}
          onColorChange={(color) => setIssueColor(issue.id, color)}
        />
        {progress && <RailProgressMeter progress={progress} />}
        {shortcutDigit !== undefined && (
          <RowShortcutBadge digit={shortcutDigit} size={TILE_HEIGHT} radius={TILE_RADIUS} />
        )}
      </>
    )
  }

  const renderWorktreeMark = (
    row: Extract<UnifiedWorkRow, { kind: 'worktree' }>,
    phase: MotionPhase,
    selected: boolean,
  ): JSX.Element => {
    const { worktree } = row
    const resting = phase === 'queued'
    const name = worktree.branch ?? worktree.path.split('/').pop() ?? worktree.path
    return (
      <button
        data-pressable
        type="button"
        data-testid="rail-worktree-square"
        className="phase-surface relative flex flex-none cursor-pointer items-center justify-center bg-secondary"
        style={{
          width: TILE_WIDTH,
          height: TILE_HEIGHT,
          borderRadius: TILE_RADIUS,
          // Longhands, not a `border` shorthand: a `var()` inside a shorthand
          // only resolves at computed-value time, so it can't be read back.
          borderWidth: 1,
          borderStyle: resting ? 'dashed' : 'solid',
          borderColor: resting ? 'var(--text-dim)' : 'var(--label)',
          color: resting ? 'var(--label)' : 'var(--foreground)',
          opacity: resting && !selected ? 0.6 : 1,
        }}
        aria-label={`Open worktree ${name}`}
        onClick={() => selectWorktree(worktree.path)}
      >
        <GitBranch size={13} aria-hidden="true" />
      </button>
    )
  }

  /** One tile, wrapped in the box that owns its selection spine and its card. */
  const renderRow = (row: UnifiedWorkRow): JSX.Element => {
    const phase = rowMotionPhase(row)
    const waitingCount = rowWaitingCount(row)
    const status = rowStatusLine(row, now)
    const key = row.kind === 'issue' ? `issue:${row.issue.id}` : `wt:${row.worktree.path}`
    const title =
      row.kind === 'issue'
        ? `${idSquareLabel(row.issue).full} ${row.issue.title}`
        : (row.worktree.branch ?? row.worktree.path.split('/').pop() ?? row.worktree.path)
    const selected =
      row.kind === 'issue'
        ? selectedIssueId === row.issue.id
        : selectedIssueId === null && selectedWorktree === row.worktree.path
    const open = (event: { currentTarget: HTMLElement }): void =>
      setHover({ key, anchor: event.currentTarget.getBoundingClientRect() })
    const close = (): void => setHover((current) => (current?.key === key ? null : current))
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: nothing here ACTIVATES — these four handlers only reveal the descriptive card, and the tile inside is the accessible control (its aria-label carries the same ref, and focus/blur reach this box from it)
      <span
        key={key}
        className="relative flex flex-none"
        // Focus opens the card too: everything the hover says here is something
        // a keyboard operator tabbing down the column needs just as much.
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
      >
        {row.kind === 'issue'
          ? renderIssueMark(row, phase, waitingCount, selected)
          : renderWorktreeMark(row, phase, selected)}
        {selected && (
          <RailSpine hex={row.kind === 'issue' ? issueColorHex(row.issue.color) : undefined} />
        )}
        {hover?.key === key && (
          <RailHoverCard
            anchor={hover.anchor}
            title={title}
            meta={selected ? `selected · ${status}` : status}
            waiting={waitingCount > 0}
          />
        )}
      </span>
    )
  }

  return (
    <>
      {/* THE SPAWN BLOCK, in the design's two parts. The tile is the wide row's
          main surface at rail scale — it carries the agent's brand SWATCH, not
          its glyph, for the same reason the wide row does (POD-725: a drawn
          logo competes with the identity marks below it). The dashed ⊞ under it
          is the wide row's chevron segment: the agent → repo → machine menu,
          plus "New issue…". Two controls, because the rail had one and the one
          it had could only ever start the last agent you happened to use. */}
      <div className="flex flex-none flex-col items-center gap-[7px] px-0 pt-[9px] pb-[8px]">
        <button
          data-pressable
          type="button"
          data-testid="rail-new-agent"
          className="flex size-[34px] flex-none cursor-pointer items-center justify-center rounded-[9px] border border-border-strong bg-chip transition-colors hover:border-text-faint hover:bg-accent disabled:opacity-50"
          disabled={!defaultRepo}
          title={defaultTarget ? `New agent in ${defaultTarget.repoName}` : 'No repos yet'}
          aria-label={defaultTarget ? `New agent in ${defaultTarget.repoName}` : 'New agent'}
          onClick={() => defaultRepo && spawn(defaultAgent, defaultRepo)}
        >
          <span
            aria-hidden="true"
            className={cn(
              'size-[12px] flex-none rounded-[3px] bg-current',
              agentBrandText(defaultAgent),
            )}
          />
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            render={
              <button
                data-pressable
                type="button"
                data-testid="rail-new-menu"
                className="flex h-[26px] w-[34px] flex-none cursor-pointer items-center justify-center rounded-lg border border-border-strong border-dashed text-text-faint transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Choose agent and repo"
                title="Choose agent and repo"
              >
                <Plus size={15} aria-hidden="true" />
              </button>
            }
          />
          <NewAgentMenu
            menuRepos={menuRepos}
            machineViews={machineViews}
            defaultRepo={defaultRepo}
            onSpawn={spawn}
            onPersistDefaultAgent={(kind) => void persistDefaultAgent(kind)}
            onNewIssue={() => setNewIssueOpen(true)}
          />
        </DropdownMenu>
      </div>
      {newIssueOpen && <NewIssueDialog onClose={() => setNewIssueOpen(false)} />}
      {/* The tiles column. No negative-margin overflow trick any more: the
          selected spine now stops exactly at the column's right edge and the
          corner badges sit well inside it, so nothing needs to escape. */}
      <div
        data-testid="sidebar-rail"
        className="scroll-none flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pt-1.5 pb-2"
        // A scroll invalidates the card's captured anchor, and a card left
        // hanging beside a tile that has moved is worse than no card.
        onScroll={() => setHover(null)}
      >
        {sections.map((section) => (
          <Fragment key={section.key}>
            <span
              data-testid="rail-group-label"
              className="label-mono mt-[6px] mb-[2px] w-full flex-none truncate px-[4px] text-center first:mt-0"
              title={section.label}
            >
              {section.label}
            </span>
            {/* One tile per MISSION, matching the wide column exactly
                (POD-516 §1.1). The rail used to append a tile per
                provenance-nested child, which was the collapsed spelling of the
                same second hierarchy the wide list has now dropped: a mission's
                children belong to the Flight Deck, and its tile already carries
                their attention through the row's bubbled counts. */}
            {section.rows.map((row) => renderRow(row))}
          </Fragment>
        ))}
      </div>
      {/* THE FOOTER, per the design: search, and under it the one number the
          collapsed column owes the operator — how much of the work below is
          waiting on THEM. Collapsed, the amber corner badges scroll out of
          sight; this does not. It is a readout, not a control: the answer to
          "should I open this back up" is a number, and there is nothing to
          click that would be better than the tiles themselves. */}
      <div className="flex flex-none flex-col items-center gap-[9px] border-t border-hairline-soft py-[9px]">
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
        {totalWaiting > 0 && (
          <span
            data-testid="rail-waiting-total"
            role="img"
            aria-label={`${totalWaiting} waiting on you`}
            title={`${totalWaiting} waiting on you`}
            className="mono-timer flex flex-none items-center gap-1 shell-type-micro leading-none text-attention"
          >
            {/* The dot is the BADGE's amber (`--motion-waiting`) and the digits
                are the attention ink beside it — the same pairing the corner
                badges above use, so the footer reads as their total. */}
            <span
              aria-hidden="true"
              className="size-[5px] flex-none rounded-full"
              style={{ background: 'var(--motion-waiting)' }}
            />
            {totalWaiting}
          </span>
        )}
      </div>
    </>
  )
}
