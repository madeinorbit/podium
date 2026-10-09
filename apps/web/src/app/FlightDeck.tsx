import type { SessionModel } from '@podium/client-graph/models'
import { isFinished } from '@podium/model/browser'
import { relativeTime } from '@podium/client-core/focus'
import type { SessionView } from '@podium/client-core/session-values'
import { shallowEqual } from '@podium/client-core/shallow-equal'
import {
  FLIGHT_DECK_BRIEF_CUTOFF_KEY,
  FLIGHT_DECK_FOLDS_KEY,
  FLIGHT_DECK_MODE_KEY,
} from '@podium/client-core/ui-state'
import {
  type CollapsedSummary,
  type DeckIssueState,
  type DeckState,
  deckSessions,
  deckViewEmptyLine,
  type FlightDeckFoldMap,
  type FlightDeckFoldState,
  type FlightDeckMode,
  type FlightDeckRow,
  flightDeckRowDefaultFolded,
  flightDeckRowHasPayload,
  flightDeckRowIsFolded,
  type IssueContinuation,
  type IssueNavigationModel,
  type IssueNote,
  isCoordinatorSession,
  issueAbandoned,
  issueOwnContentUnread,
  type MissionDeparture,
  type machineViewsFromWire,
  nativeSubagentRows,
  type PresenceNote,
  readFlightDeckFolds,
  type SessionRole,
  sessionRole,
  sessionUnreadEmphasized,
  continuationPresenceLine as sharedContinuationPresenceLine,
  spawnIssueAgent,
  subtreeUnread,
  treeGuides,
  writeFlightDeckFolds,
} from '@podium/client-core/values'
import { MissionDeckIssueModel, requireLoaded, settled } from '@podium/client-graph/mission-view'
import type { MissionScreen } from '@podium/client-graph/mission-screen'
import type { MobxPool } from '@podium/client-graph/pool'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { observer } from '@podium/client-graph/react'
import { asIssueId } from '@podium/model'
import type { IssueId, MachineId, SessionId } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  Hourglass,
  Maximize2,
  Minimize2,
  Search,
  UserPlus,
  X,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type {
  ComponentProps,
  CSSProperties,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { GhostBar, GhostDot, GhostPreview, GhostSquare } from '@/components/GhostPreview'
import { UnreadDot } from '@/components/UnreadMark'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useIssueExplorer } from '@/features/issues/explorer/explorer-context'
import type { IssueContextMenu } from '@/features/issues/IssueContextMenu'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { STAGE_LABELS } from '@/features/issues/issue-card'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { IssueCloseDialog, useIssueCloseGuard } from '@/features/issues/issue-lifecycle'
import { useIssueStatusApply } from '@/features/issues/use-issue-status-apply'
import {
  type AgentRowStatus,
  agentFleetStatus,
  CapabilityAgentItem,
  candidateFromAvailability,
} from '@/lib/agent-capability'
import { type IssueAgentKind, issueAgentOptions, issueDefaultAgentKind } from '@/lib/issue-agents'
import { renderReadoutMarkdown } from '@/lib/markdown'
import { PhaseTimer, useArrivals, WorkingMark } from '@/lib/motion'
import { PoolSessionContextMenu } from '@/lib/PoolSessionContextMenu'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { useFeature } from '@/lib/use-feature'
import { usePersistedUiState, usePersistedUiValue } from '@/lib/use-persisted-ui-state'
import { cn } from '@/lib/utils'
import { KindIcon, SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { useClickIntent } from './click-intent'
import { FlightDeckHandoff } from './FlightDeckHandoff'
import PoolFlightDeck from './FlightDeckPool'
import { FlightDeckWaterfall } from './FlightDeckWaterfall'
import { type FlightDeckDisplay, nextFlightDeckDisplayForSessionPick } from './flight-deck-display'
import {
  type DeckWindow,
  type DeckWindowRow,
  DeckRowPlaceholder,
  deckSessionKey,
  deckTaskKey,
  useFlightDeckWindow,
} from './flight-deck-window'
import { useDraftValue } from './keyed-runtime'
import { MissionCostChip } from './MissionCostChip'
import { MissionGauge } from './MissionGauge'
import { resolveFocus, useOperatorFocus } from './operator-focus'
import { useSessionHovered } from './session-hover'
import {
  CLOSE_RIGHT_PANEL,
  OPEN_RIGHT_PANEL_EVENT,
  REVEAL_IN_DECK_EVENT,
  RIGHT_PANEL_KEY,
  readRightPanel,
} from './shell-state'
import { useRuntimeSelector } from './store'
import { useWorklistPoolProjection } from './store-worklist-pool'

/**
 * TWO QUESTIONS, NOT ONE SLIDER (POD-1452). `Active` sat between `Full spine`
 * and `Needs you` as a vaguer version of both — it named no state the column
 * shows anywhere else, so it meant whatever the reader assumed, and it was the
 * word that let a finished agent look like live work.
 *
 * `Working` is the word the mission chip a few pixels above this bar already
 * uses (`1 working`) and the one the row's spinner already answers, so the tab
 * and the count beside it agree by construction. And it no longer contains the
 * asking agents: busy and stuck-on-you are different facts, and a tab that held
 * both left `Needs you` looking like it had done nothing.
 */
export type FlightDeckView = FlightDeckMode | 'waterfall' | 'handoff'

const MODES: Array<{ id: FlightDeckView; label: string }> = [
  { id: 'full', label: 'Full spine' },
  { id: 'working', label: 'Working' },
  { id: 'needs-you', label: 'Needs you' },
]
const WATERFALL_MODE = { id: 'waterfall', label: 'Waterfall' } as const
const TIMELINE_MODE = { id: 'handoff', label: 'Timeline' } as const

/**
 * `Add agent` — one more agent onto the mission root.
 *
 * IT REFUSES WHAT IT CANNOT RUN (POD-1201). This menu listed every harness the
 * build knows about, so on a host with no Cursor installed `Add Cursor` looked
 * exactly as startable as `Add Claude Code` and produced a session that died on
 * a missing binary. The reading and the words come from `lib/agent-capability`,
 * shared with the tab strip's "+" and the sidebar's spawn menu.
 *
 * WHICH HOSTS COUNT: the issue's own, and only those. An issue that pins a
 * `machineId` runs its agents there — the harness being installed somewhere else
 * in the fleet is not an answer — and an unpinned one can land on any host
 * holding its repo, which is the same set `addSession`/`start` will choose from.
 */
type MissionAgentMenuProps = {
  defaultAgent: string
  repoPath: string
  machineId?: MachineId | null
  onAdd: (agentKind?: IssueAgentKind) => Promise<unknown>
  poolHosts: ReturnType<typeof machineViewsFromWire>
}

function MissionAgentMenu(props: MissionAgentMenuProps): JSX.Element {
  return <MissionAgentMenuContent {...props} hosts={props.poolHosts} />
}

function MissionAgentMenuContent({
  defaultAgent,
  onAdd,
  hosts,
}: MissionAgentMenuProps & { hosts: ReturnType<typeof machineViewsFromWire> }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const options = issueAgentOptions(defaultAgent)
  const statusFor = (kind: IssueAgentKind, label: string): AgentRowStatus =>
    hosts.length === 0
      ? {}
      : agentFleetStatus(
          hosts.map((view) => candidateFromAvailability(view.machine, view.availability, kind)),
          label,
        )
  const add = (agentKind: string): void => {
    setBusy(true)
    void onAdd((agentKind || undefined) as IssueAgentKind | undefined)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'Could not add agent'),
      )
      .finally(() => setBusy(false))
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-[26px] flex-none gap-1.5 px-2.5"
            disabled={busy}
            aria-label="Add agent to mission"
          >
            <UserPlus size={13} aria-hidden="true" />
            {busy ? 'Adding…' : 'Add agent'}
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
        }
      />
      {/* 224px, not the 192 it had: a row now carries a trailing `not installed`
          beside its label, and at w-48 the widest label truncated to "Add Cur…"
          — the row would have been refusing a click while hiding WHICH harness
          it was refusing (POD-1201). */}
      <DropdownMenuContent align="end" className="w-56">
        {options.map((option) => (
          <CapabilityAgentItem
            key={option.value || 'default'}
            icon={option.icon}
            label={`Add ${option.label}`}
            // The agent name for the refusal comes from `option.label`, not from
            // the row's copy: "Add Claude Code (default) is not installed" is not
            // a sentence.
            status={statusFor(
              option.value
                ? issueDefaultAgentKind(option.value)
                : issueDefaultAgentKind(defaultAgent),
              option.label,
            )}
            onSelect={() => add(option.value)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The spine's geometry, in one place because the tree guides are drawn from it.
 *
 * The rows render FLAT — one strip per issue, indented — so a filter, a search
 * or (later) a window can drop any of them without re-parenting anything. What
 * makes it read as a tree is that every row draws the rail segments crossing it
 * and the elbow into its own strip, so adjacent rows compose one continuous
 * line. `treeGuides` in mission.ts decides which rails carry on past a row.
 *
 * A TASK'S AGENTS AND ITS CHILD TASKS SHARE ONE RAIL (POD-758). They used to
 * hang on two lines two pixels apart, so that a child task landed left of its
 * parent's agents and could never be misread as one. The redesign makes an
 * agent row a different KIND of object instead — no strip, no fill, no rounded
 * edge — which settles the same confusion without spending a second line on it,
 * and lets one branch line carry everything a task owns.
 */
import { DEPTH_STEP, RAIL_INSET, BAND_HEIGHT, PROPOSED_BAND, ROOT_RAIL, ROOT_BLOCK_INSET, GUTTER, STATE_COL, type RailTone, railFor, readMode, writeMode, type FoldState, type FoldMap, readFolds, writeFolds, type FoldableRow, hasPayload, isFolded, sessionSearchText, IssueNoteChip, SeatChip, seatFor, roleLabel, SessionRow, HungRows, DeckFlatRows, TaskRow, ProposalRow } from './FlightDeckRows'
export { readFolds, writeFolds, hasPayload, defaultFolded, isFolded, deckTaskUnread } from './FlightDeckRows'
export type { FoldState, FoldMap } from './FlightDeckRows'

/**
 * A NAMED REGION BELOW THE TREE (POD-710 §4.4).
 *
 * The spine is one thing — the mission's shape — and anything that is not part
 * of that shape has to leave it rather than hang off it with a guide rail
 * borrowed from a parent it does not really have. Proposals are the first
 * tenant; departure ticks (POD-679) are the next, and they are SIBLINGS of this
 * section, not children of it.
 *
 * The heading is DESIGN.md §3's Label: 8.5px Geist Mono, 0.12em, uppercase,
 * Label Grey — the same voice as WORK and TRAY, because it is the system naming
 * a region of itself. It carries its own COUNT and its own rule rather than
 * sitting under a full-width border: a rule that starts after the word reads as
 * that word underlining a region, where a border across the column reads as the
 * spine ending. The spine has not ended — these sections are its tail.
 */
function DeckSection({
  label,
  count,
  tone,
  className,
  testId,
  children,
}: {
  label: string
  /** Printed beside the label when the region's size is the useful fact. */
  count?: number
  /** Class for the label, when the region has a hue of its own (proposals). */
  tone?: string
  /** Optional spacing override for a section that needs a stronger break. */
  className?: string
  testId: string
  children: ReactNode
}): JSX.Element {
  return (
    // THE SECTION STARTS WHERE THE SPINE STARTS. It used to sit at 8px while
    // every task strip began at GUTTER, so a proposal was visibly wider than the
    // tasks it was being offered against and its label rule started in the
    // rail's own gutter. Same left datum as a depth-1 strip, same right datum as
    // everything else in the column.
    <section
      className={cn('pr-2', className ?? 'mt-2.5')}
      style={{ paddingLeft: GUTTER }}
      data-testid={testId}
    >
      <div className="flex items-center gap-2">
        <h3
          className={cn(
            'font-mono shell-type-micro font-medium tracking-[0.16em] uppercase',
            tone ?? 'text-label',
          )}
        >
          {label}
        </h3>
        {count !== undefined && (
          <span className="shell-type-micro font-mono text-text-faint">{count}</span>
        )}
        <span aria-hidden className="h-px flex-1 bg-hairline-soft" />
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  )
}

/** The state dot and word a departed task carries, in the spine's own state
 *  column — the same cell every strip and every agent row parks its state in,
 *  so the whole tail reads down the same edge as the tree above it. */
function DepartedState({ state }: { state: DeckIssueState }): JSX.Element {
  return (
    <span
      className={cn(
        'shell-type-micro flex flex-none items-center justify-end gap-1.5 overflow-hidden font-mono whitespace-nowrap',
        STATE_COL,
      )}
      data-attention={state.attention ? 'true' : undefined}
    >
      {state.attention && (
        <span aria-hidden className="size-[5px] flex-none rounded-full bg-attention" />
      )}
      <span className="truncate">{state.label.toLowerCase()}</span>
    </span>
  )
}

/**
 * WHERE THE WORK WENT — one region, one heading, one sentence (POD-679, POD-1146).
 *
 * Work discovered here and started as its own thing is not a member of this
 * mission any more: it holds no seat, wears no state mark, and does not move
 * the gauge. But a row that simply vanished would be a lie by omission — the
 * operator watched an agent file it here — so the mission keeps one line each,
 * and the line is a way back to it.
 *
 * THE REGION HAS TWO SHAPES AND ONLY ONE OF THEM AT A TIME.
 *
 *   still being worked — quiet ticks, no actions, because nothing here is
 *     finished and nothing is asking;
 *   the root itself vacated — the one destination is PROMOTED to a card with
 *     Open and Tuck away, because it is the only thing left to act on.
 *
 * They used to be two components that did not know about each other, and a
 * continuation target is by construction a started spin-off — so it always
 * qualified as a departure too, and POD-1016 rendered once as a card with two
 * buttons and again twelve pixels below as a faint mono tick in a different
 * voice. The continuation is now simply the departure that has an action
 * attached: it is filtered out of the ticks and drawn as the first row of the
 * same region, wearing the state its tick used to carry.
 *
 * The old heading named a departure ("Left this mission"); this one answers the
 * question the operator is actually asking.
 *
 * Deliberately OUTSIDE the tree: no rail, no elbow, and a label above rather
 * than an indent below. A guide line running into these would say the one thing
 * this whole change exists to stop saying — that they are still in here.
 */
export function WhereTheWorkWent({
  continuation,
  continuationState = null,
  continuationFinished = true,
  continuationSessions = [],
  departures,
  onOpen,
  onTuck,
}: {
  /** The promoted destination, when this mission's own root has been vacated. */
  continuation: IssueContinuation | null
  /** Folded in off the tick this row replaces, so nothing is lost with it. */
  continuationState?: DeckIssueState | null
  /** The vacated task's OWN sessions, so the card can check "vacated" rather
   *  than assume it (POD-1233). */
  continuationSessions?: readonly SessionView[]
  /** Whether the vacated task itself is already recorded as finished — the card
   *  names a different filing action when it is not (see {@link ContinuationCard}). */
  continuationFinished?: boolean
  /** Everything else that left — already filtered of the continuation target. */
  departures: readonly MissionDeparture[]
  onOpen: (issue: IssueNavigationModel) => void
  onTuck: () => void
}): JSX.Element | null {
  if (!continuation && departures.length === 0) return null
  return (
    <DeckSection
      label="Where the work went"
      count={departures.length + (continuation ? 1 : 0)}
      className="mt-4"
      testId="flight-departures"
    >
      {continuation && (
        <ContinuationCard
          continuation={continuation}
          state={continuationState}
          finished={continuationFinished}
          sessions={continuationSessions}
          onOpen={onOpen}
          onTuck={onTuck}
        />
      )}
      <div className={cn('flex flex-col', continuation && departures.length > 0 && 'mt-2')}>
        {departures.map((departure, index) => (
          <div key={departure.issue.id}>
            {/* A rule between ticks rather than a bare stack: two 26px rows
                twenty-two pixels apart read as two unrelated lines. */}
            {index > 0 && <div aria-hidden className="my-0.5 ml-1 h-px bg-hairline-soft" />}
            <button
              data-pressable
              type="button"
              data-testid="flight-departure"
              data-departure-issue={departure.issue.id}
              className="flex min-h-[26px] w-full items-center gap-2 rounded-md pr-2 pl-1 text-left text-text-faint hover:bg-muted hover:text-text-dim"
              title={`${issueDisplayRef(departure.issue)} runs on its own · ${departure.state.label}`}
              onClick={() => onOpen(departure.issue)}
            >
              <ArrowUpRight size={11} aria-hidden className="flex-none" />
              <span className="shell-type-micro flex-none font-mono">
                {issueDisplayRef(departure.issue)}
              </span>
              <span className="shell-type-secondary min-w-0 flex-1 truncate">
                {departure.issue.title}
              </span>
              <DepartedState state={departure.state} />
            </button>
          </div>
        ))}
      </div>
    </DeckSection>
  )
}

/**
 * The signpost's SECOND line — the only part of the card that says anything
 * about sessions, and therefore the only part that has to look at them.
 *
 * WHY THE FIX IS HERE AND NOT IN THE VIEWMODEL (POD-1233). The obvious repair
 * for "No session remains" appearing over a live agent is to hoist
 * `issueContinuation`'s live-session guard above its `supersededBy ??
 * duplicateOf` branch. That is wrong: four surfaces read that one function, and
 * three of them want the lineage even while somebody is still here — the
 * sidebar's `duplicate · POD-1160` line (`slices/worklist/rows.ts`), the deck
 * header's "continued in" chip (`issueNote`), and `row-attention`'s suppression
 * of a review ask nobody is waiting on. Returning `null` deletes the trail to
 * the canonical task from all of them. The headline is a LINEAGE fact and stays
 * true whoever is in the room; only this sentence was ever a session claim.
 *
 * PARKED IS PRESENT. `sessionPresentOnTask` is `!archived && status !==
 * 'exited'`, so a hibernated agent still holds the task — the roster draws it
 * ghosted, not gone. That is not a detail: sessions here park far more often
 * than they exit, so "wait for it to end" is a state most tasks never reach,
 * and a guard written against it would suppress the signpost forever.
 *
 * ALL THREE KINDS, deliberately. A duplicate is what surfaced this, but the
 * sentence is equally unchecked on `superseded`, and `spinoff` only escapes it
 * because its own guard fires upstream. Nothing here changes WHICH cards
 * appear — a superseded task with an agent on it still gets its signpost, and
 * still gets to say so honestly.
 */
export function continuationPresenceLine(
  kind: IssueContinuation['kind'],
  sessions: readonly SessionView[],
): string {
  return sharedContinuationPresenceLine(kind, sessions)
}

/**
 * THE SIGNPOST BOX — one panel for "this mission is over", however it ended
 * (POD-1268).
 *
 * Two cards say that now, in the same slot of the same column: the continuation
 * ("work carried on in POD-815") and the retirement ("finished, nobody left
 * here"). They are the same kind of statement, so the frame is written once and
 * the words are the only thing that differs between them — an operator who has
 * read one should not have to re-learn the layout to read the other.
 *
 * Presentational only: it holds no lifecycle opinion, which is what keeps the
 * two callers free to name their own action.
 */
function SignpostBox({
  icon,
  headline,
  aside = null,
  detail,
  actions,
  testId,
}: {
  icon: ReactNode
  headline: string
  /** The state word folded in off a departure tick, where there is one. */
  aside?: ReactNode
  detail: string
  actions: ReactNode
  testId: string
}): JSX.Element {
  return (
    <div className="rounded-[8px] border border-border bg-card/55 p-3" data-testid={testId}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-[22px] flex-none items-center justify-center rounded-full bg-muted text-text-dim">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="shell-type-secondary min-w-0 flex-1 font-semibold text-text-strong">
              {headline}
            </p>
            {aside}
          </div>
          <p className="shell-type-micro mt-1 text-text-dim">{detail}</p>
        </div>
      </div>
      {/* WRAPPING, because this column resizes down to 300px and two labels
          together do not fit there. A clipped action is worse than a stacked one. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-[30px]">{actions}</div>
    </div>
  )
}

/**
 * A resolved empty task is not an empty mission. It is a signpost.
 *
 * This stays in the spine instead of becoming a toast: the destination must
 * still be understandable after reload, from another device, and when the
 * operator opens the old task hours later. Tucking is offered here because it
 * is the only remaining lifecycle choice; leaving the card alone keeps the
 * closed task in the sidebar.
 *
 * It is the FIRST ROW of the departures region rather than a card of its own
 * (see {@link WhereTheWorkWent}), and it carries the state word its departure
 * tick used to carry — so the destination is stated exactly once.
 *
 * THE FILING ACTION SAYS WHICH ONE IT IS (POD-1212). "Tuck away" is only
 * truthful on a task that is already finished: the fold is for finished work, so
 * `issues.setTucked` REFUSES an open one and the sidebar's own fold predicate
 * reads the same `closedReason`. A hopscotch origin left standing at `review`
 * with its work carried on elsewhere is exactly the case this card exists for,
 * and there the one button drew a promise the server threw out. So an unfinished
 * task is offered the ending as well as the fold, in one label — never a "Tuck
 * away" that quietly closes, because the tuck chip's own tooltip promises the
 * opposite ("Nothing is killed or closed").
 *
 * IT MUST NOT CLAIM THE TASK IS EMPTY WITHOUT LOOKING (POD-1233). The second
 * line used to be the constant "No session remains on this closed task", and on
 * a DUPLICATE that is a sentence nobody checked: `issueContinuation` reaches its
 * live-session guard only on the hopscotch path, so a task marked
 * `duplicateOf` drew this card with its agent still sitting in the roster
 * directly below. See {@link continuationPresenceLine}.
 */
export function ContinuationCard({
  continuation,
  state = null,
  finished = true,
  sessions = [],
  onOpen,
  onTuck,
}: {
  continuation: IssueContinuation
  /** What the destination is doing now, folded in off its own tick. */
  state?: DeckIssueState | null
  /** Whether THIS task is already closed or done. */
  finished?: boolean
  /** THIS task's own sessions — the only thing that can answer whether anyone
   *  is still here. Unfiltered: the view bar narrows what the spine DRAWS, and
   *  a sentence of fact must not change with a display toggle. */
  sessions?: readonly SessionView[]
  onOpen: (issue: IssueNavigationModel) => void
  /** File this signpost away — which on an unfinished task also records the
   *  ending, because tucking alone cannot fold it (see above). */
  onTuck: () => void
}): JSX.Element {
  const target = continuation.target
  return (
    <SignpostBox
      testId="flight-continuation"
      icon={<ArrowRight size={12} aria-hidden="true" />}
      headline={continuation.full}
      aside={state ? <DepartedState state={state} /> : null}
      detail={`${continuationPresenceLine(continuation.kind, sessions)}${
        target ? ` ${target.title} is where it carried on.` : ''
      }`}
      actions={
        <>
          {target && (
            <Button type="button" size="sm" className="h-[26px]" onClick={() => onOpen(target)}>
              Open {issueDisplayRef(target)}
            </Button>
          )}
          {finished ? (
            <Button type="button" variant="outline" size="sm" className="h-[26px]" onClick={onTuck}>
              <ArrowDown size={12} aria-hidden="true" /> Tuck away
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-[26px]"
              title={`Record this task as done — the work carried on in ${
                target ? issueDisplayRef(target) : 'another task'
              } — and tuck it down into Closed.`}
              onClick={onTuck}
            >
              <Check size={12} aria-hidden="true" /> Done &amp; tuck
            </Button>
          )}
        </>
      }
    />
  )
}

/**
 * THE MISSION'S BRIEF, SET AS PROSE (POD-1455).
 *
 * The header's one paragraph used to be a `<p>` of `shell-type-secondary` —
 * 12px on a 16px line box — carrying the description exactly as typed. Two
 * things were wrong with that and both were visible in the same screenshot.
 *
 * The STRUCTURE was thrown away. Briefs in this product are written the way the
 * product is used: a lead-in line, a blank line, then a list of things to make
 * sure of. Collapsed into one run, `make sure: - agents count is based on "now"`
 * reads as a sentence with stray hyphens in it, and the operator has to re-parse
 * in their head a shape the author had already given them. It is rendered now —
 * breaks, paragraphs, lists, emphasis — through {@link renderReadoutMarkdown},
 * which is the transcript's renderer with every anchor dropped: this block sits
 * beside the mission's own click target, so a link in it is either dead or a
 * second thing to hit by accident.
 *
 * And the SETTING was a caption's, not a paragraph's. 12/16 is 1.33 leading,
 * which is the density of a table cell; the `leading-[1.6]` on the element never
 * applied, because `.shell-type-secondary` is unlayered CSS and Tailwind's
 * utilities live in a layer that unlayered rules outrank. `chat-md` is the
 * shell's own answer for a block somebody actually reads (13.5/23), it is
 * already the register the pinned brief and the transcript are set in, and it
 * brings the list and emphasis rules with it rather than restating them here.
 *
 * THE CUTOFF BELONGS TO THE DECK, NOT THE WINDOW. The automatic position is a
 * fraction of this scrollport, clamped so a short screen keeps enough roster in
 * view. Dragging the ending rule stores that fraction once for this device and
 * applies it to every mission. A laptop and a phone do not inherit each other's
 * geometry, and changing tasks never resets the operator's choice.
 */
const BRIEF_DEFAULT_CUTOFF_RATIO = 0.4
const BRIEF_MIN_HEIGHT = 46
const BRIEF_ROSTER_RESERVE = 192
const BRIEF_KEYBOARD_STEP = 12

interface BriefMetrics {
  readonly deckHeight: number
  readonly briefTop: number
  readonly endGap: number
  readonly contentHeight: number
}

interface BriefCutoffLayout {
  readonly ratio: number
  readonly minRatio: number
  readonly maxRatio: number
  readonly limit: number
  readonly maxLimit: number
}

const clampBriefRatio = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * Read only after the browser's layout, in ResizeObserver delivery. Reading
 * these boxes during the commit forces layout of the entire new mission tree
 * (POD-5106), even though the brief needs just four numbers. Null when the deck
 * has no box yet.
 */
function readBriefMetrics(el: HTMLElement | null, end: HTMLElement | null): BriefMetrics | null {
  const deck = el?.closest<HTMLElement>('[data-testid="flight-deck-scroller"]')
  if (!el || !end || !deck) return null
  const deckRect = deck.getBoundingClientRect()
  if (deckRect.height <= 0) return null
  const briefRect = el.getBoundingClientRect()
  const endRect = end.getBoundingClientRect()
  return {
    deckHeight: deckRect.height,
    briefTop: briefRect.top - deckRect.top,
    endGap: Math.max(0, endRect.top - briefRect.bottom),
    contentHeight: el.scrollHeight,
  }
}

/** Store a reading unless every number matches, so a settling watcher cannot loop the render. */
function publishBriefMetrics(
  setMetrics: (update: (current: BriefMetrics | null) => BriefMetrics | null) => void,
  next: BriefMetrics,
): void {
  setMetrics((current) =>
    current &&
    current.deckHeight === next.deckHeight &&
    current.briefTop === next.briefTop &&
    current.endGap === next.endGap &&
    current.contentHeight === next.contentHeight
      ? current
      : next,
  )
}

/** A missing or corrupt value means "keep adapting automatically". */
export function readBriefCutoff(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && value < 1 ? value : null
}

export function writeBriefCutoff(value: number | null): string | null {
  return value === null ? null : clampBriefRatio(value, 0.01, 0.99).toFixed(4)
}

/**
 * Resolve the divider first, then turn that position into the brief's max height.
 * The divider is what the operator sees and drags, so its ratio is the durable
 * value. Brief text begins lower when a title wraps, without moving the saved
 * boundary or stealing the task space below it.
 */
export function briefCutoffLayout(
  metrics: BriefMetrics,
  preferredRatio: number | null,
): BriefCutoffLayout {
  const { deckHeight, briefTop, endGap, contentHeight } = metrics
  const minimumBrief = Math.min(BRIEF_MIN_HEIGHT, contentHeight)
  const minimumDivider = Math.min(deckHeight, briefTop + minimumBrief + endGap)
  const maximumDivider = Math.max(minimumDivider, deckHeight - BRIEF_ROSTER_RESERVE)
  const minRatio = minimumDivider / deckHeight
  const maxRatio = Math.min(1, maximumDivider / deckHeight)
  const ratio = clampBriefRatio(preferredRatio ?? BRIEF_DEFAULT_CUTOFF_RATIO, minRatio, maxRatio)
  return {
    ratio,
    minRatio,
    maxRatio,
    limit: Math.max(0, ratio * deckHeight - briefTop - endGap),
    maxLimit: Math.max(0, maximumDivider - briefTop - endGap),
  }
}

function MissionBrief({ html, standing }: { html: string; standing?: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const activePointerRef = useRef<number | null>(null)
  const [savedRatio, setSavedRatio] = usePersistedUiState<number | null>(
    FLIGHT_DECK_BRIEF_CUTOFF_KEY,
    readBriefCutoff,
    writeBriefCutoff,
  )
  const [previewRatio, setPreviewRatio] = useState<number | null>(null)
  const [metrics, setMetrics] = useState<BriefMetrics | null>(null)
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState(false)
  const layout = metrics ? briefCutoffLayout(metrics, previewRatio ?? savedRatio) : null
  const clipped = Boolean(layout && metrics && metrics.contentHeight - layout.limit > 1)
  const resizable = Boolean(metrics && metrics.contentHeight > BRIEF_MIN_HEIGHT + 1)
  const expandedLimit = layout && metrics ? Math.min(metrics.contentHeight, layout.maxLimit) : null
  const maxHeight = open ? expandedLimit : layout?.limit

  // A different mission is a different brief: whatever the operator opened, it
  // was not this one. Same shape as the measure below — the dependency is the
  // trigger, not a value the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dependency is the trigger, not a value the effect reads
  useEffect(() => setOpen(false), [html])
  // The observer delivers after layout, so the rect/scrollHeight reads do not
  // force the newly committed mission tree through synchronous layout. A new
  // brief needs a fresh initial delivery even when both ancestor boxes kept
  // their size (a clipped brief can change without resizing the header).
  // Observe the inputs, not the body whose max-height this measurement writes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: html triggers a fresh observation of content in the same nodes
  useLayoutEffect(() => {
    const el = ref.current
    const deck = el?.closest<HTMLElement>('[data-testid="flight-deck-scroller"]')
    const header = el?.closest<HTMLElement>('.deck-header')
    if (!el || !deck || !header) return
    const measure = (): void => {
      const next = readBriefMetrics(ref.current, endRef.current)
      if (next) publishBriefMetrics(setMetrics, next)
    }
    if (typeof ResizeObserver === 'undefined') {
      // rAF alone is still before layout. The task it queues runs after that
      // frame; cancel both stages when another brief replaces this one.
      let timer: ReturnType<typeof setTimeout> | undefined
      const frame = requestAnimationFrame(() => {
        timer = setTimeout(measure, 0)
      })
      return () => {
        cancelAnimationFrame(frame)
        clearTimeout(timer)
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    observer.observe(deck)
    return () => observer.disconnect()
  }, [html])

  const onRulePointerDown = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (
      !layout ||
      !metrics ||
      !resizable ||
      event.button !== 0 ||
      !event.isPrimary ||
      activePointerRef.current !== null
    )
      return
    event.preventDefault()
    const handle = event.currentTarget
    const deck = ref.current?.closest<HTMLElement>('[data-testid="flight-deck-scroller"]')
    if (!deck) return
    const deckRect = deck.getBoundingClientRect()
    const handleRect = handle.getBoundingClientRect()
    const grabOffset = event.clientY - handleRect.top
    const pointerId = event.pointerId
    let latestRatio = layout.ratio
    let moved = false
    let settled = false
    handle.setPointerCapture(pointerId)
    activePointerRef.current = pointerId
    setDragging(true)

    const move = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== pointerId) return
      moved = true
      const dividerTop = pointer.clientY - grabOffset - deckRect.top
      latestRatio = clampBriefRatio(
        dividerTop / metrics.deckHeight,
        layout.minRatio,
        layout.maxRatio,
      )
      setOpen(false)
      setPreviewRatio(latestRatio)
    }
    const cleanup = (commit: boolean): void => {
      if (settled) return
      settled = true
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', cancel)
      handle.removeEventListener('lostpointercapture', lostCapture)
      activePointerRef.current = null
      if (commit && moved) setSavedRatio(latestRatio)
      setPreviewRatio(null)
      setDragging(false)
    }
    const finish = (pointer: PointerEvent): void => {
      if (pointer.pointerId === pointerId) cleanup(true)
    }
    const cancel = (pointer: PointerEvent): void => {
      if (pointer.pointerId === pointerId) cleanup(false)
    }
    const lostCapture = (pointer: PointerEvent): void => {
      if (pointer.pointerId === pointerId) cleanup(false)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', cancel)
    handle.addEventListener('lostpointercapture', lostCapture)
  }

  const onRuleKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>): void => {
    if (!layout || !metrics || !resizable) return
    if (event.key === 'Escape' && savedRatio !== null) {
      event.preventDefault()
      setSavedRatio(null)
      setPreviewRatio(null)
      setOpen(false)
      return
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const step =
      (event.shiftKey ? BRIEF_KEYBOARD_STEP * 3 : BRIEF_KEYBOARD_STEP) / metrics.deckHeight
    const next =
      event.key === 'Home'
        ? layout.minRatio
        : event.key === 'End'
          ? layout.maxRatio
          : clampBriefRatio(
              layout.ratio + (event.key === 'ArrowUp' ? -step : step),
              layout.minRatio,
              layout.maxRatio,
            )
    setOpen(false)
    setSavedRatio(next)
  }

  return (
    <>
      <div
        ref={ref}
        // One mission header is on screen at a time, so the id is unambiguous —
        // and the toggle needs one to say what it expands.
        id="deck-brief-body"
        className="deck-brief chat-md"
        data-testid="deck-brief"
        data-clipped={clipped && !open ? 'true' : undefined}
        data-open={open ? 'true' : undefined}
        data-resizing={dragging ? 'true' : undefined}
        data-standing={standing ? 'true' : undefined}
        // OPEN TRAVELS TO A MEASURED NUMBER, not to a keyword: `max-height: none`
        // does not animate at all, and a cap far above the content eases across
        // space the text does not occupy. The open state stops at the same
        // absolute divider bound as dragging, preserving the roster reserve.
        style={maxHeight === null || maxHeight === undefined ? undefined : { maxHeight }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderReadoutMarkdown sanitizes through DOMPurify and drops every anchor
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {/* THE BRIEF ENDS ON A LINE. Without one it dissolved into the mission's
          controls: a faded tail and then a row of chips, with nothing saying
          whether the paragraph had finished or merely stopped. The rule starts
          on the header's own 16px datum in every state — which is why the
          toggle takes the RIGHT end rather than the left, where a word would
          push the line off the datum the title and the text share. */}
      <div ref={endRef} className="deck-brief-end" data-resizable={resizable ? 'true' : undefined}>
        {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useAriaPropsSupportedByRole: the separator role and its ARIA values are enabled together for the resize handle */}
        <span
          className="deck-brief-rule"
          role={resizable ? 'separator' : undefined}
          aria-hidden={resizable ? undefined : true}
          aria-orientation={resizable ? 'horizontal' : undefined}
          aria-label={resizable ? 'Resize mission brief' : undefined}
          aria-valuemin={resizable && layout ? Math.round(layout.minRatio * 100) : undefined}
          aria-valuemax={resizable && layout ? Math.round(layout.maxRatio * 100) : undefined}
          aria-valuenow={resizable && layout ? Math.round(layout.ratio * 100) : undefined}
          aria-valuetext={
            resizable && layout
              ? `${savedRatio === null ? 'Automatic cutoff' : 'Saved cutoff'} at ${Math.round(layout.ratio * 100)}% of the Flight Deck`
              : undefined
          }
          tabIndex={resizable ? 0 : undefined}
          data-dragging={dragging ? 'true' : undefined}
          title={
            resizable
              ? 'Drag to resize. Use arrow keys to adjust or Escape to restore automatic sizing.'
              : undefined
          }
          onPointerDown={onRulePointerDown}
          onKeyDown={onRuleKeyDown}
        />
        {(clipped || open) && (
          <button
            data-pressable
            type="button"
            className="deck-brief-more"
            data-testid="deck-brief-more"
            aria-expanded={open}
            aria-controls="deck-brief-body"
            onClick={() => setOpen((was) => !was)}
          >
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </>
  )
}

/**
 * A CLOSED MISSION WITH NOBODY LEFT ON IT (POD-1268).
 *
 * The other ending. Work that carried on elsewhere gets {@link ContinuationCard}
 * — a destination and a way back to it — but work that simply ENDED here used
 * to get `presenceNote`'s bare status line ("Cancelled · session retired") in
 * faint grey, floating alone in an otherwise empty column. Two things are wrong
 * with that: it reads as a caption on nothing, and the one decision left on the
 * task — put it away — was nowhere on this screen, so the operator had to go
 * find the row in the sidebar to act on what the deck had just told them.
 *
 * So the same box says it, in the same slot, with the fold attached. The two
 * ways a mission can be over now read as one family.
 *
 * THE TUCK IS DIRECT, never {@link ContinuationCard}'s "Done & tuck": this card
 * draws only where `presenceNote` reached `done`, which it reaches only through
 * `issueClosed`. There is no ending left to record, so `issues.setTucked` cannot
 * refuse it and the button may promise the plain fold.
 */
export function RetiredSignpost({
  abandoned,
  onTuck,
}: {
  /** Cancelled or won't-fix rather than completed — the one word that changes.
   *  "Finished" over a task the operator withdrew would be the deck telling a
   *  small lie about their own decision. */
  abandoned: boolean
  onTuck: () => void
}): JSX.Element {
  return (
    <SignpostBox
      testId="flight-retired"
      icon={abandoned ? <X size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
      headline={abandoned ? 'This task was cancelled.' : 'This task is finished.'}
      detail="No session remains on it. Tuck it away to fold it into Closed."
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-[26px]"
          title="Tuck this finished task down into Closed — it stays reachable there (click to reopen, or start an agent to pick it back up). Nothing is killed or closed."
          onClick={onTuck}
        >
          <ArrowDown size={12} aria-hidden="true" /> Tuck away
        </Button>
      }
    />
  )
}

/**
 * THE DECK WHILE ITS MISSION IS STILL ARRIVING (POD-1139).
 *
 * A LOAD, NOT A STATE — and therefore WORDLESS. The session already carries an
 * `issueId`: the composer's spawn paints the draft vessel and the session
 * together (`optimisticDraftIssue` / `optimisticStartingSession`), so a root
 * exists and this column is only waiting for the selection to catch up. What
 * follows is a real tree a beat later, so anything written here is a sentence
 * the operator watches get taken away.
 *
 * ONE TASK, ONE SESSION — not `EmptyDeck`'s four rows. That ghost teaches the
 * shape of the pane to someone who has never loaded it; this one stands in for
 * a specific tree that is exactly one strip deep, and a ghost that COLLAPSES on
 * resolve reads worse than no ghost at all.
 */
export function SettlingDeck(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="flight-settling">
      <GhostPreview
        className="mt-6 flex flex-none flex-col gap-[15px] pr-6"
        testId="flight-ghost-settling"
      >
        <GhostTaskRow tier={1} />
        <div className="relative flex flex-col gap-[15px]">
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--success)" width="46%" tier={2} meta={22} />
        </div>
      </GhostPreview>
    </div>
  )
}

/**
 * THE DECK BEHIND A SHELL (POD-1139).
 *
 * A shell reaches this column for real and durably: "New Shell" in the panel
 * menu creates a session with no `issueId` and no draft vessel, and it lands in
 * pane A like any other panel. It used to inherit the agent intake canvas,
 * which told the operator that "the agent will organize this workspace as you
 * talk" over a bash prompt that will do nothing of the kind.
 *
 * So it says the shell thing instead, in the shape `standbyCopy` already uses
 * for this exact case ("A shell keeps no transcript"): state the limit, then
 * point at where the answer actually is. The ghost stays — the column is still
 * a task tree, and picking one is what fills it.
 */
function ShellDeck(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="flight-shell">
      <div className="flex-none px-[26px] pt-6 pr-11">
        <h2 className="shell-type-column-title font-semibold tracking-[-.02em] text-text-strong">
          A shell joins no task
        </h2>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground text-pretty">
          This pane runs commands beside the work, not on it. Pick a task on the left to see the
          agents on it here.
        </p>
      </div>
      <GhostPreview
        className="mt-6 flex min-h-0 flex-1 flex-col gap-[15px] pr-6"
        fadeTo="92%"
        testId="flight-ghost-shell"
      >
        <GhostTaskRow tier={1} />
        <div className="relative flex flex-col gap-[15px]">
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--ghost-3)" width="52%" tier={3} />
        </div>
        <GhostTaskRow tier={3} />
      </GhostPreview>
    </div>
  )
}

/**
 * A dead session row, hung under a ghost task at the tree's own indent.
 *
 * The DOT IS THE POINT. Two coloured dots — one working, one waiting on you —
 * are the fastest way for this column to say "I am a status readout" before
 * there is any status to read. They take the semantic status tokens and nothing
 * else: never an issue colour, the same rule the live rows follow, because a
 * hue that means "stage" in one row and "which task" in another means neither.
 */
function GhostSessionRow({
  tone,
  width,
  tier,
  meta,
}: {
  tone: string
  width: string
  tier: 1 | 2 | 3 | 4
  meta?: number
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5" style={{ paddingLeft: GUTTER + DEPTH_STEP }}>
      <GhostDot tone={tone} />
      <GhostBar tier={tier} width={width} height={8} />
      {meta !== undefined && <GhostBar tier={4} width={`${meta}px`} height={8} />}
    </div>
  )
}

/** A dead task strip: fold square, id chip, title, and the meta a live strip
 *  carries on its right. */
function GhostTaskRow({
  tier,
  dashed,
}: {
  tier: 1 | 2 | 3 | 4
  /** The last row stands for a PROPOSED task — the deck's own dashed id chip.
   *  Proposals are part of what this pane is for, so the ghost says so. */
  dashed?: boolean
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5" style={{ paddingLeft: GUTTER }}>
      {dashed ? (
        <span className="block h-[13px] w-[34px] flex-none rounded-[4px] border border-dashed border-(--ghost-1)" />
      ) : (
        <>
          <GhostSquare tier={tier} className="rounded-[2px]" />
          <GhostBar tier={tier} width="34px" height={13} className="flex-none" />
        </>
      )}
      <GhostBar tier={(tier + 1) as 1 | 2 | 3 | 4} height={9} className="min-w-0 flex-1" />
      {!dashed && <GhostBar tier={4} width="14px" height={9} className="flex-none" />}
    </div>
  )
}

/**
 * THE DECK WITH NO MISSION IN IT (POD-1058, "ADE Empty States" 2a/2b).
 *
 * A GHOST TREE, NOT A GHOST STREAM. What this column is — `buildFlightDeckRows`
 * — is a tree of tasks with their agent sessions hanging under them, plus the
 * proposals they throw off. It is not a message log and not a diff feed; those
 * live in the panel. So the ghost draws two task strips with sessions under a
 * guide line and one dashed proposal, at the tree's real indents (GUTTER,
 * DEPTH_STEP), and a reader who has never seen a loaded deck still learns the
 * shape.
 *
 * NO BUTTON, AND NO HEADER TITLE. The work list and the composer own both ways
 * in; a third one here would be a third thing to explain.
 *
 * With no mission selected, keep the deck focused on how to start or select
 * a task. Repository sessions without a task do not belong in this view.
 */
function EmptyDeck(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="flight-empty">
      <div className="flex-none px-[26px] pt-6 pr-11">
        <h2 className="shell-type-column-title font-semibold tracking-[-.02em] text-text-strong">
          Every agent, in one tree
        </h2>
        {/* Names BOTH ways in, like the work list: picking a task is the
            everyday case, starting one is the first-run case. */}
        <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground text-pretty">
          Pick a task on the left or start a new one. You’ll see the agents on it, what each is
          doing, and the follow-ups they propose.
        </p>
      </div>
      <GhostPreview
        className="mt-6 flex min-h-0 flex-1 flex-col gap-[15px] pr-6"
        fadeTo="92%"
        testId="flight-ghost-tree"
      >
        <GhostTaskRow tier={1} />
        <div className="relative flex flex-col gap-[15px]">
          {/* The guide line the live tree draws, on the live tree's own rail —
              a ghost that mirrors the component it stands in has to land on the
              same x, or the first real row will visibly step sideways. */}
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--success)" width="46%" tier={2} meta={22} />
          <GhostSessionRow tone="var(--attention)" width="60%" tier={3} />
        </div>
        <GhostTaskRow tier={3} />
        <div className="relative flex flex-col gap-[15px]">
          <span
            className="absolute w-px bg-(--ghost-4)"
            style={{ left: GUTTER + RAIL_INSET, top: -6, bottom: 9 }}
          />
          <GhostSessionRow tone="var(--ghost-3)" width="52%" tier={4} />
        </div>
        <GhostTaskRow tier={4} dashed />
      </GhostPreview>
    </div>
  )
}

export interface FlightDeckProps {
  onCollapse: () => void
  display?: FlightDeckDisplay
  onDisplayChange?: (display: FlightDeckDisplay) => void
}
/** The views the bar offers on this install. */
export type FlightDeckModes = Array<{ id: FlightDeckView; label: string }>
/** Lookups through the opening's reader, plus the pool-backed menu and archive. */
export interface FlightDeckSource {
  issue: (id: string) => IssueNavigationModel | undefined
  /** Open menus need metadata and counts, without the full navigation roster. */
  menuIssue?: (id: string) => IssueNavigationModel | undefined
  session: (id: string) => SessionView | undefined
  rootFor: (id: string) => string | null
  attached: (id: string) => readonly SessionView[]
  IssueMenu: import('react').ComponentType<
    Omit<import('react').ComponentProps<typeof IssueContextMenu>, 'poolInputs'>
  >
  /** Reads a mission's archived list while mounted (the open section). */
  ArchivedSessions: (props: {
    rootId: string
    mode: FlightDeckMode
    children: (sessions: readonly SessionView[]) => ReactNode
  }) => ReactNode
}

export function FlightDeck(props: FlightDeckProps): JSX.Element {
  const developmentEnabled = useFeature('podium-development')
  // Keep an experimental choice dormant while its gate is off. Re-enabling the
  // gate restores the operator's last view without making unfinished UI leak
  // into an ordinary install.
  const modes = developmentEnabled ? [...MODES, WATERFALL_MODE, TIMELINE_MODE] : MODES
  return <PoolFlightDeck {...props} development={developmentEnabled} modes={modes} />
}

/** The column with no mission on screen: what the focused session says. */
export function MissionlessDeck({
  onCollapse,
  focus,
}: {
  onCollapse: () => void
  focus: 'shell' | 'settling' | 'none'
}): JSX.Element {
  return (
    <aside className="engraved-column relative" aria-label="Flight Deck">
      <Button
        variant="ghost"
        size="icon-sm"
        className="deck-eyebrow-chevron absolute top-1 right-2 z-20 size-6 flex-none text-text-faint"
        aria-label="Collapse Flight Deck"
        title="Collapse Flight Deck"
        onClick={onCollapse}
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </Button>
      {focus === 'shell' ? (
        // A shell will never become a task, so it never gets agent words.
        <ShellDeck />
      ) : focus === 'settling' ? (
        // The session already knows its task; only the selection is behind. A
        // load, so a ghost — never a sentence the resolve then contradicts.
        <SettlingDeck />
      ) : (
        <EmptyDeck />
      )}
    </aside>
  )
}

/** The eyebrow: status, reference, stage, the root's note and seat. */
const DeckEyebrow = observer(function DeckEyebrow({
  screen,
  onPickStatus,
  collapse,
}: {
  screen: MissionScreen
  onPickStatus: (value: string) => void
  collapse: ReactNode
}): JSX.Element {
  const note = screen.note
  const seat = screen.rootRow ? seatFor(screen.presence) : null
  return (
    <div className="shell-type-micro flex min-h-9 flex-wrap items-center gap-x-1.5 py-1.5 pr-2 pl-4 font-mono text-text-dim">
      {/* Identity NEVER shrinks and never leaves line 1: the glyph, the
        ref and the stage word are what this row is for. */}
      <IssueStatusPicker issue={screen.rootStatus} onPick={onPickStatus} />
      <span className="flex-none leading-[24px]">{screen.rootRef}</span>
      <span className="flex-none leading-[24px]">
        {STAGE_LABELS[screen.rootStage].toLowerCase()}
      </span>
      <span aria-hidden className="min-w-[8px] flex-1" />
      {/* The mission's own dependency or provenance, and the seat it is
        holding if nobody is on it — in the same chips a strip wears.
        The header IS a node, so it says what a node says, in the same
        slot: a strip carries these on its right, and so does this. */}
      {(note || seat) && (
        <span className="deck-eyebrow-note flex min-w-0 shrink items-center gap-1.5 pl-2">
          {note && <IssueNoteChip note={note} />}
          {seat && <SeatChip note={seat} />}
        </span>
      )}
      {collapse}
    </div>
  )
})

/** The one title in the column. */
const DeckTitle = observer(function DeckTitle({
  screen,
  onPress,
  onCommit,
}: {
  screen: MissionScreen
  onPress: () => void
  onCommit: () => void
}): JSX.Element {
  return (
    <button
      data-pressable
      type="button"
      className="block w-full min-w-0 text-left"
      // The header IS the root's strip (round 3 §4), so it takes the
      // strips' gesture: preview once, promote twice.
      onClick={onPress}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        onCommit()
      }}
      title={`Focus ${screen.rootRef}`}
    >
      {/* The one title in the column, and the only place in the shell
        that outgrows the `reading` role: everything under it is a
        scanned list, so the mission's name is allowed to be read
        from across the desk. 17px is the artifact's own measure. */}
      <h2 className="shell-type-column-title font-semibold text-text-strong">
        {screen.rootTitle}
      </h2>
    </button>
  )
})

/**
 * The header's one paragraph, resolved and rendered in one place (POD-1455).
 *
 * The fall-through is the old one — the operator's own words, then the agent's
 * latest note, then the column's standing sentence — and all three go through
 * the same renderer: a status note is written in the same voice a description
 * is, and a fixed sentence with no markup in it renders as itself.
 */
const DeckBrief = observer(function DeckBrief({
  screen,
  focusedSessionId,
}: {
  screen: MissionScreen
  focusedSessionId: string | null
}): JSX.Element {
  const rootSessionId = screen.rootLeadSessionId ?? focusedSessionId ?? undefined
  const draftFilling = Boolean(screen.rootDraftVessel && rootSessionId)
  const rootDraft = useDraftValue(draftFilling ? rootSessionId : undefined)
  const authoredBrief = draftFilling ? '' : screen.rootAuthoredBrief
  const briefText =
    authoredBrief ||
    (draftFilling
      ? rootDraft
        ? 'Your first prompt is taking shape. This mission will fill in as the conversation develops.'
        : 'Start with a message. The mission, plan, and team will fill in here as the agent learns what you need.'
      : 'Mission work, agents, and dependencies in one live execution view.')
  const briefHtml = useMemo(() => renderReadoutMarkdown(briefText), [briefText])
  return <MissionBrief html={briefHtml} standing={!authoredBrief} />
})

/** The gauge, the price and the mission's one action, on one baseline. */
const DeckGaugeRow = observer(function DeckGaugeRow({
  screen,
  onOpenInExplorer,
  onAdd,
}: {
  screen: MissionScreen
  onOpenInExplorer: () => void
  onAdd: (agentKind?: IssueAgentKind) => Promise<void>
}): JSX.Element {
  const target = screen.rootAgentTarget
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <div className="min-w-[9rem] flex-[1_1_9rem]">
        <MissionGauge progress={screen.progress} live={screen.liveCount} working={screen.workingCount} />
      </div>
      {/* THE DECK'S ONE PRICE (POD-1862). One more object in this
        row, so it inherits the wrap above rather than adding a drop
        rung of its own, and it renders NOTHING at all until there
        is a figure — see {@link MissionCostChip}. Its last line
        takes the header's own promotion, because "open in explorer"
        and a double click on the header are the same request. */}
      {screen.rootRow && (
        <MissionCostChip
          key={`cost:${screen.rootId}`}
          issueId={screen.rootId as IssueId}
          onOpenInExplorer={onOpenInExplorer}
        />
      )}
      {screen.rootClosable && (
        <DeckAgentMenu
          key={`agent-menu:${screen.rootId}`}
          screen={screen}
          defaultAgent={target.defaultAgent}
          repoPath={target.repoPath}
          machineId={target.machineId}
          onAdd={onAdd}
        />
      )}
    </div>
  )
})

/** The agent menu reads the hosts a root can run on only while it is drawn. */
const DeckAgentMenu = observer(function DeckAgentMenu({
  screen,
  ...props
}: Omit<MissionAgentMenuProps, 'poolHosts'> & { screen: MissionScreen }): JSX.Element {
  return <MissionAgentMenu {...props} poolHosts={screen.agentHosts} />
})

/** The timeline view: the opening's handoff answer and review-return counts. */
const HandoffDeck = observer(function HandoffDeck({
  screen,
  source,
  visitReadAt,
  proposed,
  onOpenTranscript,
  onOpenSession,
  onOpenIssue,
}: {
  screen: MissionScreen
  source: FlightDeckSource
  visitReadAt: string | null
  proposed: ReactNode
  onOpenTranscript: (sessionId: SessionId, itemKey: string) => void
  onOpenSession: (issueId: IssueId, sessionId: SessionId) => void
  onOpenIssue: (issueId: IssueId) => void
}): JSX.Element | null {
  const handoff = screen.reader.handoff(screen.rootId)
  const root = screen.reader.issue(screen.rootId)
  if (handoff === LOADING || !root || root === LOADING) return null
  return (
    <FlightDeckHandoff
      rootIssue={root}
      poolValues={handoff}
      issue={source.issue}
      reviewReturns={screen}
      lookupSession={source.session}
      visitReadAt={visitReadAt}
      onOpenTranscript={onOpenTranscript}
      onOpenSession={onOpenSession}
      onOpenIssue={onOpenIssue}
      proposed={proposed}
    />
  )
})

/** The waterfall draws the visible rows with their displayed titles. */
const WaterfallDeck = observer(function WaterfallDeck({
  screen,
  ...props
}: Omit<ComponentProps<typeof FlightDeckWaterfall>, 'rootRow' | 'rows' | 'displayTitles' | 'mode'> & {
  screen: MissionScreen
}): JSX.Element | null {
  const rootRow = screen.rootRow
  const rows = screen.visibleRows as MissionDeckIssueModel[]
  const displayTitles = new Map(screen.rows.map((row) => [row.id, row.title]))
  return rootRow ? (
    <FlightDeckWaterfall {...props} rootRow={rootRow} rows={rows} displayTitles={displayTitles} mode={screen.mode} />
  ) : null
})

/** The opened mission's archive: a count, and the list while it is open. */
const DeckArchive = observer(function DeckArchive({
  screen,
  source,
  revealSessionId,
  scrollRef,
  scrollKey,
  activeSessionId,
  onSelect,
}: {
  screen: MissionScreen
  source: FlightDeckSource
  revealSessionId: string | null
  scrollRef: RefObject<HTMLElement | null>
  scrollKey: string
  activeSessionId: string | null
  onSelect: (session: SessionView, opts: { permanent: boolean; native?: boolean }) => void
}): JSX.Element | null {
  const archivedCount = screen.archivedCount
  const archivedOpen = screen.archivedOpen
  const ArchivedSessions = source.ArchivedSessions
  if (archivedCount <= 0) return null
  return (
    <DeckSection label="Archived" className="mt-6" testId="flight-archived">
      <button
        data-pressable
        type="button"
        data-testid="flight-archived-toggle"
        aria-expanded={archivedOpen}
        className="shell-type-micro flex min-h-6 w-full items-center gap-1.5 rounded-md text-left font-mono text-text-faint hover:text-text-dim"
        onClick={() => screen.setArchivedOpen(!archivedOpen)}
      >
        <Archive size={11} aria-hidden className="flex-none" />
        <span className="truncate">
          {archivedOpen
            ? 'Hide archived'
            : `${archivedCount} archived session${archivedCount === 1 ? '' : 's'}`}
        </span>
      </button>
      {archivedOpen && (
        <ArchivedSessions rootId={screen.rootId} mode={screen.mode}>
          {(archivedSessions) => (
            <DeckFlatRows
              revealSessionId={revealSessionId}
              className="mt-1 flex flex-col gap-0.5"
              gap={2}
              scrollRef={scrollRef}
              scope={`${screen.rootId}:archived:${scrollKey}`}
              rows={archivedSessions.map((session) => ({
                key: `archived:${session.sessionId}`,
                size: 48,
                text: sessionSearchText(session),
              }))}
            >
              {(index) => {
                const session = archivedSessions[index]!
                return (
                  <SessionRow
                    key={session.sessionId}
                    session={session}
                    active={activeSessionId === session.sessionId}
                    last
                    flat
                    onOpen={(permanent) => onSelect(session, { permanent })}
                    onOpenNative={() => onSelect(session, { permanent: false, native: true })}
                  />
                )
              }}
            </DeckFlatRows>
          )}
        </ArchivedSessions>
      )}
    </DeckSection>
  )
})

/** The root's close guard, read only while the signpost asks for it. */
const RootCloseDialog = observer(function RootCloseDialog({
  screen,
  onOpenChange,
  onConfirm,
}: {
  screen: MissionScreen
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): JSX.Element | null {
  const issue = screen.reader.issue(screen.rootId)
  if (!issue || issue === LOADING) return null
  return (
    <IssueCloseDialog
      issue={issue}
      sessions={[]}
      reason="done"
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
    />
  )
})

/**
 * One opened mission. The view model holds the mission's UI state and derived
 * lists; this component wires the gestures and lays the sections out, each of
 * which reads only the fields it shows.
 */
export const FlightDeckContent = observer(function FlightDeckContent({
  onCollapse,
  display = 'compact',
  onDisplayChange = () => {},
  screen,
  source,
  modes,
}: FlightDeckProps & {
  screen: MissionScreen
  source: FlightDeckSource
  modes: FlightDeckModes
}): JSX.Element {
  const view = screen.view
  const mode = screen.mode
  const folds = screen.folds
  const IssueMenu = source.IssueMenu
  const rootId = screen.rootId

  const {
    paneA,
    paneB,
    split,
    setSelectedWorktree,
    setSelectedIssueId,
    openSessionTab,
    openSessionAtTranscript,
    issueVisitBaseline,
    focusIssueSession,
    setPanelMode,
    preferPanelMode,
    setView,
    markIssueRead,
    markSessionRead,
    setIssueTucked,
    closeIssue,
    updateIssue,
    trpc,
  } = useRuntimeSelector(
    (store) => ({
      paneA: store.paneA,
      paneB: store.paneB,
      split: store.split,
      setSelectedWorktree: store.setSelectedWorktree,
      // POD-679's departure ticks RE-ROOT the deck: a departed spin-off is not a
      // member of this mission any more, so focusing it would resolve to nothing.
      setSelectedIssueId: store.setSelectedIssueId,
      // The deck OPENS TABS now (POD-710 §2) rather than assigning pane A: a
      // preview open and a permanent open are different things, and only the
      // workspace layout can tell them apart. `paneA`/`paneB` below stay as the
      // derived mirrors they now are — this column still reads them to know
      // which session the operator is actually in.
      openSessionTab: store.openSessionTab,
      openSessionAtTranscript: store.openSessionAtTranscript,
      issueVisitBaseline: store.issueVisitBaseline,
      focusIssueSession: store.focusIssueSession,
      setPanelMode: store.setPanelMode,
      preferPanelMode: store.preferPanelMode,
      setView: store.setView,
      markIssueRead: store.markIssueRead,
      markSessionRead: store.markSessionRead,
      setIssueTucked: store.setIssueTucked,
      // The signpost card's own filing action closes an unfinished task before
      // it can be tucked (POD-1212) — the fold is for finished work.
      closeIssue: store.closeIssue,
      updateIssue: store.updateIssue,
      trpc: store.trpc,
    }),
    shallowEqual,
  )
  const { focusedIssueId, setFocusedIssueId } = useOperatorFocus()
  // WHAT THE TASK DOCK IS ACTUALLY SHOWING, so a row can answer for it. The
  // explorer's own stack top — not this column's focus — because the operator
  // may have walked the explorer somewhere else since, and a row that claims to
  // already be open there has to mean the level on screen.
  //
  // THROUGH REFS, read when the click resolves rather than when the row
  // rendered. `TaskRow`'s memo deliberately ignores its handler props, so a
  // strip goes on holding the closure from the render BEFORE the explorer
  // followed the focus — which is exactly the render whose answer is stale.
  const { current: explorerIssueId } = useIssueExplorer()
  const rightPanel = usePersistedUiValue(RIGHT_PANEL_KEY, readRightPanel)
  const explorerIssueRef = useRef(explorerIssueId)
  explorerIssueRef.current = explorerIssueId
  const dockPanelRef = useRef(rightPanel)
  dockPanelRef.current = rightPanel
  useLayoutEffect(() => {
    if (view !== 'waterfall' && display === 'expanded') onDisplayChange('compact')
  }, [display, onDisplayChange, view])
  const headerIntent = useClickIntent()
  const deckScrollerRef = useRef<HTMLElement | null>(null)
  const deckRowsRef = useRef<HTMLDivElement | null>(null)
  const [revealSessionId, setRevealSessionId] = useState<string | null>(null)
  type DeckScrollKey = FlightDeckView
  const scrollKey: DeckScrollKey = view
  const spineView = view !== 'waterfall' && view !== 'handoff'
  const scrollPositionsRef = useRef<Record<DeckScrollKey, number>>({
    full: 0,
    working: 0,
    'needs-you': 0,
    waterfall: 0,
    handoff: 0,
  })
  const previousScrollKeyRef = useRef(scrollKey)
  useLayoutEffect(() => {
    const scroller = deckScrollerRef.current
    const previous = previousScrollKeyRef.current
    if (!scroller || previous === scrollKey) return
    // Scroll events saved the old view before the shorter new DOM could clamp
    // it. Reading scrollTop here would overwrite that position with the clamp.
    scroller.scrollTop = scrollPositionsRef.current[scrollKey]
    previousScrollKeyRef.current = scrollKey
  }, [scrollKey])
  // Every strip's status glyph is a picker (POD-1271). The deck holds the apply
  // and its close guard once; a strip carries the id, and the REPLICA's model is
  // what the guard is handed — the mission tree's own row model is a navigation
  // shape, not the one `issueCloseConcerns` reads.
  const rowStatus = useIssueStatusApply()
  const pickRowStatus = (id: string, value: string): void => {
    const issue = source.issue(id)
    if (issue) rowStatus.pick(issue, value)
  }
  const deck = screen.deck
  const rows = screen.rows
  /**
   * The session the operator is ACTUALLY in.
   *
   * Pane A holds a tab id, and a tab may be a file — its id is not a session
   * identity, so reading `paneA` as one highlighted nothing (or, worse, the
   * wrong thing) whenever a file was open. In split view the session being
   * worked may be the one in pane B.
   */
  const activeSessionId = useFocusedSessionId(paneA, split ? paneB : null)
  // Resolved against the UNFILTERED mission membership, exactly as RightDock
  // does: resolving against the mode-filtered rows let a switch to "Needs you"
  // silently move the highlight — and the Task dock with it — to the root.
  const focused = resolveFocus(focusedIssueId, screen.members, rootId)
  // Every session anywhere in the mission, so a spawn edge can be named ("by
  // Spine designer") and one pointing outside the mission is left unnamed rather
  // than rendered as a raw id.
  const nameOf = useCallback((sessionId: SessionId): string | undefined => {
    const session = source.session(sessionId)
    return session ? sessionDisplayName(session) : undefined
  }, [source])
  /**
   * The mission's own row, which the SPINE NO LONGER PRINTS (round 3 §4).
   *
   * The header above is the root of the tree — its ref, its title, its progress
   * and, hanging directly off it, its own agents. Printing it a second time as
   * the first strip was the duplication the operator asked us to remove.
   *
   * It is therefore also unfoldable: the root's fold used to hide the entire
   * mission, and with no strip to unfold from there would be no way back. The
   * "fold every branch" control below excludes it for the same reason, and the
   * root's sessions consequently always show — which is what §4 asks for.
   *
   * ALL of them, now (POD-758). The roster used to fold its settled agents away
   * behind a count; nothing in this spine is hidden by default any more, and
   * what narrows it is the view bar — a second disclosure inside a view was
   * hiding what that view had just promised to show.
   */
  const rootRow = screen.rootRow
  /**
   * THE CONTINUATION IS A DEPARTURE — the one with an action attached.
   *
   * `missionDepartures` knows nothing about `issueContinuation`, and a
   * continuation target is by construction a started spin-off, so it always
   * qualified as a departure too: the same task rendered once as a card with two
   * buttons and again as a faint mono tick twelve pixels below it, in a
   * different voice. Filtering it out here and promoting it to the first row of
   * the same region is what makes the tail say it once.
   *
   * Its tick's own state comes with it, so folding the two together loses
   * nothing.
   */
  const rootContinuation = screen.continuation
  /**
   * The mission header's roster — content, and therefore the view bar's (POD-1356).
   *
   * It used to be read with `matched` forced true, on the argument that the root
   * is the column's statement of which mission is on screen rather than one of
   * the rows POD-1245 quietened. The statement is the header; the CREW under it
   * is not. Forcing it meant every agent on the mission survived every view, so
   * on a mission with no sub-tasks — most of them — `Full`, `Active` and
   * `Needs you` drew the identical column and the bar looked inert.
   *
   * The sentence that branch was protecting is handled where it belongs: the
   * empty line below now says WHICH view emptied the spine, instead of claiming
   * a fully staffed mission has nobody on it.
   */
  const rootSessions = screen.rootSessionIds
  /**
   * Why the spine is empty, when it is — and the root's OWN sessions answer it,
   * never the view-narrowed `rootSessions`. A "nobody is here" drawn because you
   * filtered the column down to working agents is the POD-1233 bug in a new
   * costume; a parked agent still holds the task and this must keep saying so.
   */
  const rootEmptyNote = screen.presence
  /** `done` is the note's word for "closed, and nobody is on it" — the one
   *  empty-spine state that still has a decision left in it. */
  const rootRetired = rootEmptyNote?.kind === 'done'
  /**
   * PROPOSALS LEAVE THE TREE (POD-710 §4.4) — partitioned by the view model,
   * rendered in their own section, with no rail, no elbow and no indent. A
   * proposal that has somehow acquired sub-tasks stays IN the tree: pulling it
   * out would leave its children hanging off a parent that is no longer there.
   */
  const visibleRows = screen.visibleRows
  const proposedRows = screen.proposedRows
  const query = screen.query
  const searchOpen = screen.searchOpen
  const guides = useMemo(() => treeGuides(visibleRows as MissionDeckIssueModel[]), [visibleRows])
  const leadTone = (issueId: IssueId | undefined): RailTone =>
    !issueId || !deck.model(issueId).hasLead ? null : issueId === rootId ? 'mission' : 'task'
  const railTrail: (string | undefined)[] = [rootId]
  const rails = visibleRows.map(row => {
    railTrail.length = row.depth; railTrail[row.depth] = row.id
    return Array.from({ length: row.depth }, (_, level) => leadTone(railTrail[level] ? asIssueId(railTrail[level]!) : undefined))
  })
  const sessionKeys = screen.crewIds
  const missionSessionIds = screen.inMission
  const { arrivals, settle } = useArrivals(sessionKeys as string[])
  // The virtual list owns estimates and measurements. Presentation text is
  // read only by the row or searchable placeholder that actually draws it.
  const spineGeometry = useMemo(() => {
    const leaves: DeckWindowRow[] = [{ key: 'spine:pad', size: 6 }]
    const blocks = new Map<string, DeckWindowRow[]>()
    const sessionLeaf = (row: MissionDeckIssueModel, id: string): DeckWindowRow => ({
      key: deckSessionKey(row.key, id), get size() { return screen.sessionHeight(id) },
      get text() {
        const session = requireLoaded(row.view.rawSession(id))
        if (!session) return ''
        return sessionSearchText(session, roleLabel(sessionRole(row.roleIssue, session, {
          rootId, siblings: row.sessions, inMission: missionSessionIds,
        }), nameOf), row)
      },
    })
    if (rootRow) for (const id of rootSessions) leaves.push(sessionLeaf(rootRow, id))
    if (rootSessions.length && visibleRows.length) leaves.push({ key: 'spine:gap', size: 8 })
    for (const row of visibleRows) {
      const block: DeckWindowRow[] = [{ key: deckTaskKey(row.key), size: row.stage === 'proposed' ? PROPOSED_BAND : BAND_HEIGHT,
        get text() {
          const issue = row.view.rulesIssue(row.id)!, presentation = row.view.presentation(issue, row.sessions)
          const seat = issue.stage === 'proposed' ? null : seatFor(presentation.presence)
          const folded = row.folded(folds) && row.hasPayload
          const meta = mode !== 'full' && !row.matched ? [] : [presentation.note?.label, presentation.note?.short,
            seat ? (seat.attention ? 'no agent' : 'seat open') : null,
            folded && row.collapsedSummary.tasks ? `${row.collapsedSummary.tasks} task${row.collapsedSummary.tasks === 1 ? '' : 's'}` : null,
            folded && row.descendantIds.length && row.workingAgentCount ? `${row.workingAgentCount} running` : presentation.state.label]
          return [issueDisplayRef(issue), row.title, ...meta].filter(Boolean).join(' ')
        },
      }]
      if (!row.folded(folds)) for (const id of row.sessionIds(mode)) block.push(sessionLeaf(row, id))
      block.push({ key: `padding:${row.key}`, size: 6 })
      blocks.set(row.key, block); leaves.push(...block)
    }
    return { leaves, blocks }
  }, [screen, rootId, rootRow, rootSessions, visibleRows, folds, mode, missionSessionIds, nameOf])
  const spineWindow = useFlightDeckWindow(
    spineView ? spineGeometry.leaves : [],
    deckScrollerRef,
    deckRowsRef,
    rootId,
    view,
  )

  /**
   * REVEAL A SESSION'S ROW (POD-1077) — what the tab menu asks for when the
   * operator wants the verbs a tab deliberately does not carry.
   *
   * Three steps, and skipping any one leaves the reveal a lie:
   *  1. RE-ROOT if the session belongs to another mission, or the deck would
   *     scroll a spine that does not contain it.
   *  2. UNFOLD every ancestor. A row inside a closed fold is not in the DOM at
   *     all, so scrolling to it would silently find nothing — the failure mode
   *     that makes a "reveal" feel broken rather than absent.
   *  3. SCROLL, after paint. The unfold above is a state write, and the row it
   *     creates does not exist until React has rendered it.
   */
  useEffect(() => {
    const onReveal = (event: Event): void => {
      const sessionId = (event as CustomEvent<string>).detail
      if (!sessionId) return
      const target = source.session(sessionId)
      if (!target) return
      const open = new Map(screen.folds)
      if (target.issueId) {
        const owner = source.issue(target.issueId)
        const nextRoot = owner ? source.rootFor(owner.id) : null
        if (nextRoot) setSelectedIssueId(asIssueId(nextRoot))
        setFocusedIssueId(target.issueId)
        // Both a graft and a formal occurrence can contain the same session.
        // Reveal follows the mission's ID ancestry once, including both paths.
        for (const id of screen.deck.ancestorIds(target.issueId)) open.set(id, 'open')
      }
      // A reveal must also escape a narrowed view and a folded owner in another
      // mission. Those ancestors are not necessarily in the current roster.
      const seen = new Set<string>()
      let owner = target.issueId ? source.issue(target.issueId) : undefined
      while (owner && !seen.has(owner.id)) {
        seen.add(owner.id)
        open.set(owner.id, 'open')
        owner = owner.parentId ? source.issue(owner.parentId) : undefined
      }
      screen.setFolds(open)
      if (target.archived) screen.setArchivedOpen(true)
      if (screen.view !== 'full') screen.setView('full')
      setRevealSessionId(sessionId)
    }
    window.addEventListener(REVEAL_IN_DECK_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_IN_DECK_EVENT, onReveal)
  }, [screen, source, setSelectedIssueId, setFocusedIssueId])

  useLayoutEffect(() => {
    if (!revealSessionId || !spineView) return
    const leaf = spineGeometry.leaves.find((row) => row.key.endsWith(`:${revealSessionId}`))
    if (leaf && spineWindow.enabled && !spineWindow.contains(leaf.key)) spineWindow.reveal(leaf.key)
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        deckScrollerRef.current?.querySelectorAll<HTMLElement>('[data-flight-session]') ?? [],
      ).find((node) => node.dataset.flightSession === revealSessionId)
      if (!row) return
      row.scrollIntoView({ block: 'end' })
      setRevealSessionId(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [revealSessionId, spineView, spineGeometry, spineWindow])

  const selectIssue = (row: FlightDeckRow, permanent: boolean): void => {
    // THE SAME ROW CLOSES WHAT IT OPENED (POD-1639). A single click whose task
    // is the one the dock is already showing is the operator asking for the
    // stage back — the first click was the request to see this task, so the
    // second can only be about the panel. The explorer keeps its stack above
    // the dock, so this costs nothing: the next click returns to this level.
    //
    // The PREVIEW click only. A promotion (double click, or the strip menu's
    // Open) is an unambiguous "show me this task" and must never end with the
    // inspector shut.
    const dockShowsThisIssue =
      dockPanelRef.current === 'issue' && explorerIssueRef.current === row.issue.id
    setFocusedIssueId(row.issue.id)
    // A deliberate task pick asks to SEE its inspector, not merely retarget an
    // inspector that happens to be open. Reopen the Task dock even when the
    // operator previously dismissed it; the provider follows the focus update
    // above and retargets the explorer to this issue.
    window.dispatchEvent(
      new CustomEvent(OPEN_RIGHT_PANEL_EVENT, {
        detail: !permanent && dockShowsThisIssue ? CLOSE_RIGHT_PANEL : 'issue',
      }),
    )
    void markIssueRead(row.issue.id)
    if (row.issue.worktreePath) setSelectedWorktree(row.issue.worktreePath)
    const active = row.sessions.filter(
      (session) => (session as SessionModel).open,
    )
    // Contract order: coordinator → lone member → most recently active member →
    // no-session state. The pane you happen to be looking at is NOT a
    // preference — it made clicking one task open a different task's session.
    const target =
      active.find((session) => session.sessionId === row.issue.coordinatorSessionId) ??
      (active.length === 1 ? active[0] : undefined) ??
      [...active].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
    // A sessionless task updates the inspector but leaves the current chat
    // intact. Task creation is never a navigation side effect.
    if (target) {
      openSessionTab(target.sessionId, { permanent })
      void markSessionRead(target.sessionId)
    }
    setView('workspace')
  }
  /**
   * A departure tick is a way BACK to the work, so it re-roots the deck onto it
   * rather than focusing something this mission no longer contains. Selecting
   * an issue outside `missionMembers` would leave the focus resolver with
   * nothing to resolve and the column showing the same spine.
   *
   * Its tab opens PERMANENT, not as a preview (POD-710): re-rooting the whole
   * deck onto another mission is a deliberate departure from this one, not the
   * glance a preview tab exists to serve.
   */
  const openDeparture = (issue: IssueNavigationModel): void => {
    setSelectedIssueId(issue.id)
    setFocusedIssueId(issue.id)
    void markIssueRead(issue.id)
    if (issue.worktreePath) setSelectedWorktree(issue.worktreePath)
    const live = source
      .attached(issue.id)
      .filter((session) => (session as SessionModel).open)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0]
    if (live) {
      openSessionTab(live.sessionId, { permanent: true })
      void markSessionRead(live.sessionId)
    }
    setView('workspace')
  }
  /**
   * THE TASK MENU, HOSTED ONCE (POD-771).
   *
   * One menu for the whole column rather than one per strip: a spine can carry
   * fifty rows, and fifty mounted portals to serve the one the cursor is over is
   * a cost paid on every render of a list that re-renders on every clock tick.
   * The strips report a cursor and an id; this resolves the id against the
   * replica's own issues, because `row.issue` is the deck's navigation
   * projection and the shared menu acts on the full view model.
   */
  const [issueMenu, setIssueMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null)
  const openIssueMenuAt = useCallback((issueId: IssueId, anchor: ContextMenuAnchor): void => {
    setIssueMenu({ id: issueId, anchor })
  }, [])
  const openIssueMenu = useCallback(
    (issueId: IssueId, event: ReactMouseEvent): void => {
      event.preventDefault()
      openIssueMenuAt(issueId, { x: event.clientX, y: event.clientY })
    },
    [openIssueMenuAt],
  )
  const menuIssue = issueMenu ? (source.menuIssue ?? source.issue)(issueMenu.id) : undefined
  /**
   * WHICH STRIP IS RENAMING (POD-1077) — deck state, for the same reason the
   * menu is: the menu is mounted once for the column, so the row it names has to
   * be addressed by id rather than by reaching into that row's own hook.
   *
   * The displayed title is captured at OPEN time (POD-1618). A draft's visible
   * name belongs to its agent and can change while this uncontrolled input is
   * open; the seed must stay equal to what the operator actually saw and edited.
   */
  const [renameTarget, setRenameTarget] = useState<{ id: string; seed: string } | null>(null)
  /**
   * The shared commit policy (POD-407), applied here so no strip carries a
   * second copy: trim, then no-op on empty or unchanged. The no-op is the part
   * that matters — the editor commits on BLUR, so clicking away from an editor
   * opened by accident must not spend a write, a revision bump and a feed entry
   * on a title that did not change.
   */
  const renameIssue = useCallback(
    (issueId: string, next: string, openedTitle: string): void => {
      const trimmed = next.trim()
      const current = source.issue(issueId)?.title
      if (!trimmed || trimmed === current || trimmed === openedTitle.trim()) return
      void updateIssue(issueId, { title: trimmed })
    },
    [source, updateIssue],
  )

  /**
   * FILING THE SIGNPOST AWAY — recording the ending first when there is one
   * still to record (POD-1212).
   *
   * `issues.setTucked` REFUSES an unfinished issue ("issue … is not finished"),
   * and the sidebar's fold predicate reads the same `closedReason`. So on the
   * mission this card exists for — a hopscotch origin standing at `review`, its
   * work carried on in a spin-off, no session left here — the lone "Tuck away"
   * painted a fold the server threw out and the row came straight back. The
   * unfinished task is therefore closed as `done` and THEN tucked.
   *
   * TWO WRITES, ONE PARTITION. Both are queued outbox kinds routed on
   * `issue:<id>` (wiring.ts), which is what makes the pair safe rather than
   * racy: the close is applied before the tuck reaches the guard that reads it.
   * The `.then` chain is the enqueue order, not a round-trip wait.
   *
   * The guard interrupts only when a close would actually raise something —
   * stranded commits, an open sub-task, a standing decision. POD-1129's rule is
   * that every surface must name the SAME concerns, not that every surface must
   * stop to report none: this button already says what it will do, and a dialog
   * that rises to answer "nothing found" is a tax on the ordinary case.
   */
  const rootFinished = screen.rootFinished
  const [signpostClosing, setSignpostClosing] = useState(false)
  const needsCloseGuard = useIssueCloseGuard()
  const closeAndTuckRoot = (): void => {
    setSignpostClosing(false)
    void closeIssue(rootId, 'done')
      .then(() => setIssueTucked(rootId, true))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
  }
  const tuckResolvedRoot = (): void => {
    if (!screen.continuation && !screen.rootFinished) return
    if (screen.rootFinished) {
      void setIssueTucked(rootId, true)
      return
    }
    // The same question every close path now asks before raising the guard
    // (POD-1278) — this column has asked it since POD-1212, and the hook is where
    // it lives now.
    const rootIssue = source.issue(rootId)
    if (rootIssue && needsCloseGuard(rootIssue)) {
      setSignpostClosing(true)
      return
    }
    closeAndTuckRoot()
  }
  const addMissionAgent = async (agentKind?: IssueAgentKind): Promise<void> => {
    const input = agentKind ? { id: rootId, agentKind } : { id: rootId }
    const existingSessionIds = source
      .attached(rootId)
      .filter((session) => !(session as SessionModel).archived)
      .map((session) => session.sessionId)
    await spawnIssueAgent(trpc.issues, input)
    await focusIssueSession(rootId, { excludeSessionIds: existingSessionIds })
  }
  const selectSession = (
    issueId: IssueId | null,
    session: SessionView,
    opts: { permanent: boolean; native?: boolean },
  ): void => {
    if (view === 'waterfall' && !opts.native) {
      const nextDisplay = nextFlightDeckDisplayForSessionPick(
        display,
        activeSessionId,
        session.sessionId,
        opts.permanent,
      )
      if (nextDisplay !== display) onDisplayChange(nextDisplay)
    }
    if (issueId) setFocusedIssueId(issueId)
    if (session.cwd) setSelectedWorktree(session.cwd)
    openSessionTab(session.sessionId, { permanent: opts.permanent })
    // WHERE THE ROW WOULD LIKE THE PANEL TO OPEN, not what the operator chose
    // (POD-1702). The native worker rows below a session are navigation — their
    // job is "take me to the agent running this worker, on the terminal it is
    // running in" — and a session the operator has explicitly put in chat used
    // to snap straight back to the CLI on the next such click, durably, so it
    // reopened there too. `preferPanelMode` lands on the terminal for every
    // session nobody has decided about and leaves a standing pick alone.
    if (opts.native) preferPanelMode(session.sessionId, 'native')
    if (issueId) void markIssueRead(issueId)
    void markSessionRead(session.sessionId)
    setView('workspace')
  }

  /** Handoff task-only rows retarget the Task dock without replacing the chat. */
  const focusHandoffIssue = (issueId: IssueId): void => {
    setFocusedIssueId(issueId)
    window.dispatchEvent(new CustomEvent(OPEN_RIGHT_PANEL_EVENT, { detail: 'issue' }))
    void markIssueRead(issueId)
    setView('workspace')
  }

  const openHandoffSession = (issueId: IssueId, sessionId: SessionId): void => {
    const session = source.session(sessionId)
    if (session) selectSession(issueId, session, { permanent: true })
  }

  const openHandoffTranscript = (sessionId: SessionId, itemKey: string): void => {
    const session = source.session(sessionId)
    if (session?.issueId) setFocusedIssueId(session.issueId)
    if (session?.cwd) setSelectedWorktree(session.cwd)
    setPanelMode(sessionId, 'chat')
    openSessionAtTranscript(sessionId, itemKey, { permanent: true })
    void markSessionRead(sessionId)
    if (session?.issueId) void markIssueRead(session.issueId)
    setView('workspace')
  }

  /**
   * The list spine is one line, resolved once so its width and tone cannot jog
   * between the root roster and the nested task rows.
   */
  const spineRail = railFor(leadTone(rootId as IssueId))
  const spineSegment = (className: string, style?: CSSProperties): JSX.Element => (
    <span
      aria-hidden
      className={cn('pointer-events-none absolute', spineRail.className, className)}
      style={{ left: ROOT_RAIL, width: spineRail.width, ...style }}
    />
  )

  /**
   * THE COLLAPSE CHEVRON IS A MEMBER OF THE EYEBROW ROW (POD-1146).
   *
   * It used to be `absolute top-1 right-2` on the column itself, and the eyebrow
   * then reserved `pr-11` to dodge a control that was floating over it. Two
   * consequences: the eyebrow had an eleven-pixel hole in it that nothing
   * explained, and the chevron's centre did not line up with the ⌕ and the
   * fold-all control directly below it.
   *
   * As the last flex child of a row padded to 8px it is simply a 24px button
   * like those two, so every glyph centre in the column stands 20px from the
   * edge and the reservation goes away.
   */
  const collapseButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="deck-eyebrow-chevron size-6 flex-none text-text-faint"
      aria-label="Collapse Flight Deck"
      title="Collapse Flight Deck"
      onClick={onCollapse}
    >
      <ChevronLeft size={14} aria-hidden="true" />
    </Button>
  )
  const proposedSection = (flat: boolean): ReactNode =>
    proposedRows.length > 0 ? (
      <DeckSection
        label="Proposed"
        count={proposedRows.length}
        tone="text-fuchsia-500"
        testId="flight-proposed"
      >
        {flat ? (
          <div className="flex flex-col gap-1">
            {proposedRows.map((row) => (
              <ProposalRow
                key={row.key}
                row={row}
                selected={focused === row.id}
                onSelect={(permanent) => selectIssue(row, permanent)}
                onMenu={(event) => openIssueMenu(asIssueId(row.id), event)}
                onStatusPick={(value) => pickRowStatus(row.id, value)}
              />
            ))}
          </div>
        ) : (
          <DeckFlatRows
            className="flex flex-col gap-1"
            gap={4}
            scrollRef={deckScrollerRef}
            scope={`${rootId}:proposed:${scrollKey}`}
            rows={proposedRows.map((row) => ({
              key: `proposal:${row.key}`,
              size: 30,
              get text() { return `${row.displayRef} ${row.title}` },
            }))}
          >
            {(index) => {
              const row = proposedRows[index]!
              return (
                <ProposalRow
                  key={row.key}
                  row={row}
                  selected={focused === row.id}
                  onSelect={(permanent) => selectIssue(row, permanent)}
                  onMenu={(event) => openIssueMenu(asIssueId(row.id), event)}
                  onStatusPick={(value) => pickRowStatus(row.id, value)}
                />
              )
            }}
          </DeckFlatRows>
        )}
      </DeckSection>
    ) : null

  return (
    <aside
      // Keep native composer edits from repainting the mission's unchanged rows.
      // The root already scrolls and clips its children; menus use portals.
      className="engraved-column relative overflow-y-auto [contain:layout_paint]"
      data-testid="flight-deck-scroller"
      aria-label="Flight Deck"
      ref={deckScrollerRef}
      onScroll={(event) => {
        scrollPositionsRef.current[previousScrollKeyRef.current] = event.currentTarget.scrollTop
      }}
      style={spineWindow.enabled ? { overflowAnchor: 'none' } : undefined}
    >
      {/* The mission chrome belongs to the one definite-height scrollport
          but stays in view while its roster moves underneath. Header
          growth now changes content height, never the scrollport itself. */}
      {/* z-10: the waterfall's own layers (axis, bars, tools) reach z-6,
          and rows bleeding through this chrome was a filed defect. */}
      <div className="deck-chrome sticky top-0 z-10 flex-none">
        {/* THE MISSION HEADER IS THE ROOT OF THE TREE (round 3 §2, §4, §10).
          Roomy because it is read once where the strips below are scanned.
          It carries NO fill of its own any more (POD-725): the column ITSELF
          now runs the mission's colour. What is left is the geometry the
          artifact measures — a 32px eyebrow row, then the title block — and
          the seam under it belongs to the view bar's own top rule. */}
        {/* The header IS the root's strip (round 3 §4), so it takes the strips'
          menu as well as their click: right-clicking the mission has to
          reach the mission's own actions, or the one task in the column with
          no strip would be the one task with no menu. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu covers the header; its buttons provide keyboard actions. */}
        <div
          className="deck-header relative flex-none"
          onContextMenu={(event) => openIssueMenu(rootId as IssueId, event)}
        >
          {/* THE EYEBROW MAY TAKE A SECOND LINE (POD-1146), and it stands on
            the shell's one header datum (POD-1455). Identity and the chevron
            own line 1 and never shrink; the note and the seat drop underneath
            them, left-aligned on the same 16px datum. */}
          <DeckEyebrow
            screen={screen}
            onPickStatus={(value) => pickRowStatus(rootId, value)}
            collapse={collapseButton}
          />
          {/* THE HEADER IS NOT ON THE SPINE (POD-1306) — see the note over
            `spineSegment`. Its 16px padding is ROOT_RAIL's own x, which is
            exactly why no rail may be drawn under it. */}
          <div className="px-4 pt-0.5 pb-3.5">
            <DeckTitle
              screen={screen}
              onPress={() =>
                rootRow &&
                headerIntent.press(
                  () => selectIssue(rootRow, false),
                  () => selectIssue(rootRow, true),
                )
              }
              onCommit={() => rootRow && headerIntent.commit(() => selectIssue(rootRow, true))}
            />
            {/* THE BRIEF IS THE ONE THING HERE THAT IS READ RATHER THAN
              SCANNED — see {@link MissionBrief}. */}
            <div className="mt-2.5">
              <DeckBrief screen={screen} focusedSessionId={activeSessionId} />
            </div>
            {/* ONE 26px FAMILY, ON ONE BASELINE (POD-1146). */}
            <DeckGaugeRow
              screen={screen}
              onOpenInExplorer={() => rootRow && selectIssue(rootRow, true)}
              onAdd={addMissionAgent}
            />
          </div>
        </div>
        {/* Rules TOP AND BOTTOM, both in the soft tier: the bar is a band cut
          through the column, and its top rule is the seam the header no
          longer draws for itself. */}
        <div
          className="relative flex h-8 flex-none items-center gap-1 border-y border-hairline-soft pr-2"
          style={{ paddingLeft: GUTTER }}
        >
          <div className="flex min-w-0 flex-1 gap-1 self-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {modes.map((option) => (
              <button
                data-pressable
                type="button"
                key={option.id}
                aria-pressed={view === option.id}
                // THE ACTIVE VIEW IS UNDERLINED IN THE MISSION'S OWN COLOUR, and
                // the underline runs the bar's full height rather than a pill's.
                className={cn(
                  'shell-type-micro inline-flex flex-none items-center self-stretch whitespace-nowrap font-medium text-text-faint hover:text-text-strong',
                  view === 'waterfall' ? 'px-1' : 'px-2',
                  view === option.id && 'text-text-strong shadow-[inset_0_-2px_0_var(--issue)]',
                )}
                onClick={() => screen.setView(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-none items-center gap-0.5">
            {view === 'waterfall' && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 text-text-faint"
                aria-label={
                  display === 'expanded' ? 'Use compact Flight Deck' : 'Expand mission overview'
                }
                aria-pressed={display === 'expanded'}
                title={
                  display === 'expanded' ? 'Use compact Flight Deck' : 'Expand mission overview'
                }
                onClick={() => onDisplayChange(display === 'expanded' ? 'compact' : 'expanded')}
              >
                {display === 'expanded' ? (
                  <Minimize2 size={13} aria-hidden="true" />
                ) : (
                  <Maximize2 size={13} aria-hidden="true" />
                )}
              </Button>
            )}
            {view !== 'handoff' && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 text-text-faint"
                  aria-pressed={searchOpen}
                  title="Search this mission"
                  onClick={() => screen.toggleSearch()}
                >
                  <Search size={13} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 text-text-faint"
                  title={screen.allFolded ? 'Expand every branch' : 'Fold every branch'}
                  disabled={!screen.anyFoldable}
                  // Both directions write EXPLICIT values for every foldable
                  // branch: "expand everything" that merely cleared the map would
                  // leave the one-session tasks closed by the default rule, which
                  // is not what the control says.
                  onClick={() => screen.foldAll()}
                >
                  {screen.allFolded ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
                </Button>
              </>
            )}
          </div>
        </div>
        {searchOpen && view !== 'handoff' && (
          <div
            className="relative flex h-8 flex-none items-center gap-2 border-b border-hairline-soft pr-2"
            style={{ paddingLeft: GUTTER }}
          >
            <Search size={13} aria-hidden="true" className="flex-none text-text-faint" />
            <input
              // biome-ignore lint/a11y/noAutofocus: the field exists only while searching
              autoFocus
              type="text"
              value={query}
              placeholder="Task, session, agent or ref"
              aria-label="Search this mission"
              className="shell-type-secondary min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-text-faint"
              onChange={(event) => screen.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                screen.closeSearch()
              }}
            />
            {query && (
              <button
                data-pressable
                type="button"
                className="flex-none text-text-faint hover:text-text-strong"
                aria-label="Clear search"
                onClick={() => screen.setQuery('')}
              >
                <X size={11} />
              </button>
            )}
          </div>
        )}
      </div>
      <div
        ref={deckRowsRef}
        className={
          view === 'waterfall'
            ? 'contents'
            : view === 'handoff'
              ? 'flex-none'
              : 'deck-rows flex-none pb-1.5 pr-2'
        }
        data-testid={
          view === 'waterfall' || view === 'handoff' ? undefined : 'flight-deck-rows'
        }
      >
        {view === 'waterfall' ? (
          <WaterfallDeck
            screen={screen}
            display={display}
            focusedIssueId={focused ?? null}
            activeSessionId={activeSessionId}
            renameTarget={renameTarget}
            isFolded={(row) => row instanceof MissionDeckIssueModel ? row.folded(folds) : isFolded(row, folds)}
            onToggle={(row) => row instanceof MissionDeckIssueModel ? screen.toggleFold(row) : screen.fold(row.issue.id, !isFolded(row, folds))}
            onSelectIssue={(row, permanent) => {
              if (!permanent && row.depth > 0 && hasPayload(row)) {
                if (row instanceof MissionDeckIssueModel) screen.toggleFold(row)
                else screen.fold(row.issue.id, !isFolded(row, folds))
              }
              selectIssue(row, permanent)
            }}
            onSelectSession={(issueId, session, options) =>
              selectSession(issueId, session, options)
            }
            onIssueMenu={openIssueMenuAt}
            onStatusPick={pickRowStatus}
            onRenameIssue={renameIssue}
            onRenameDone={() => setRenameTarget(null)}
          />
        ) : view === 'handoff' ? (
          <HandoffDeck
            screen={screen}
            source={source}
            visitReadAt={
              issueVisitBaseline?.issueId === rootId ? issueVisitBaseline.readAt : null
            }
            onOpenTranscript={openHandoffTranscript}
            onOpenSession={openHandoffSession}
            onOpenIssue={focusHandoffIssue}
            proposed={proposedSection(true)}
          />
        ) : (
          <>
            <div className="relative h-1.5">{spineSegment('inset-y-0')}</div>
            {rootRow && (
              <>
                <HungRows
                  model={rootRow}
                  mode={mode}
                  rootId={rootId}
                  inMission={missionSessionIds}
                  nameOf={nameOf}
                  activeSessionId={activeSessionId}
                  arrivals={arrivals}
                  settle={settle}
                  inset={ROOT_BLOCK_INSET}
                  rail={spineRail}
                  tail={visibleRows.length > 0}
                  window={spineWindow}
                  onSelectSession={(session, permanent) =>
                    selectSession(asIssueId(rootId), session, { permanent })
                  }
                  onSelectNative={(session) =>
                    selectSession(asIssueId(rootId), session, {
                      permanent: false,
                      native: true,
                    })
                  }
                />
                {rootSessions.length > 0 && visibleRows.length > 0 && (
                  <div className="relative h-2" aria-hidden>
                    {spineSegment('inset-y-0')}
                  </div>
                )}
              </>
            )}
            {visibleRows.map((row, index) => {
              const block = spineGeometry.blocks.get(row.key)!
              if (
                spineWindow.enabled &&
                !block.some((leaf) => spineWindow.contains(leaf.key))
              ) {
                return (
                  <div key={row.key}>
                    {block.map((leaf) => (
                      <DeckRowPlaceholder key={leaf.key} row={leaf} window={spineWindow} />
                    ))}
                  </div>
                )
              }
              return (
                <TaskRow
                  key={row.key}
                  row={row}
                  renameSeed={renameTarget?.id === row.id ? renameTarget.seed : null}
                  carries={guides[index] ?? []}
                  rails={rails[index] ?? []}
                  agentRail={railFor(leadTone(asIssueId(row.id)))}
                  childFollows={(visibleRows[index + 1]?.depth ?? 0) > row.depth}
                  window={spineWindow}
                  mode={mode}
                  rootId={rootId}
                  inMission={missionSessionIds}
                  nameOf={nameOf}
                  selected={focused === row.id}
                  activeSessionId={activeSessionId}
                  arrivals={arrivals}
                  settle={settle}
                  collapsed={row.folded(folds)}
                  folds={folds}
                  onToggle={() => screen.toggleFold(row)}
                  onSelectIssue={(permanent) => {
                    if (!permanent && row.hasPayload) screen.toggleFold(row)
                    selectIssue(row, permanent)
                  }}
                  onSelectSession={(session, permanent) =>
                    selectSession(asIssueId(row.id), session, { permanent })
                  }
                  onSelectNative={(session) =>
                    selectSession(asIssueId(row.id), session, { permanent: false, native: true })
                  }
                  onMenu={(event) => openIssueMenu(asIssueId(row.id), event)}
                  onStatusPick={(value) => pickRowStatus(row.id, value)}
                  onRenameIssue={(title) =>
                    renameIssue(
                      row.id,
                      title,
                      renameTarget?.id === row.id
                        ? renameTarget.seed
                        : (row.title),
                    )
                  }
                  onRenameDone={() => setRenameTarget(null)}
                />
              )
            })}
          </>
        )}
        <div
          className={cn('flex-none', view === 'waterfall' && 'pb-1.5')}
          data-testid="flight-deck-tail"
        >
          {visibleRows.length === 0 &&
            proposedRows.length === 0 &&
            (query ? (
              <p className="shell-type-secondary px-4 py-6 text-text-dim">
                Nothing in this mission matches that.
              </p>
            ) : // A vacated root is not an empty spine — the region below says
            // where the work went, and it says it once.
            rootContinuation || rootSessions.length > 0 ? null : rootRetired ? (
              // THE MISSION ENDED HERE — a card, not a caption (POD-1268).
              <div className="py-4 pr-2" style={{ paddingLeft: GUTTER }}>
                <RetiredSignpost abandoned={screen.rootAbandoned} onTuck={tuckResolvedRoot} />
              </div>
            ) : (
              <p className="shell-type-secondary px-4 py-6 text-text-dim">
                {/* WHICH VIEW EMPTIED IT (POD-1356). `rootEmptyNote` is about
                  the mission — "nobody is on this" — and printing it under a
                  narrowed view says that about a task with a live agent on
                  it. The view's own sentence comes first, and only `full`
                  falls through to the note. */}
                {deckViewEmptyLine(mode, screen.waitingCount) ??
                  rootEmptyNote?.text ??
                  'No sessions or sub-tasks are attached.'}
              </p>
            ))}
          {/* THE SECTIONS BELOW THE TREE. PROPOSALS SINK: work being offered
            to the operator is not part of the mission's shape. */}
          {proposedSection(false)}
          {/* The archive is where the roster STOPS: a wider break (POD-1461). */}
          <DeckArchive
            screen={screen}
            source={source}
            revealSessionId={revealSessionId}
            scrollRef={deckScrollerRef}
            scrollKey={scrollKey}
            activeSessionId={activeSessionId}
            onSelect={(session, opts) => selectSession(session.issueId ?? null, session, opts)}
          />
          {/* POD-679's departures — deliberately NOT folded into the proposals.
            A proposal is work nobody has triaged yet; a departure is work that
            is already gone. Not filtered by the mode or the search either. */}
          <WhereTheWorkWent
            continuation={rootContinuation}
            continuationState={screen.continuationState}
            continuationFinished={rootFinished}
            // `rootRow.sessions`, NOT `rootSessions`: the latter is
            // `deckSessions(row, mode)`, which the view bar narrows.
            continuationSessions={rootRow?.sessions ?? []}
            departures={screen.otherDepartures}
            onOpen={openDeparture}
            onTuck={tuckResolvedRoot}
          />
        </div>
      </div>
      {issueMenu && menuIssue && (
        <IssueMenu
          issues={[menuIssue]}
          allIssues={[]}
          // `deck`, not `sidebar` (POD-1077): the deck is its own surface
          // because it has its own answers.
          surface="deck"
          primaryStart={menuIssue.stage === 'proposed'}
          anchor={issueMenu.anchor}
          onClose={() => setIssueMenu(null)}
          onRename={(id) => {
            setIssueMenu(null)
            const issue = source.issue(id)
            if (issue) {
              setRenameTarget({
                id,
                seed: screen.deck.model(id).title ?? issue.title,
              })
            }
          }}
          onOpen={(id) => {
            setIssueMenu(null)
            const row = screen.rows.find((candidate) => candidate.id === id)
            // Open is the strip's own double click — the permanent one.
            if (row) selectIssue(row, true)
          }}
        />
      )}
      {/* The SAME guard every other close path raises (POD-1129), mounted for the
          one close this column can start: the signpost card's "Done & tuck". */}
      {signpostClosing && (
        <RootCloseDialog
          screen={screen}
          onOpenChange={(open) => setSignpostClosing(open)}
          onConfirm={closeAndTuckRoot}
        />
      )}
      {/* The guard for an ending picked from a strip's glyph — the same dialog,
          raised for whichever task was picked from rather than for the root. */}
      {rowStatus.dialog}
    </aside>
  )
})

/** The session pane A (or pane B in a split) shows, when that tab is a session. */
function useFocusedSessionId(paneA: string | null, paneB: string | null): SessionId | null {
  const read = useCallback(
    (pool: MobxPool): SessionId | null => {
      for (const id of [paneA, paneB]) {
        if (!id) continue
        const exists = settled(() => pool.sessionObject(id).exists)
        if (exists === true) return id as SessionId
      }
      return null
    },
    [paneA, paneB],
  )
  return useWorklistPoolProjection(read, null)
}
