/**
 * The Sessions block of the properties aside: who is on this task, the ghosts of
 * sessions that moved on, and — until somebody picks the work up — the launch
 * box holding the agent / model / effort / machine it starts with and the button
 * that starts it. Split out of issue-page-properties.tsx (POD-646); the box is
 * {@link LaunchBox} (POD-1224), shared with the right dock's task panel since
 * POD-1457.
 *
 * THE BOX LEAVES WHEN THE WORK BEGINS (POD-1585). It is a launch instrument, and
 * on running work there is nothing left to launch: the block is then the roster
 * and only the roster. Its old second face — `+ Session` beside `+ Shell` — put
 * the two loudest buttons in the aside on the one state that wanted neither, and
 * both moves live where they belong already (the flight deck spawns an agent
 * onto running work; a shell is a tab).
 *
 * PARTIAL WORLD, TWICE OVER.
 *
 *  1. A MEMBER SESSION the principal cannot see is simply not in `sessions`, and
 *     the list renders what it holds. It does NOT render a placeholder row for a
 *     member id it cannot resolve: a stub saying "a session you cannot see"
 *     would be an existence claim about a session, which is a §3.1.2 policy
 *     question this surface's cross-boundary decision does not cover (that one
 *     is about ISSUE edges). Silence is the conservative answer, and it is the
 *     behaviour that already shipped.
 *  2. A MOVED-ON session points at the ISSUE it continued on, and that IS an
 *     issue edge — so it resolves through the same resolver and policy as every
 *     other one, instead of the `byId.get()` that rendered invisible and deleted
 *     alike as "another issue".
 */
import { motionPhase, motionTiming } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionId, SessionMeta } from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { PhaseTimer } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import { isOpenSession } from '../IssueCompactControls'
import { issueRefLong } from '../issue-card'
import type { IssuePageCommands } from '../issue-page-commands'
import { issueWorkBegun, LaunchBox, type LaunchMachine } from '../LaunchBox'
import { SectionHeading } from './chrome'
import { edgeIssue, useIssueEdgeResolver } from './issue-edges'

/**
 * ONE ROSTER ROW — the harness mark, the session's name, and what it is doing.
 *
 * The block used to list session titles as bare ghost buttons: the richest,
 * most Podium-specific data on the page rendered as the plainest thing on it,
 * and the only surface in the app where a session appeared without its mark or
 * its phase. It now speaks the same three-part sentence the sidebar row, the
 * Now block and the board card's fleet stack all speak.
 */
function SessionRosterRow({
  session,
  issue,
  onOpen,
  muted = false,
  trailing,
  title,
}: {
  session: SessionMeta
  issue: IssueViewModel
  onOpen: () => void
  muted?: boolean
  trailing?: JSX.Element | null
  title?: string
}): JSX.Element {
  const AgentIcon = agentIconFor(session.agentKind)
  const timing = motionTiming(session)
  const phase = motionPhase(session, issue as unknown as IssueWire)
  return (
    <button
      data-pressable
      type="button"
      className={cn(
        // 28px, the rail's one list-row height (POD-1163) — the relations rows
        // below ran 24 and this ran 30, so two lists in the same column had two
        // cadences and neither matched the 30px property rows above them.
        '-mx-1.5 flex h-7 items-center gap-2 rounded-[4.8px] px-1.5 text-left transition-colors hover:bg-accent/60',
        muted && 'opacity-70',
      )}
      title={title ?? `Open ${sessionDisplayName(session)}`}
      onClick={onOpen}
    >
      <span
        className={cn(
          'flex size-[17px] flex-none items-center justify-center rounded-[5px] border',
          agentFleetTileTint(session.agentKind),
        )}
      >
        {AgentIcon ? <AgentIcon size={11} strokeWidth={1.8} aria-hidden="true" /> : '✳'}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90">
        {sessionDisplayName(session)}
      </span>
      {trailing ?? (
        <PhaseTimer
          phase={timing.phase}
          sinceMs={timing.sinceMs}
          {...(timing.baseMs !== undefined ? { baseMs: timing.baseMs } : {})}
          {...(timing.totalMs !== undefined ? { totalMs: timing.totalMs } : {})}
          size={9}
          mutedWaiting={phase !== 'waiting'}
        />
      )}
    </button>
  )
}

export function IssueSessionsBlock({
  issue,
  busy,
  commands,
  memberSessions,
  movedOn,
  machines,
  onOpenSession,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  memberSessions: SessionMeta[]
  /** Forwarding ghosts (POD-89): sessions BORN here that re-homed elsewhere.
   *  "No agents" was misread as work lost — the honest shape is "the agent moved
   *  on to POD-x". */
  movedOn: SessionMeta[]
  machines: LaunchMachine[]
  onOpenSession: (session: { sessionId: SessionId }) => void
}): JSX.Element {
  const resolve = useIssueEdgeResolver()
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading count={String(issue.sessionSummary?.total ?? 0)}>Sessions</SectionHeading>
      {memberSessions.length > 0 && (
        <div className="flex flex-col">
          {memberSessions.map((s) => (
            <SessionRosterRow
              key={s.sessionId}
              session={s}
              issue={issue}
              onOpen={() => onOpenSession(s)}
            />
          ))}
        </div>
      )}
      {movedOn.length > 0 && (
        <div className="flex flex-col" data-testid="moved-on-sessions">
          {movedOn.map((s) => {
            const dest = edgeIssue(resolve(s.issueId))
            return (
              <SessionRosterRow
                key={s.sessionId}
                session={s}
                issue={issue}
                muted
                title={dest ? `Session continued on ${issueRefLong(dest)}` : 'Session moved on'}
                onOpen={() => onOpenSession(s)}
                trailing={
                  <span className="flex-none font-mono shell-type-micro text-text-faint tabular-nums">
                    ⤷ {dest ? issueDisplayRef(dest) : 'elsewhere'}
                  </span>
                }
              />
            )
          })}
        </div>
      )}
      {/* Same reading as the dock's, from the roster this block already holds:
          an agent on it, a checkout, or a stage whose name says somebody picked
          it up (see {@link issueWorkBegun}). */}
      {!issueWorkBegun(issue, memberSessions.filter(isOpenSession).length) && (
        <LaunchBox issue={issue} busy={busy} commands={commands} machines={machines} />
      )}
    </section>
  )
}
