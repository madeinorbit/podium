/**
 * The Sessions block of the properties aside: the model/effort/machine defaults
 * this issue's agents launch with, its member sessions, the forwarding ghosts of
 * sessions that moved on, and the start/add-session actions. Split out of
 * issue-page-properties.tsx (POD-646).
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
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronDown } from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentDefaultLabel,
  issueAgentIcon,
  issueAgentLabel,
  issueDefaultAgentKind,
} from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { PhaseTimer } from '@/lib/motion'
import { PropertyMenu } from '@/lib/PropertyMenu'
import { cn } from '@/lib/utils'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import { issueRefLong } from '../issue-card'
import type { IssuePageCommands } from '../issue-page-commands'
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
        '-mx-1.5 flex h-[26px] items-center gap-2 rounded-[4.8px] px-1.5 text-left transition-colors hover:bg-accent',
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
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
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

export function IssueAgentAction({
  mode,
  defaultAgent,
  busy,
  onDefault,
  onAgent,
}: {
  mode: 'start' | 'session'
  defaultAgent: string
  busy: boolean
  onDefault: () => void
  onAgent: (agentKind: IssueAgentKind) => void
}): JSX.Element {
  const primaryLabel = mode === 'start' ? 'Start work' : '+ Session'
  const chooseTitle = mode === 'start' ? 'Choose start agent' : 'Choose session agent'
  const variant = mode === 'start' ? undefined : 'secondary'
  const defaultKind = issueDefaultAgentKind(defaultAgent)
  const defaultLabel = issueAgentDefaultLabel(defaultAgent)
  return (
    <div className="inline-flex">
      <Button
        type="button"
        variant={variant}
        size="sm"
        className="rounded-r-none"
        disabled={busy}
        onClick={onDefault}
      >
        {primaryLabel}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant={variant}
              size="sm"
              className="rounded-l-none border-l-0 px-2"
              disabled={busy}
              title={chooseTitle}
              aria-label={chooseTitle}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onDefault}>
            {issueAgentIcon(defaultAgent)}
            {mode === 'start' ? `Start with ${defaultLabel}` : `New ${defaultLabel} session`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {ISSUE_AGENT_KINDS.filter((kind) => kind !== defaultKind).map((kind) => (
            <DropdownMenuItem key={kind} onClick={() => onAgent(kind)}>
              {issueAgentIcon(kind)}
              {mode === 'start'
                ? `Start with ${issueAgentLabel(kind)}`
                : `New ${issueAgentLabel(kind)} session`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
  machines: { id: string; name: string; online: boolean }[]
  onOpenSession: (session: { sessionId: SessionId }) => void
}): JSX.Element {
  const resolve = useIssueEdgeResolver()
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading count={String(issue.sessionSummary?.total ?? 0)}>Sessions</SectionHeading>
      {/* Model + effort the issue's sessions launch with (scoped to its agent). */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ModelPicker
          agentKind={issueDefaultAgentKind(issue.defaultAgent)}
          value={issue.defaultModel}
          onChange={commands.setDefaultModel}
        />
        <EffortPicker
          agentKind={issueDefaultAgentKind(issue.defaultAgent)}
          model={issue.defaultModel}
          value={issue.defaultEffort}
          onChange={commands.setDefaultEffort}
        />
        {/* Machine pin — which daemon runs this issue's agents ('auto' = repo affinity). */}
        {machines.length > 1 && (
          <PropertyMenu
            selectedValue={issue.machineId ?? 'auto'}
            options={[
              { value: 'auto', label: 'auto machine' },
              ...machines.map((m) => ({
                value: m.id,
                label: m.online ? m.name : `${m.name} (offline)`,
              })),
            ]}
            onSelect={(v) => commands.setMachine(v === 'auto' ? null : v)}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                className="h-7 gap-1 px-2 text-[12px]"
              >
                {issue.machineId
                  ? (machines.find((m) => m.id === issue.machineId)?.name ?? issue.machineId)
                  : 'auto machine'}
              </Button>
            }
          />
        )}
      </div>
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
                  <span className="flex-none font-mono text-[9px] text-text-faint tabular-nums">
                    ⤷ {dest ? issueDisplayRef(dest) : 'elsewhere'}
                  </span>
                }
              />
            )
          })}
        </div>
      )}
      {issue.worktreePath ? (
        <div className="flex gap-2">
          <IssueAgentAction
            mode="session"
            defaultAgent={issue.defaultAgent}
            busy={busy}
            onDefault={() => commands.addSession()}
            onAgent={(agentKind) => commands.addSession(agentKind)}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={commands.addShell}
          >
            + Shell
          </Button>
        </div>
      ) : (
        <IssueAgentAction
          mode="start"
          defaultAgent={issue.defaultAgent}
          busy={busy}
          onDefault={() => commands.startWork()}
          onAgent={(agentKind) => commands.startWork(agentKind)}
        />
      )}
    </section>
  )
}
