import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { motionPhase } from '@podium/client-core/viewmodels'
import type { IssueId, IssueStage, SessionMeta } from '@podium/model'
import { ChevronDown, GitBranch, GitCommit, MoreHorizontal, RotateCcw } from 'lucide-react'
import { type JSX, useState } from 'react'
import { toast } from 'sonner'
import type { IssueViewModel } from '@/app/store'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { OfferBar } from '@/features/chat/OfferBar'
import { issueNeedsHuman, sessionNeedsHuman } from '@/lib/mission'
import { type ContextMenuAnchor, SessionContextMenu } from '@/lib/SessionContextMenu'
import { cn } from '@/lib/utils'
import { SessionNameEditor, sessionDisplayName, WorkerLabel } from '@/lib/WorkerLabel'
import { IssueContextMenu } from './IssueContextMenu'
import { STAGE_LABELS } from './issue-card'
import { StageGlyph } from './issue-glyphs'
import { IssueCloseDialog, type IssueCloseReason } from './issue-lifecycle'

/** Every stage a live issue can be moved between. `done` is not one of them —
 *  see the close dialog. */
const OPEN_STAGES = (Object.keys(STAGE_LABELS) as IssueStage[]).filter((stage) => stage !== 'done')

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
function byRecency(a: SessionMeta, b: SessionMeta): number {
  return b.lastActiveAt.localeCompare(a.lastActiveAt)
}

/**
 * The session that speaks for the issue: its coordinator when one is named,
 * else the most recently active live session. Same fallback order the selection
 * contract states (coordinator → lone member → most recently active member).
 */
export function coordinatorSession(
  issue: IssueViewModel,
  active: readonly SessionMeta[],
): SessionMeta | undefined {
  return (
    active.find((session) => session.sessionId === issue.coordinatorSessionId) ??
    [...active].sort(byRecency)[0]
  )
}

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

export type TaskActionKind = 'answer' | 'mark-done' | 'open-coordinator' | 'start-work'

export interface TaskAction {
  kind: TaskActionKind
  label: string
  /** The needs-you variant carries the warn treatment. */
  warn: boolean
}

/**
 * The one primary action the task head offers, resolved from the issue's own
 * state: needs-you → Answer (or Mark done on a handed-off origin, where the
 * work has left and closing is the only decision left); else a live session →
 * Open coordinator; else → Start work.
 */
export function resolveTaskAction(
  issue: IssueViewModel,
  active: readonly SessionMeta[],
): TaskAction {
  if (issueNeedsHuman(issue, active)) {
    const handedOff =
      active.length === 0 && (issue.dependents ?? []).some((dep) => dep.type === 'discovered-from')
    return handedOff
      ? { kind: 'mark-done', label: 'Mark done', warn: true }
      : { kind: 'answer', label: 'Answer', warn: true }
  }
  if (active.length > 0) return { kind: 'open-coordinator', label: 'Open coordinator', warn: false }
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

/** Git evidence scoped to this issue — the branch it delivers on, what is
 *  waiting to land, and dirt this issue is answerable for. */
export function IssueGitScope({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  const git = issue.gitState
  if (!git) return null
  const attributedDirty = git.dirtyOwn ?? (!git.shared && !git.fallback ? git.dirtyFiles : 0)
  const delivery = git.shared ? (git.commits?.length ?? 0) : (git.ahead ?? 0)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <GitBranch size={12} aria-hidden="true" />
        {git.branch ?? (git.shared ? 'Shared checkout' : (issue.branch ?? 'Checkout'))}
      </span>
      {delivery > 0 && (
        <span className="inline-flex items-center gap-1.5 text-foreground/80">
          <GitCommit size={12} aria-hidden="true" />
          {delivery} commit{delivery === 1 ? '' : 's'} awaiting delivery
        </span>
      )}
      {attributedDirty > 0 && (
        <span className="text-amber-500">
          {attributedDirty} dirty file{attributedDirty === 1 ? '' : 's'} · this issue
        </span>
      )}
    </div>
  )
}

/**
 * One session under "Agents & sessions": the harness tile and name the rest of
 * the shell uses, its agent-state word, and every lifecycle action behind the
 * shared session context menu (right-click or •••) rather than a bespoke button
 * pair.
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
  return (
    <div
      className={cn(
        'group/session flex min-h-[31px] items-center gap-2 border-b border-border/40 px-1',
        retired && 'opacity-60',
      )}
      data-testid="dock-session-row"
    >
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
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[12.5px] text-foreground/90"
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
      <span className="flex-none font-mono text-[10px] text-muted-foreground">
        {sessionStateLabel(session)}
      </span>
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
      {menu && (
        <SessionContextMenu
          session={session}
          anchor={menu}
          onClose={() => setMenu(null)}
          onRename={() => {
            setMenu(null)
            setEditing(true)
          }}
        />
      )}
    </div>
  )
}

/**
 * The "Needs you" band and whatever the operator has to act on — the agent's
 * offer chips, and the resolve control for a raised flag. It sits between the
 * fixed head and the scroll, exactly where the artifact puts the decision.
 */
export function IssueDecisionBand({ issue }: { issue: IssueViewModel }): JSX.Element | null {
  const { trpc, sessions } = useStoreSelector(
    (s) => ({ trpc: s.trpc, sessions: s.sessions }),
    shallowEqual,
  )
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())
  const active = issueSessions(issue, sessions).filter(isOpenSession)
  if (!issueNeedsHuman(issue, active)) return null
  const offers = active.flatMap((session) =>
    session.offer ? [{ session, offer: session.offer }] : [],
  )

  const sendOffer = (session: SessionMeta, prompt: string): void => {
    setSending((current) => new Set(current).add(session.sessionId))
    trpc.sessions.sendText
      .mutate({ sessionId: session.sessionId, text: prompt, mutationId: randomUUID() })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() =>
        setSending((current) => {
          const next = new Set(current)
          next.delete(session.sessionId)
          return next
        }),
      )
  }

  return (
    <div className="flex flex-col gap-2 px-3 pt-2.5" data-testid="dock-decision-band">
      <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.07] px-2.5 py-2 text-[12px] leading-relaxed">
        <span className="font-semibold text-amber-600 dark:text-amber-300">Needs you</span>{' '}
        <span className="text-foreground/85">{decisionLine(issue, active)}</span>
        {issue.needsHuman && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 flex h-6 text-[11px]"
            onClick={() =>
              trpc.issues.clearNeedsHuman
                .mutate({ id: issue.id })
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error)),
                )
            }
          >
            Mark resolved
          </Button>
        )}
      </div>
      {offers.map(({ session, offer }) => (
        <OfferBar
          key={`${session.sessionId}:${offer.createdAt}`}
          offer={offer}
          session={session}
          disabled={sending.has(session.sessionId)}
          onAction={(prompt) => sendOffer(session, prompt)}
        />
      ))}
    </div>
  )
}

