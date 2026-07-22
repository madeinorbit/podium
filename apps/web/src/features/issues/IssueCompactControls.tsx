import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import {
  Archive,
  ArchiveRestore,
  ExternalLink,
  GitBranch,
  GitCommit,
  MoreHorizontal,
  Play,
  RotateCcw,
  Users,
} from 'lucide-react'
import { type JSX, useState } from 'react'
import { toast } from 'sonner'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { OfferBar } from '@/features/chat/OfferBar'
import { isSessionWorking, motionPhase, sessionDotClass } from '@/lib/derive'
import { IssueContextMenu } from './IssueContextMenu'
import { IssueCloseDialog, type IssueCloseReason } from './issue-lifecycle'
import { isIssueStartable } from './issue-startable'

function sessionState(session: SessionMeta): string {
  if (session.archived) return 'Retired'
  if (session.status === 'hibernated') return 'Paused'
  const phase = motionPhase(session)
  if (phase === 'working') return 'Working'
  if (phase === 'waiting') return 'Waiting on you'
  if (phase === 'done') return 'Done'
  if (session.status === 'starting' || session.status === 'reconnecting') return 'Starting'
  if (session.status === 'exited') return 'Exited'
  return 'Idle'
}

function sessionName(session: SessionMeta): string {
  return session.name || session.title || session.displayRef || 'Untitled session'
}

function GitScope({ issue }: { issue: IssueWire }): JSX.Element | null {
  const git = issue.gitState
  if (!git) return null
  const attributedDirty = git.dirtyOwn ?? (!git.shared && !git.fallback ? git.dirtyFiles : 0)
  const delivery = git.shared ? (git.commits?.length ?? 0) : (git.ahead ?? 0)
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground">
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

function SessionRow({
  session,
  onOpen,
  onArchive,
}: {
  session: SessionMeta
  onOpen: () => void
  onArchive: (archived: boolean) => void
}): JSX.Element {
  return (
    <div className="group/session flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/40">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onOpen}
      >
        <span className={sessionDotClass(session)} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
          {sessionName(session)}
        </span>
        <span className="flex-none text-[10.5px] text-muted-foreground">
          {sessionState(session)}
        </span>
      </button>
      <button
        type="button"
        className="inline-flex h-6 flex-none items-center gap-1 rounded px-1.5 text-[10.5px] text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground group-hover/session:opacity-100"
        onClick={() => onArchive(!session.archived)}
      >
        {session.archived ? (
          <ArchiveRestore size={11} aria-hidden="true" />
        ) : (
          <Archive size={11} aria-hidden="true" />
        )}
        {session.archived ? 'Restore' : 'Retire'}
      </button>
    </div>
  )
}

/**
 * The interaction layer shared by both compact issue surfaces. The surrounding
 * IssuePanelView still owns the content sections; this owns escalation, offers,
 * execution state, scoped git evidence, and guarded lifecycle actions.
 */
export function IssueCompactControls({ issue }: { issue: IssueWire }): JSX.Element {
  const { trpc, issues, setOpenIssueId, setView, navigateToSession, archiveSession } =
    useStoreSelector(
      (s) => ({
        trpc: s.trpc,
        issues: s.issues,
        setOpenIssueId: s.setOpenIssueId,
        setView: s.setView,
        navigateToSession: s.navigateToSession,
        archiveSession: s.archiveSession,
      }),
      shallowEqual,
    )
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [closeReason, setCloseReason] = useState<IssueCloseReason | null>(null)
  const [closing, setClosing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set())

  const openFull = (id = issue.id): void => {
    setOpenIssueId(id)
    setView('issues')
  }
  const activeSessions = issue.sessions.filter((session) => !session.archived)
  const retiredSessions = issue.sessions.filter((session) => session.archived)
  const offers = activeSessions.flatMap((session) =>
    session.offer ? [{ session, offer: session.offer }] : [],
  )

  const setArchived = (session: SessionMeta, archived: boolean): void => {
    if (archived && isSessionWorking(session)) {
      const ok = window.confirm(
        'Retire this working session? Its current turn will stop. The issue remains open and the session can be restored.',
      )
      if (!ok) return
    }
    archiveSession(session.sessionId, archived).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    )
  }

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

  return (
    <div className="mt-2.5 flex flex-col gap-2.5">
      {issue.description.trim() && (
        <p className="line-clamp-3 text-[12px] leading-relaxed text-muted-foreground">
          {issue.description}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {isIssueStartable(issue) && (
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[11.5px]"
            disabled={starting}
            onClick={() => {
              setStarting(true)
              trpc.issues.start
                .mutate({ id: issue.id })
                .catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setStarting(false))
            }}
          >
            <Play size={12} aria-hidden="true" /> {starting ? 'Starting…' : 'Run now'}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-[11.5px]"
          data-testid="compact-open-full"
          onClick={() => openFull()}
        >
          <ExternalLink size={12} aria-hidden="true" /> Open full issue
        </Button>
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
      </div>

      {issue.needsHuman && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2.5">
          <div className="text-[10px] font-semibold tracking-[0.09em] text-amber-500 uppercase">
            Decision needed
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-foreground/90">
            {issue.humanQuestion || 'This issue is waiting for human input.'}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-7 text-[11px]"
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
        </div>
      )}

      {offers.map(({ session, offer }) => (
        <OfferBar
          key={`${session.sessionId}:${offer.createdAt}`}
          offer={offer}
          session={session}
          disabled={sending.has(session.sessionId)}
          onAction={(prompt) => sendOffer(session, prompt)}
        />
      ))}

      {(activeSessions.length > 0 || retiredSessions.length > 0) && (
        <div className="rounded-lg border border-border/60 bg-muted/15 px-2.5 py-2">
          <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            <Users size={11} aria-hidden="true" /> Sessions
            <span className="ml-auto font-mono font-normal tracking-normal">
              {activeSessions.length} active
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {activeSessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                onOpen={() => navigateToSession(session.sessionId)}
                onArchive={(archived) => setArchived(session, archived)}
              />
            ))}
          </div>
          {retiredSessions.length > 0 && (
            <details className="mt-1 border-border/50 border-t pt-1">
              <summary className="cursor-pointer px-1 py-1 text-[10.5px] text-muted-foreground hover:text-foreground">
                Retired sessions · {retiredSessions.length}
              </summary>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {retiredSessions.map((session) => (
                  <SessionRow
                    key={session.sessionId}
                    session={session}
                    onOpen={() => navigateToSession(session.sessionId)}
                    onArchive={(archived) => setArchived(session, archived)}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <GitScope issue={issue} />

      {issue.closedReason && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 w-fit gap-1.5 text-[11px]"
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
      )}

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
