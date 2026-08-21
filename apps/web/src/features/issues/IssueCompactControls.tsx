import { shallowEqual } from '@podium/client-core/store'
import {
  discoveredPlacement,
  issueNeedsHuman,
  motionPhase,
  type ProposalPlacement,
  sessionNeedsHuman,
} from '@podium/client-core/viewmodels'
import type { IssueUpdatePatch } from '@podium/commands'
import {
  type IssueId,
  type IssueStage,
  issueStatusLabel,
  issueStatusMenuEntries,
  issueStatusOf,
  issueStatusValueOf,
  type MachineId,
  parseIssueStatusValue,
  type SessionMeta,
} from '@podium/model/browser'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CornerDownRight,
  GitBranch,
  GitCommit,
  MoreHorizontal,
  RotateCcw,
} from 'lucide-react'
import { Fragment, type JSX, lazy, Suspense, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { IssueViewModel } from '@/app/store'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MENU_HEADER, MENU_HEADER_REF, MENU_RULE } from '@/lib/menu-surface'
import type { ContextMenuAnchor } from '@/lib/session-context-menu'
import { cn } from '@/lib/utils'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { IssueContextMenu } from './IssueContextMenu'
import { StatusGlyph } from './issue-glyphs'
import { IssueCloseDialog, type IssueCloseReason, useIssueCloseGuard } from './issue-lifecycle'
import { LaunchBox, type LaunchCommands } from './LaunchBox'

// The right-click menu exists only after a right-click; loading it on demand
// keeps the menu (and its handoff machinery) out of the eager bundle.
const SessionContextMenu = lazy(() =>
  import('@/lib/SessionContextMenu').then((module) => ({
    default: module.SessionContextMenu,
  })),
)

const isSystemOwnedIssueStage = (stage: IssueStage): boolean => stage === 'shipping'

/** Stages whose own name says somebody has picked the work up. Mirrors the
 *  flight deck's `UNDERWAY` bucket (client-core/viewmodels/mission.ts) with
 *  `review` added: work under review has been done too, and neither reads as
 *  something to "start". */
const BEGUN_STAGES: ReadonlySet<IssueStage> = new Set<IssueStage>([
  'planning',
  'in_progress',
  'review',
  'shipping',
])

/**
 * The dock's reading scale (POD-725 §7). Written out rather than taken from
 * `shell-type-secondary` because that role drops to 11px under compact density,
 * and the step UP to a settled 12px is precisely what this design is for — the
 * issue panel is read, not scanned. Labels, stamps and section headers still
 * come from the role tokens; only the prose is pinned.
 */
export const DOCK_BODY = 'text-[12px] leading-[1.5]'
/** The same 12px set tighter, for the one-line titles rows are made of. */
export const DOCK_ROW = 'text-[12px] leading-[1.4]'
/** Machine voice at the floor of the scale: trailing state words, timestamps,
 *  the facts a row parks on its right edge. */
export const DOCK_STAMP = 'font-mono shell-type-micro leading-none'

/** A session is still present when its process is: an exited-but-unarchived
 *  session is gone, and reading it as "standing by" would tell the operator an
 *  agent is on this task when none is. Same predicate the Flight Deck counts use. */
export function isOpenSession(session: SessionMeta): boolean {
  return !session.archived && session.status !== 'exited'
}

/**
 * Every session that belongs to this issue — its declared members plus any
 * session attached to it directly. Sessions are NOT embedded on the issue
 * (D7.3): the model carries ids, and the caller resolves them against the
 * session slice it already holds.
 */
export function issueSessions(
  issue: Pick<IssueViewModel, 'id' | 'memberSessionIds'>,
  sessions: readonly SessionMeta[],
): SessionMeta[] {
  const members = new Set(issue.memberSessionIds ?? [])
  return sessions.filter(
    (session) => session.issueId === issue.id || members.has(session.sessionId),
  )
}

/** Newest-active first, so "the session on this task" is a stable pick. */
/** The agent-state word a dock session row wears — the vocabulary the rest of
 *  the shell already uses, not a second one. */
export function sessionStateLabel(session: SessionMeta): string {
  if (session.archived) return 'Retired'
  if (session.status === 'exited') return 'Exited'
  if (session.status === 'hibernated') return 'Paused'
  if (session.handoffTarget) return 'Moving'
  const phase = motionPhase(session)
  if (phase === 'working') return 'Working'
  if (phase === 'waiting') return 'Waiting on you'
  if (phase === 'done') return 'Done'
  if (session.status === 'starting' || session.status === 'reconnecting') return 'Starting'
  return 'Idle'
}

