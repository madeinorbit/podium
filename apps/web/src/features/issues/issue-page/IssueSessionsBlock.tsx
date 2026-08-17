/**
 * The Sessions block of the properties aside: who is on this task, the ghosts of
 * sessions that moved on, and — in one launch box — the agent / model / effort /
 * machine the next one starts with, plus the button that starts it. Split out of
 * issue-page-properties.tsx (POD-646); the box is {@link LaunchBox} (POD-1224).
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
import {
  asMachineId,
  type IssueWire,
  type SessionId,
  type SessionMeta,
} from '@podium/model/browser'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronDown } from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import {
  ISSUE_AGENT_KINDS,
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

/**
 * THE LAUNCH BOX (POD-1224) — the four decisions that make a session, and the
 * button that spends them, inside one frame.
 *
 * They were four separate objects scattered down the band: a model pill and an
 * effort pill on one line, a machine pill sometimes beside them, the roster in
 * between, and a split "Start work" button at the foot whose hidden dropdown was
 * the ONLY way to say which agent to run. So the most consequential choice on
 * the page lived behind a chevron, and the three pills above it looked like
 * properties of the issue rather than the settings the button was about to use.
 *
 * It is now the same instrument the empty-state prompt box wears
 * (features/setup/ColdStartComposer.tsx): one well cut into a card, segments
 * divided by hairlines, and the launch action under it. Same grammar, same
 * tokens — a well floor that is an alpha over whatever surface it lands on, so
 * one value reads as a recess in both modes.
 *
 * PICKING AN AGENT IS A WRITE, not a one-off. `defaultAgent` is what the issue
 * launches with everywhere — the CLI, the board, the next session started from
 * here — so the well sets it and the button simply starts. That also deletes the
 * old menu's two-headed copy ("Start with Claude Code (default)" beside "Start
 * with Codex"), which asked the operator to choose an agent and to know which
 * one was already the default in the same list.
 */
function LaunchBox({
  issue,
  busy,
  commands,
  machines,
}: {
  issue: IssueViewModel
  busy: boolean
  commands: IssuePageCommands
  machines: { id: string; name: string; online: boolean }[]
}): JSX.Element {
  const agentKind = issueDefaultAgentKind(issue.defaultAgent)
  const started = Boolean(issue.worktreePath)
  // THE SIGNAL RULE (POD-635). IssueGitBlock already stopped spending Superade
  // Yellow on a merge with nothing to land; this slab was still the loudest
  // pixel on every CLOSED task, offering to start work that has already
  // finished. Yellow marks what is being asked of the operator — a closed task
  // asks nothing, so the control stays, in outline.
  const spent = issue.closedReason != null || issue.stage === 'done' || issue.archived
  const machine = machines.find((m) => m.id === issue.machineId)
  // The same 15px tile the roster rows above wear, one size down: the agent this
  // task launches with and the agents already on it are then the same mark.
  const AgentIcon = agentIconFor(agentKind)
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-bar p-2 shadow-[inset_0_0_0_1px_var(--hairline-bar)]">
      <div className="overflow-hidden rounded-lg bg-[var(--well-floor)] shadow-[inset_0_0_0_1px_var(--hairline-bar)]">
        {/* WHO. Its own full-width row: at the rail's 232px of usable width an
            agent name, a model name and an effort in ONE row leaves each about
            seven characters, and "Claude Code" truncated to "Claude…" is a
            worse answer than a second row. */}
        <PropertyMenu
          selectedValue={agentKind}
          options={ISSUE_AGENT_KINDS.map((kind) => ({
            value: kind,
            label: issueAgentLabel(kind),
            icon: issueAgentIcon(kind),
          }))}
          placeholder="Choose an agent…"
          onSelect={commands.setDefaultAgent}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label="Agent"
              title={`Sessions on this task launch with ${issueAgentLabel(agentKind)}`}
              className="h-7 w-full justify-start gap-1.5 rounded-none px-2.5 font-normal text-[12px] text-text-strong"
            >
              <span
                className={cn(
                  'flex size-[15px] flex-none items-center justify-center rounded-[4px] border',
                  agentFleetTileTint(agentKind),
                )}
                aria-hidden="true"
              >
                {AgentIcon ? <AgentIcon size={10} strokeWidth={1.8} /> : '✳'}
              </span>
              <span className="min-w-0 truncate">{issueAgentLabel(agentKind)}</span>
              <ChevronDown size={13} aria-hidden="true" className="ml-auto text-text-faint" />
            </Button>
          }
        />
        <div className="h-px bg-hairline-bar" aria-hidden="true" />
        {/* HOW HARD, AND WHERE. Equal shares of one row; each segment truncates
            rather than pushing its own chevron out of the well.

            The seams are each segment's own LEFT BORDER, not `<span className="w-px">`
            dividers between them: a model with no effort ladder (Haiku, and
            several dated Sonnet slugs) makes `EffortPicker` render nothing at
            all, and a standalone divider would then be left drawing a seam
            against nothing. A border belongs to the segment it introduces, so it
            leaves with it. The buttons already reserve a 1px transparent border,
            so colouring one edge costs no layout. */}
        <div className="flex items-stretch">
          <ModelPicker
            variant="composer"
            className="min-w-0 shrink flex-1 justify-between"
            agentKind={agentKind}
            value={issue.defaultModel}
            onChange={commands.setDefaultModel}
          />
          <EffortPicker
            variant="composer"
            className="min-w-0 shrink flex-1 justify-between border-l-hairline-bar"
            agentKind={agentKind}
            model={issue.defaultModel}
            value={issue.defaultEffort}
            onChange={commands.setDefaultEffort}
          />
          {/* The machine pin only exists as a question when there is more than
              one machine to pin to ('auto' = repo affinity). */}
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
              onSelect={(v) => commands.setMachine(v === 'auto' ? null : asMachineId(v))}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label="Machine"
                  className="h-7 min-w-0 shrink flex-1 justify-between gap-1 rounded-none border-l-hairline-bar px-2.5 font-mono text-[11px] font-normal text-text-dim"
                >
                  <span className="min-w-0 truncate">{machine?.name ?? 'auto'}</span>
                  <ChevronDown size={13} aria-hidden="true" className="text-text-faint" />
                </Button>
              }
            />
          )}
        </div>
      </div>

      {started ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={busy}
            onClick={() => commands.addSession()}
          >
            + Session
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={busy}
            onClick={commands.addShell}
          >
            + Shell
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant={spent ? 'outline' : 'default'}
          size="sm"
          className="w-full"
          disabled={busy}
          onClick={() => commands.startWork()}
        >
          Start work
        </Button>
      )}
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
      <LaunchBox issue={issue} busy={busy} commands={commands} machines={machines} />
    </section>
  )
}
