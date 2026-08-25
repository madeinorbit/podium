/**
 * THE COLLAPSED SIDEBAR RAIL (#41, redrawn to design 3b — POD-1178).
 *
 * SPACING AND THE FOOTER PAIR (POD-1279). Every element in the column carries
 * 2px more air on each side than 3b drew — the gaps between tiles, the group
 * labels, and both chrome ends — because at 58px wide the column's only way to
 * separate one mark from the next is the space around it, and 3b's 4px gap had
 * the tiles reading as one striped block. The project label lost a rung with
 * it: it names the group the tiles under it belong to, and at the same size as
 * the shell's other micro labels it competed with the numbers it introduces.
 *
 * AND THE ⊞ MOVED DOWN. The rail's two spawn controls used to stack at the top
 * while the footer held a search glyph and a waiting TOTAL. The open column
 * puts add and search together in one strip at the BOTTOM, so the rail does
 * too — and the total went, because it was a readout in a strip of controls and
 * the tiles above already carry the same attention, one badge per mission,
 * where the click that answers it is.
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
import { FolderPlus, GitBranch, Plus, Search } from 'lucide-react'
import { Fragment, type JSX, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { commandShortcutLabel } from '@/app/desktop-commands'
import { openAddProject } from '@/app/desktop-menu'
import { useStoreSelector } from '@/app/store'
import { IdSquare, type IdSquareBadge, idSquareLabel } from '@/components/IdSquare'
import { MENU_HOVER_CARD } from '@/lib/menu-surface'
import { useFeature } from '@/lib/use-feature'
import { cn } from '@/lib/utils'
import { useSidebarDerivation } from './derivation'
import { useNewTask } from './new-task'
import { RowShortcutBadge } from './RowShortcutBadge'
import { RailProgressMeter } from './row-progress'
import { MAX_ROW_SHORTCUTS, type RowShortcutTarget, useRowShortcuts } from './row-shortcuts'
import { useUnifiedWork } from './use-unified-work'

/** The rail sits on the collapsed aside's surface — corner badges punch out of
 *  this colour, so it must track the theme's sidebar surface, not a literal. */
const RAIL_SURFACE = 'var(--sidebar)'

/** The project label a rung under the shell's 10.5px micro floor (POD-1279).
 *  POD-783 put it ON the floor for legibility, and that argument still holds
 *  for labels that carry information; this one carries a name the tiles under
 *  it repeat, and at 10.5px uppercase mono it read as loud as the numbers it
 *  introduces. Half a rung, not a jump back to 3a's 8.5px. */
const RAIL_GROUP_LABEL_SIZE = '9.5px'

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
 * the tile.
 *
 * NEUTRAL INK, not the issue hue — `WorkRowShell`'s rule, and the design draws
 * the same near-black/near-white bar: the tile beside it is already tinted with
 * the issue's colour, and selection is a different question from identity. A
 * hued spine also lost the argument on contrast, since an issue colour at 3px
 * against a tinted tile is a whisper in either theme.
 */
function RailSpine(): JSX.Element {
  return (
    <span
      data-testid="rail-spine"
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-[-11px] h-[20px] w-[3px] -translate-y-1/2 rounded-l-[2px] bg-text-strong"
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
  // THE COLLAPSED COLUMN STILL ANSWERS ⌘N (POD-1469). `AppShell` renders the
  // rail INSTEAD of the wide column, so the tile here is the only owner of the
  // chord while the sidebar is shut — leaving it unbound made ⌘N and the macOS
  // File menu dead in exactly the state an operator collapses into to get room.
  // Two owners for one frame during the fold is harmless now in a way it never
  // was for the spawn row this replaces: `startNewTask` clears a selection and
  // seeds a draft, so answering one press twice lands on the same screen, where
  // answering it twice used to start two agents.
  const { startNewTask } = useNewTask({ bindChord: true })
  const setPaletteOpen = useStoreSelector((s) => s.setPaletteOpen)
  const commandPaletteEnabled = useFeature('command-palette')
  // ⌘K on macOS, Ctrl+K everywhere else — named from the shell's own registry
  // rather than typed in, so the glyph follows the platform (POD-1532).
  const searchChord = commandShortcutLabel('command-palette')
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
        {selected && <RailSpine />}
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
      {/* THE NEW-TASK TILE (POD-1469). The wide row's control at rail scale, and
          it makes the same non-choice: no harness, no repo, no menu — it opens
          the blank mission and the composer asks the rest. It used to carry the
          default harness's brand mark, which was the collapsed spelling of a
          decision the column no longer makes for you. */}
      <div className="flex flex-none flex-col items-center px-0 pt-[11px] pb-[10px]">
        <button
          data-pressable
          type="button"
          data-testid="rail-new-task"
          className="flex size-[34px] flex-none cursor-pointer items-center justify-center rounded-[9px] border border-border-strong bg-chip text-text-dim transition-colors hover:border-text-faint hover:bg-accent hover:text-foreground"
          // At rail scale the tile is a mark and nothing else, so the tooltip is
          // the only place its name can be stated.
          title="New task"
          aria-label="New task"
          onClick={() => startNewTask()}
        >
          <Plus size={17} aria-hidden="true" className="flex-none" />
        </button>
      </div>
      {/* The tiles column. No negative-margin overflow trick any more: the
          selected spine now stops exactly at the column's right edge and the
          corner badges sit well inside it, so nothing needs to escape. */}
      <div
        data-testid="sidebar-rail"
        className="scroll-none flex min-h-0 w-full flex-1 flex-col items-center gap-[8px] overflow-y-auto pt-[8px] pb-[10px]"
        // A scroll invalidates the card's captured anchor, and a card left
        // hanging beside a tile that has moved is worse than no card.
        onScroll={() => setHover(null)}
      >
        {sections.map((section) => (
          <Fragment key={section.key}>
            <span
              data-testid="rail-group-label"
              className="label-mono mt-[8px] mb-[4px] w-full flex-none truncate px-[6px] text-center first:mt-0"
              // A rung under the shell's micro floor, and the ONE place that is
              // allowed: `label-mono` is a custom `@utility`, so a `text-[…]`
              // class beside it loses the cascade to the utility's own
              // `font-size` — the size has to be set here to take.
              style={{ fontSize: RAIL_GROUP_LABEL_SIZE }}
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
      {/* THE FOOTER: search, and the door to a repository (POD-1279, POD-1469).
          It was search over a dashed ⊞ opening the agent → repo → machine menu —
          the collapsed spelling of a strip the open column no longer has. The
          menu is gone with it: starting work is the tile at the TOP of this
          rail now, where the wide column also keeps it, and what is left down
          here is the pair of utilities. `Add repository` cannot spell itself out
          at 52px, so it keeps its glyph and says so in its tooltip.

          The waiting TOTAL that used to sit here is gone. It was a readout in a
          strip of controls, and the amber corner badges on the tiles above say
          the same thing one mission at a time — where the click that answers
          the ask actually is. */}
      <div className="flex flex-none flex-col items-center gap-[13px] border-t border-hairline-soft py-[11px]">
        {commandPaletteEnabled && (
          <button
            data-pressable
            type="button"
            className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-text-strong"
            title={searchChord ? `Search (${searchChord})` : 'Search'}
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
}