export type TaskActionKind = 'mark-done' | 'start-work'

export interface TaskAction {
  kind: TaskActionKind
  label: string
  /** The needs-you variant carries the warn treatment. */
  warn: boolean
}

/**
 * The one primary action the task head offers, resolved from the issue's own
 * state: a handed-off origin that needs a decision → Mark done, where the work
 * has left and closing is the only decision left; else nobody on it → Start
 * work.
 *
 * NEEDS-YOU RESOLVES TO NO ACTION (POD-1269). An `Answer` chip sat here and
 * jumped to whoever was waiting — but the same obligation was already stated
 * three times on this surface: the amber band names the decision, the waiting
 * session wears an attention rule, and its row opens the conversation where the
 * answer is actually given. A yellow button whose only job is to scroll the
 * shell somewhere else read as the place to answer, and it was not.
 *
 * Sessions already working it resolve to NO action and the head renders no chip.
 * An "Open coordinator" chip sat here until POD-1151: its job was to jump to the
 * coordinator, but this panel is the right dock, which stays put, so from the
 * workspace the click landed on a session already in the pane and read as dead.
 * Nothing is lost — those sessions have their own rows under "Agents &
 * sessions", which open the session AND switch the view.
 */
export function resolveTaskAction(
  issue: IssueViewModel,
  active: readonly SessionMeta[],
): TaskAction | null {
  if (issueNeedsHuman(issue, active)) {
    const handedOff =
      active.length === 0 && (issue.dependents ?? []).some((dep) => dep.type === 'discovered-from')
    return handedOff ? { kind: 'mark-done', label: 'Mark done', warn: true } : null
  }
  if (active.length > 0) return null
  return { kind: 'start-work', label: 'Start work', warn: false }
}

/** One line naming the decision, in the operator's words. The agent's own
 *  question wins when it asked one. */
export function decisionLine(issue: IssueViewModel, active: readonly SessionMeta[]): string {
  const asked = issue.humanQuestion?.trim()
  if (asked) return asked
  const waiting = active.find((session) => sessionNeedsHuman(session))
  if (waiting) return `${sessionDisplayName(waiting)} is waiting on your reply.`
  if (active.length === 0 && (issue.dependents ?? []).some((dep) => dep.type === 'discovered-from'))
    return 'The work moved to a spin-off — close this origin or keep it for follow-up.'
  if (issue.stage === 'review') return 'Review the delivered work and accept it or send it back.'
  return 'This task is waiting for your input.'
}

/** Git scope for this issue — the branch it delivers on, what is waiting to
 *  land, and dirt this issue is answerable for. It heads the dock's "Branch &
 *  worktree" section rather than trailing the old "Evidence & checks", where a branch
 *  name read as a verification result (POD-516 r3 #6). The branch itself is
 *  machine voice, so it is set in mono. */