/**
 * The task head's control strip: the stage dropdown, the ONE primary action the
 * issue's state resolves to, and the shared issue context menu. Every other
 * lifecycle affordance lives in that menu rather than competing for the row.
 */
export function IssueCompactControls({ issue }: { issue: IssueViewModel }): JSX.Element {
  const { trpc, sessions, setOpenIssueId, setView, navigateToSession } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      sessions: s.sessions,
      setOpenIssueId: s.setOpenIssueId,
      setView: s.setView,
      navigateToSession: s.navigateToSession,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [closeReason, setCloseReason] = useState<IssueCloseReason | null>(null)
  const [closing, setClosing] = useState(false)
  const [starting, setStarting] = useState(false)

  const openFull = (id: IssueId = issue.id): void => {
    setOpenIssueId(id)
    setView('issues')
  }
  const active = issueSessions(issue, sessions).filter(isOpenSession)
  const action = resolveTaskAction(issue, active)
  const closed = Boolean(issue.closedReason) || issue.archived

  const confirmClose = (reason: IssueCloseReason): void => {
    setClosing(true)
    trpc.issues.close
      .mutate({ id: issue.id, reason })
      .then(() => setCloseReason(null))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setClosing(false))
  }

  const runAction = (): void => {
    switch (action.kind) {
      case 'answer': {
        // Go to whoever is actually waiting; the issue page is the fallback for
        // a flag raised with no session behind it.
        const target =
          active.find((session) => sessionNeedsHuman(session)) ?? coordinatorSession(issue, active)
        if (target) navigateToSession(target.sessionId)
        else openFull()
        return
      }
      case 'mark-done':
        setCloseReason('done')
        return
      case 'open-coordinator': {
        const target = coordinatorSession(issue, active)
        if (target) navigateToSession(target.sessionId)
        return
      }
      case 'start-work':
        setStarting(true)
        trpc.issues.start
          .mutate({ id: issue.id })
          .catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : String(error)),
          )
          .finally(() => setStarting(false))
        return
    }
  }

  return (
    <div className="mt-2.5 flex items-center gap-1.5">
      {/* Stage, exposed as a first-class dock action. Built from the shell's
          own dropdown rather than a native <select>, which exists nowhere in
          this chrome. `done` is deliberately absent: closing an issue goes
          through the close dialog so a reason is always recorded. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Stage"
              className="h-7 flex-none gap-1.5 px-2 text-[11.5px]"
            >
              <StageGlyph stage={issue.stage} size={12} />
              {STAGE_LABELS[issue.stage]}
              <ChevronDown size={11} aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          {OPEN_STAGES.map((stage) => (
            <DropdownMenuItem
              key={stage}
              onClick={() =>
                trpc.issues.update
                  .mutate({ id: issue.id, patch: { stage } })
                  .catch((error: unknown) =>
                    toast.error(error instanceof Error ? error.message : String(error)),
                  )
              }
            >
              <StageGlyph stage={stage} size={12} />
              {STAGE_LABELS[stage]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {closed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-[11.5px]"
          onClick={() =>
            trpc.issues.update
              .mutate({ id: issue.id, patch: { stage: 'backlog' } })
              .catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : String(error)),
              )
          }
        >
          <RotateCcw size={12} aria-hidden="true" /> Reopen issue
        </Button>
      ) : (
        <Button
          type="button"
          variant={action.warn ? 'outline' : 'default'}
          size="sm"
          data-testid="task-primary-action"
          data-action={action.kind}
          disabled={starting}
          className={cn(
            'h-7 px-2.5 text-[11.5px] font-semibold',
            action.warn &&
              'border-amber-500/50 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-200',
          )}
          onClick={runAction}
        >
          {starting && action.kind === 'start-work' ? 'Starting…' : action.label}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="ml-auto size-7"
        title="More issue actions"
        aria-label="More issue actions"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({ x: rect.right - 4, y: rect.bottom + 4 })
        }}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </Button>
      {menu && (
        <IssueContextMenu
          issues={[issue]}
          allIssues={issues}
          anchor={menu}
          onClose={() => setMenu(null)}
          onOpen={openFull}
          onRequestClose={setCloseReason}
          surface="sidebar"
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