export function IssueGitScope({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  const git = issue.gitState
  if (!git) return null
  const attributedDirty = git.dirtyOwn ?? (!git.shared && !git.fallback ? git.dirtyFiles : 0)
  const delivery = git.shared ? (git.commits?.length ?? 0) : (git.ahead ?? 0)
  return (
    // Mono facts, whole row: a branch name and a file count are both machine
    // voice, and setting only half the row in mono made the two disagree.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1 font-mono text-[10.5px] leading-[1.6] text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <GitBranch size={12} className="flex-none" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {git.branch ?? (git.shared ? 'Shared checkout' : (issue.branch ?? 'Checkout'))}
        </span>
      </span>
      {delivery > 0 && (
        <span className="inline-flex items-center gap-1.5 text-foreground/80">
          <GitCommit size={12} aria-hidden="true" />
          {delivery} commit{delivery === 1 ? '' : 's'} awaiting delivery
        </span>
      )}
      {/* Warning, not attention: dirt is a caution about this issue's checkout,
          not something asking the operator a question. Amber is needs-you. */}
      {attributedDirty > 0 && (
        <span className="text-warning">
          {attributedDirty} dirty file{attributedDirty === 1 ? '' : 's'} · this issue
        </span>
      )}
    </div>
  )
}

/** The obligation, said ONCE per session row (POD-1269).
 *
 *  This badge replaces the offer card that used to unfold here — the agent's
 *  headline plus its one-click answers, hanging off the row that asked. That
 *  card was a whole conversation transplanted into a roster: three lines and a
 *  button row per waiting session, in a list whose job is to say who is on this
 *  task. The roster now only raises the flag; the offer itself is read and
 *  answered in the conversation, one click away on the row.
 */
function SessionNeedsYou(): JSX.Element {
  return (
    <span
      className="shell-type-micro flex-none rounded-full border border-attention/45 bg-attention/10 px-1.5 py-[2px] font-semibold text-attention"
      data-testid="dock-session-needs-you"
    >
      Needs you
    </span>
  )
}

/**
 * One session under "Agents & sessions": the harness tile and name the rest of
 * the shell uses, its agent-state word, and every lifecycle action behind the
 * shared session context menu (right-click or •••) rather than a bespoke button
 * pair.
 *
 * A session that stopped and asked wears the obligation: a 2px attention rule
 * down its left edge and a "Needs you" badge where its state word goes. Colour
 * for obligation — the rule appears nowhere else on this surface. The question
 * itself, and the buttons that answer it, live in the conversation the row
 * opens (POD-1269).
 */
export function IssueSessionRow({
  session,
  onOpen,
}: {
  session: SessionMeta
  onOpen: () => void
}): JSX.Element {
  const renameSession = useStoreSelector((s) => s.renameSession)
  const [menu, setMenu] = useState<ContextMenuAnchor | null>(null)
  const [editing, setEditing] = useState(false)
  const retired = session.archived || session.status === 'exited'
  const needs = !retired && sessionNeedsHuman(session)
  return (
    <div
      className={cn(
        'group/session border-b border-hairline-soft',
        retired && 'opacity-60',
        needs && 'border-l-2 border-l-attention bg-attention/[0.05] pl-1.5',
      )}
      data-testid="dock-session-row"
      data-needs-you={needs || undefined}
    >
      <div className="flex min-h-[31px] items-center gap-2 px-1">
        {editing ? (
          <SessionNameEditor
            value={sessionDisplayName(session)}
            onCommit={(name) => {
              void renameSession(session.sessionId, name)
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            data-pressable
            type="button"
            className={cn(
              DOCK_ROW,
              'flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-foreground/90',
            )}
            onClick={onOpen}
            // Right-click for the full action menu — same gesture, same menu, as
            // the sidebar's session rows and the tab strip.
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY })
            }}
          >
            <WorkerLabel session={session} chip />
          </button>
        )}
        {/* The badge SUPPLANTS the state word rather than sitting beside it:
            "Waiting on you" and "Needs you" are the same fact in two
            vocabularies, and the row has one slot for how this session stands. */}
        {needs ? (
          <SessionNeedsYou />
        ) : (
          <span className={cn(DOCK_STAMP, 'flex-none text-text-faint')}>
            {sessionStateLabel(session)}
          </span>
        )}
        <button
          data-pressable
          type="button"
          title="Session actions"
          aria-label={`Actions for ${sessionDisplayName(session)}`}
          className="flex-none rounded px-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/session:opacity-100"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.right - 4, y: rect.bottom + 4 })
          }}
        >
          <MoreHorizontal size={13} aria-hidden="true" />
        </button>
      </div>
      {menu && (
        <Suspense fallback={null}>
          <SessionContextMenu
            session={session}
            anchor={menu}
            onClose={() => setMenu(null)}
            onRename={() => {
              setMenu(null)
              setEditing(true)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}

/**
 * The `decision-band`: bold "Needs you" and ONE line saying what the decision
 * is, between the fixed head and the scroll — exactly where the artifact puts
 * it, and exactly as big.
 *
 * Nothing here may grow with the data. It used to carry one `OfferBar` per
 * session with a live offer; because this region is laid out before the single
 * scroll and never shrinks, a stack of three offers took 1126px of a 1088px
 * dock and left the scroll 0px of content height. The answers now hang off the
 * session that asked (see {@link IssueSessionRow}), inside the scroll.
 */
export function IssueDecisionBand({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  const { trpc, sessions } = useStoreSelector(
    (s) => ({ trpc: s.trpc, sessions: s.sessions }),
    shallowEqual,
  )
  const active = issueSessions(issue, sessions).filter(isOpenSession)
  if (!issueNeedsHuman(issue, active)) return null

  return (
    <div className="flex-none px-3.5 pb-3" data-testid="dock-decision-band">
      <div
        className={cn(
          DOCK_BODY,
          'flex items-baseline gap-1.5 rounded-md border border-attention/40 bg-attention/[0.07] px-2.5 py-2',
        )}
      >
        <span className="flex-none font-semibold text-attention">Needs you</span>
        <span className="line-clamp-2 min-w-0 flex-1 text-foreground/85">
          {decisionLine(issue, active)}
        </span>
        {/* A flag raised on the ISSUE is the only thing this band can clear; an
            agent's question is cleared by answering it, on its own row. Inline
            text, not a stacked button — the band is one line by contract. */}
        {issue.needsHuman && (
          <button
            data-pressable
            type="button"
            className="shell-type-micro flex-none text-attention/80 underline-offset-2 hover:underline"
            onClick={() =>
              trpc.issues.clearNeedsHuman
                .mutate({ id: issue.id })
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error)),
                )
            }
          >
            Mark resolved
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The start control's second half: WHERE the work will live once it runs.
 *
 * One decision, two destinations, each named by what it does to the task that
 * found this work rather than by the edge it writes. The current shape — the
 * one the filing agent chose, and the one the plain Start button takes — is
 * ticked, so the menu reads as a confirmation with an escape hatch instead of
 * an open question the operator has to answer every time.
 */
function PlacementMenu({
  placement,
  busy,
  onStart,
}: {
  placement: { placement: ProposalPlacement; originRef: string | null }
  busy: boolean
  onStart: (moveTo: ProposalPlacement) => void
}): JSX.Element {
  const origin = placement.originRef
  const options: Array<{
    key: ProposalPlacement
    label: string
    why: string
    Glyph: typeof ArrowUpRight
  }> = [
    {
      key: 'own',
      label: 'Start on its own',
      why: origin
        ? `Its own row in the sidebar. ${origin} can close without it.`
        : 'Its own row in the sidebar. The task that found it can close without it.',
      Glyph: ArrowUpRight,
    },
    {
      key: 'mission',
      label: origin ? `Start inside ${origin}` : 'Start inside this mission',
      why: origin
        ? `Stays on that spine. ${origin} is not done until this is.`
        : 'Stays on this mission’s spine, which is not done until this is.',
      Glyph: CornerDownRight,
    },
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            data-testid="task-placement-trigger"
            aria-label="Where should this work live?"
            title="Where should this work live?"
            disabled={busy}
            className="h-7 rounded-l-none border-l border-l-black/20 px-1.5"
          >
            <ChevronDown size={11} aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-[19rem] max-w-[calc(100vw-24px)]"
      >
        <div className={`${MENU_HEADER} px-[5px]`}>
          <span>START WORK</span>
          <span className={MENU_HEADER_REF}>PLACEMENT</span>
        </div>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.key}
            data-testid={`task-placement-${option.key}`}
            className="group/placement items-start py-[6px]"
            onClick={() => onStart(option.key)}
          >
            <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-[6px] border border-hairline-soft bg-card text-text-dim group-focus/placement:border-border-strong group-focus/placement:text-text-strong">
              <option.Glyph size={11} aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5 font-medium text-text-strong">
                <span>{option.label}</span>
                {option.key === placement.placement && (
                  <span className="ml-auto inline-flex items-center gap-1 font-mono text-[8px] tracking-[.08em] text-text-faint uppercase">
                    Current <Check size={10} aria-hidden="true" />
                  </span>
                )}
              </span>
              <span className="mt-0.5 text-[10.5px] leading-[1.4] text-text-dim">{option.why}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <div className={MENU_RULE} />
        <p className="px-[5px] pb-0.5 font-mono text-[8.5px] leading-[1.45] text-text-faint">
          Choose a placement to start the work immediately.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The task head's control strip: the stage dropdown, the ONE primary action the
 * issue's state resolves to, and the shared issue context menu. Every other
 * lifecycle affordance lives in that menu rather than competing for the row.
 */
export function IssueCompactControls({ issue }: { issue: IssueViewModel }): JSX.Element {
  // NO CROSSING INTO WORK HERE, SINCE POD-1457. A `Work on this` chip stood in
  // this strip, filled or outlined depending on what else had resolved, and it
  // sat one gap away from `Start work` — two adjacent controls whose labels both
  // promised to begin the work, only one of which did. Going to the Work view is
  // NAVIGATION, so it left the action row entirely: it is now a named link in
  // the panel's head (`InspectHead`), above the title, where the trail and the
  // other "where am I" chrome lives.
  const { trpc, sessions, machines, updateIssue, closeIssue } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      sessions: s.sessions,
      machines: s.machines,
      updateIssue: s.updateIssue,
      closeIssue: s.closeIssue,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [closeReason, setCloseReason] = useState<IssueCloseReason | null>(null)
  const needsCloseGuard = useIssueCloseGuard()
  const [closing, setClosing] = useState(false)
  const [starting, setStarting] = useState(false)

  const active = issueSessions(issue, sessions).filter(isOpenSession)
  const action = resolveTaskAction(issue, active)
  const closed = Boolean(issue.closedReason) || issue.archived
  // WHERE THIS WORK WILL LIVE, offered at the moment it starts (POD-679).
  // Only while it has not started: once an agent is on it, the same two moves
  // live in the context menu, where a correction belongs.
  const placement = useMemo(() => {
    // DISCOVERED work only. `startedBySession` is stamped exactly when a
    // non-operator filed the issue, so this is the fork on work an AGENT found
    // — the case where the operator inherited a placement decision they never
    // made. A sub-task the operator planned themselves needs no second opinion
    // on the button; the context menu still offers the move.
    if (action?.kind !== 'start-work' || !issue.startedBySession) return null
    const byId = new Map(issues.map((candidate) => [candidate.id as string, candidate]))
    return discoveredPlacement(issue, byId)
  }, [action?.kind, issue, issues])

  if (isSystemOwnedIssueStage(issue.stage)) {
    return (
      <div className="mt-2.5 flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled
          aria-label="Shipping controls are managed by the shipping service"
          className="h-7 flex-none gap-1.5 border-border bg-card px-2.5 text-[11.5px] font-medium text-text-strong"
        >
          <StatusGlyph status={issue.stage} size={12} />
          {issueStatusLabel(issue)}
        </Button>
      </div>
    )
  }

  /** Apply one picked status. The fork between "move the lane" and "close with
   *  a reason" is the model's, not this menu's — see `issueStatusIntent`. */
  const currentStatusValue = issueStatusValueOf(issue)
  const selectStatus = (value: string): void => {
    const intent = parseIssueStatusValue(value)
    if (!intent) return
    if (intent.kind === 'close') {
      requestClose(intent.reason)
      return
    }
    updateIssue(issue.id, { stage: intent.stage }).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    )
  }

  const confirmClose = (reason: IssueCloseReason): void => {
    setClosing(true)
    closeIssue(issue.id, reason)
      .then(() => setCloseReason(null))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setClosing(false))
  }

  /** The one way this panel asks for a close (POD-1278) — the status menu, the
   *  Done button, and the context menu all land here. The guard is raised only
   *  when it has something to name; otherwise the ending is recorded on the
   *  press, which is what confirming would have done. */
  const requestClose = (reason: IssueCloseReason): void => {
    if (needsCloseGuard(issue)) setCloseReason(reason)
    else confirmClose(reason)
  }

  /** Every write on this strip surfaces its failure the same way. */
  const reportError = (error: unknown): void => {
    toast.error(error instanceof Error ? error.message : String(error))
  }

  const patchIssue = (patch: IssueUpdatePatch): void => {
    updateIssue(issue.id, patch).catch(reportError)
  }

  const runAction = (): void => {
    if (!action) return
    switch (action.kind) {
      case 'mark-done':
        requestClose('done')
        return
      case 'start-work':
        startWork()
        return
    }
  }

  /**
   * Start the work, optionally moving it first.
   *
   * The placement move goes BEFORE the start deliberately: an agent that boots
   * into a worktree and reads its own issue should find the shape the operator
   * chose, not the one it is about to be moved out of. A failed move therefore
   * cancels the start rather than running the work in the wrong place.
   */
  const startWork = (moveTo?: ProposalPlacement): void => {
    setStarting(true)
    const origin = placement?.originId
    const start = (): Promise<unknown> => trpc.issues.start.mutate({ id: issue.id })
    // Nothing to move is the ordinary case, and it stays a DIRECT call: routing
    // it through a resolved promise would delay every plain start by a tick for
    // the sake of one branch's symmetry.
    const run =
      moveTo && origin && moveTo !== placement?.placement
        ? trpc.issues.setPlacement
            .mutate({ id: issue.id, placement: moveTo, originId: origin })
            .then(start)
        : start()
    run
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setStarting(false))
  }

  /**
   * THE DOCK'S LAUNCH WRITES (POD-1457) — the seven verbs {@link LaunchBox}
   * needs, over the same store actions the rest of this strip already uses.
   *
   * The full issue page hands the box `issuePageCommands`, which is built from
   * the page's whole dependency set (loaders, curation callbacks, its busy
   * gate). The panel needs none of that, and `LaunchCommands` is deliberately
   * narrow enough that this satisfies it: same `issues.update` call, same
   * per-agent reset ([spec:SP-7ff1] — models are per-agent, so a harness change
   * resets model + effort rather than showing the previous agent's model for a
   * beat), same `issues.start`.
   */
  const launchCommands: LaunchCommands = {
    setDefaultAgent: (defaultAgent) => {
      if (defaultAgent === issue.defaultAgent) return
      patchIssue({ defaultAgent, defaultModel: 'auto', defaultEffort: 'auto' })
    },
    setDefaultModel: (defaultModel) => patchIssue({ defaultModel, defaultEffort: 'auto' }),
    setDefaultEffort: (defaultEffort) => patchIssue({ defaultEffort }),
    setMachine: (machineId: MachineId | null) => patchIssue({ machineId }),
    startWork: () => startWork(),
    addSession: () => {
      void trpc.issues.addSession.mutate({ id: issue.id }).catch(reportError)
    },
    addShell: () => {
      void trpc.issues.addShell.mutate({ id: issue.id }).catch(reportError)
    },
  }

  /**
   * WORK HAS BEGUN — so the box wears its `+ Session` / `+ Shell` face and
   * offers no `Start work` at all (POD-1457).
   *
   * Three independent proofs, any one of which settles it: an agent on it right
   * now, a checkout it already delivers on, or a stage whose own NAME says
   * somebody picked it up. The stage half is what the old reading missed — an
   * `in_progress` task whose agent has exited is not unstarted work, and
   * offering to "start" it named the wrong move for the state it was in.
   *
   * `review` is in the set on purpose: work under review has been done. What you
   * might still want there is another session to act on the review, which is
   * exactly what the other face offers.
   */
  const begun = active.length > 0 || Boolean(issue.worktreePath) || BEGUN_STAGES.has(issue.stage)

  /**
   * WHETHER THE BOX APPEARS AT ALL.
   *
   * Not on a finished task — a closure, an archive, or the `done` lane is the
   * end of the work, and the strip offers Reopen there instead. Not while the
   * panel is asking the operator to Mark done either: that state means the work
   * has LEFT for a spin-off, so starting is not the move, and it keeps the
   * panel's one-yellow-object rule intact.
   */
  const launchable = !closed && issue.stage !== 'done' && action?.kind !== 'mark-done'

  return (
    // TWO TIERS, AND THE GAP BETWEEN THEM IS THE POINT (POD-1457).
    //
    // The chips say what STATE this task is in; the launch box is the
    // INSTRUMENT you act with. Those are different kinds of object, and while
    // the box sat in the chip row's own 8px wrap it was spaced exactly like a
    // chip — proximity said it was one. 14px is the design's section interval
    // (`sheetGap`, and the dock section's own `mb-3.5`), so the box now reads as
    // its own tier, with the head's matching 14px of foot under it.
    //
    // The chip line still WRAPS, since POD-1269: status, a resolved Mark done
    // and the overflow menu at 300px of dock. Wrapping is safe where a clamp
    // would not be — the head must not grow with DATA, and a line break here is
    // a function of width, not of how much this task has to say. The box is
    // bounded the same way: two picker rows and a button, whatever it holds.
    <div className="mt-2.5 flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* STATUS, exposed as a first-class dock action. Built from the shell's
            own dropdown rather than a native <select>, which exists nowhere in
            this chrome. One flat Linear-shaped list (POD-1074): the open lanes,
            a rule, then the terminal outcomes as STATES — Done, Cancelled,
            Duplicate — rather than the operations they used to be named after
            ("Close: wontfix"). The terminal entries still route through the close
            dialog so a reason is always recorded and the guard always runs; that
            split is invisible in the menu, which is the point.
            `ghost` + an explicit card fill rather than `outline`: the dock's
            surface is --engraved, which sits ABOVE --background in the paper
            ramp, so the outline variant's --background fill made the pill sink
            into the panel instead of lifting off it. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Status"
                className="h-7 flex-none gap-1.5 border-border bg-card px-2.5 text-[11.5px] font-medium text-text-strong"
              >
                <StatusGlyph status={issueStatusOf(issue)} size={12} />
                {issueStatusLabel(issue)}
                <ChevronDown size={13} className="size-[13px] text-text-faint" aria-hidden="true" />
              </Button>
            }
          />
          {/* The closed row keeps the WHOLE list rather than hiding the terminal
              half: correcting a closure (done → duplicate) is one pick, and
              picking an open lane reopens, which is what the reopen button beside
              this does in one step. */}
          <DropdownMenuContent align="start">
            {issueStatusMenuEntries().map((entry) => (
              <Fragment key={entry.status}>
                {entry.startsGroup && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  className="whitespace-nowrap"
                  onClick={() => selectStatus(entry.value)}
                >
                  <StatusGlyph status={entry.status} size={12} />
                  {entry.label}
                  {currentStatusValue === entry.value && (
                    <Check size={12} className="ml-auto text-text-faint" aria-hidden="true" />
                  )}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {closed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-3 text-[11.5px]"
            onClick={() =>
              updateIssue(issue.id, { stage: 'backlog' }).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : String(error)),
              )
            }
          >
            <RotateCcw size={12} aria-hidden="true" /> Reopen issue
          </Button>
        ) : action && !launchable ? (
          // THE PANEL'S ONE CHIP-SHAPED ACTION — Mark done, on an origin whose
          // work has left. Start work is no longer here: it is the launch box's
          // button below, where it can say which agent it is about to spend.
          //
          // The needs-you variant takes the SAME solid yellow rather than an
          // ochre-tinted outline. On paper that outline was 15% ochre over
          // near-white: a washed tan that read as disabled, and read QUIETER than
          // the neutral status pill beside it — exactly backwards for the one
          // control asking something of the operator (POD-725, The Signal Rule).
          // Yellow fills; ochre writes, and it keeps doing the writing in the
          // status line.
          <Button
            type="button"
            size="sm"
            data-testid="task-primary-action"
            data-action={action.kind}
            disabled={starting}
            className="btn-primary-rim h-7 border px-2.5 text-[11.5px] font-semibold"
            onClick={runAction}
          >
            {action.label}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto size-7 text-text-dim"
          title="More issue actions"
          aria-label="More issue actions"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ x: rect.right - 4, y: rect.bottom + 4 })
          }}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </Button>
      </div>
      {/* THE LAUNCH BOX (POD-1457) — the same instrument the issue page's
          Sessions block wears, mounted here in place of the chip that could
          only ever start this task with whatever the filing agent happened to
          leave on it. Agent, model, effort and machine are all writes on the
          issue, so setting one here sets it everywhere; the button then simply
          starts. It mounts only where nobody is on the task, so it always wears
          its `Start work` face — see the box's `started` prop. */}
      {launchable && (
        <LaunchBox
          issue={issue}
          busy={starting}
          starting={starting}
          started={begun}
          commands={launchCommands}
          machines={machines}
          {...(placement
            ? {
                // THE FORK (POD-679). The plain button keeps the agent's own
                // call, so the fast path costs no extra click; this is for the
                // case the operator already knows the work is something else.
                // Both entries are phrased as the CONSEQUENCE for the origin —
                // "POD-516 can close without it" is what the operator is
                // actually choosing between, and `parentId` versus
                // `discovered-from` is not.
                fork: <PlacementMenu placement={placement} busy={starting} onStart={startWork} />,
              }
            : {})}
        />
      )}
      {menu && (
        <IssueContextMenu
          issues={[issue]}
          allIssues={issues}
          anchor={menu}
          onClose={() => setMenu(null)}
          onRequestClose={requestClose}
          // `dock`, not `sidebar`: identical in every respect but one — this
          // menu offers no `Open`, because the only place Open could land was
          // the Tasks tool, and this panel does not link there (POD-1457).
          surface="dock"
        />
      )}
      <IssueCloseDialog
        issue={issue}
        reason={closeReason}
        busy={closing}
        onOpenChange={(open) => !open && setCloseReason(null)}
        onConfirm={confirmClose}
      />
    </div>
  )
}
