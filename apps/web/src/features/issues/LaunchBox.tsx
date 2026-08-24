/**
 * THE LAUNCH BOX (POD-1224, shared since POD-1457) — the four decisions that
 * make a session, and the button that spends them, inside one frame.
 *
 * They were four separate objects scattered down the issue page's properties
 * band: a model pill and an effort pill on one line, a machine pill sometimes
 * beside them, the roster in between, and a split "Start work" button at the
 * foot whose hidden dropdown was the ONLY way to say which agent to run. So the
 * most consequential choice on the page lived behind a chevron, and the three
 * pills above it looked like properties of the issue rather than the settings
 * the button was about to use.
 *
 * It is the same instrument the empty-state prompt box wears
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
 *
 * IT LIVES IN TWO PLACES (POD-1457). The issue page's Sessions block owns it,
 * and the right dock's task panel — the issue explorer — mounts the same box in
 * place of the bare `Start work` chip it used to carry. The dock's chip could
 * say WHETHER to start and (for discovered work) WHERE, but never with what: an
 * operator who wanted Codex on this one had to leave the explorer, open the full
 * page, set it there, and come back. One box, one grammar, both surfaces.
 */
import {
  asMachineId,
  HOST_REPOS,
  type MachineActionCopy,
  type MachineComponent,
  type MachineId,
  type MachineUseDecision,
} from '@podium/model/browser'
import { ChevronDown } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import type { IssueViewModel } from '@/app/store'
import { Button } from '@/components/ui/button'
import { CapabilityAgentMenu } from '@/lib/agent-capability'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { issueAgentLabel, issueDefaultAgentKind } from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { PropertyMenu } from '@/lib/PropertyMenu'
import {
  machineOptionLabel,
  useMachineChoices,
} from '@/features/machines/machine-choices'

/** What this pin is for — see `MachineActionCopy`. */
const ISSUE_HOME_COPY: MachineActionCopy = {
  action: 'hold this issue',
  capability: 'hold worktrees',
  remedy: 'Pair a machine that runs the Podium daemon.',
}
import { cn } from '@/lib/utils'
import { useAgentFleetOptions } from './use-agent-fleet-options'

export interface LaunchMachine {
  id: string
  name: string
  online: boolean
  /** POD-2700: the durable structural axis. An issue's machine is where its
   *  worktree lives, so a machine with no daemon can never be its home. */
  components?: readonly MachineComponent[]
  use?: MachineUseDecision
}

/**
 * What the box needs to be able to do. Deliberately narrower than
 * `IssuePageCommands` (which satisfies it structurally) so the dock can hand in
 * seven closures over the store instead of the page's whole command set.
 */
export interface LaunchCommands {
  setDefaultAgent: (defaultAgent: string) => void
  setDefaultModel: (defaultModel: string) => void
  setDefaultEffort: (defaultEffort: string) => void
  setMachine: (machineId: MachineId | null) => void
  startWork: () => void
  addSession: () => void
  addShell: () => void
}

export function LaunchBox({
  issue,
  busy,
  starting = false,
  started: startedOverride,
  commands,
  machines,
  fork,
}: {
  issue: IssueViewModel
  busy: boolean
  /** The start itself is in flight — the button says so. Distinct from `busy`,
   *  which any property write raises. */
  starting?: boolean
  /**
   * Override the derived "this task already has a checkout" test.
   *
   * A CHECKOUT IS NOT AN AGENT. The issue page's aside is always mounted, so a
   * surviving worktree is the best available proof that work has begun and the
   * foot becomes `+ Session` / `+ Shell`. The dock mounts the box only where
   * NOBODY is on the task, and there a worktree left behind by an exited
   * session is not work in progress — `Start work` is the honest face, and it
   * is the one that surface has always shown.
   */
  started?: boolean
  commands: LaunchCommands
  machines: LaunchMachine[]
  /** WHERE the work will live, offered at the moment it starts (POD-679). The
   *  explorer hands in its placement chevron, which then rides the right edge of
   *  Start work as one split control. */
  fork?: ReactNode
}): JSX.Element {
  const agentKind = issueDefaultAgentKind(issue.defaultAgent)
  const started = startedOverride ?? Boolean(issue.worktreePath)
  // THE SIGNAL RULE (POD-635). IssueGitBlock already stopped spending Superade
  // Yellow on a merge with nothing to land; this slab was still the loudest
  // pixel on every CLOSED task, offering to start work that has already
  // finished. Yellow marks what is being asked of the operator — a closed task
  // asks nothing, so the control stays, in outline.
  const spent = issue.closedReason != null || issue.stage === 'done' || issue.archived
  const machine = machines.find((m) => m.id === issue.machineId)
  const machineChoices = useMachineChoices(machines, HOST_REPOS, ISSUE_HOME_COPY, issue.machineId)
  // The same 15px tile the roster rows above wear, one size down: the agent this
  // task launches with and the agents already on it are then the same mark.
  const AgentIcon = agentIconFor(agentKind)
  // WHICH HARNESSES THIS TASK'S MACHINES CAN ACTUALLY RUN (POD-1457). The same
  // fleet reading, and the same greyed rows, as every other spawn menu in the
  // shell — a Cursor this repo's hosts do not have says so here rather than
  // failing later as a dead session.
  const agentOptions = useAgentFleetOptions(issue)
  return (
    <div
      data-testid="launch-box"
      className="flex flex-col gap-2 rounded-[10px] bg-bar p-2 shadow-[inset_0_0_0_1px_var(--hairline-bar)]"
    >
      <div className="overflow-hidden rounded-lg bg-[var(--well-floor)] shadow-[inset_0_0_0_1px_var(--hairline-bar)]">
        {/* WHO. Its own full-width row: at the rail's 232px of usable width an
            agent name, a model name and an effort in ONE row leaves each about
            seven characters, and "Claude Code" truncated to "Claude…" is a
            worse answer than a second row. */}
        <CapabilityAgentMenu
          selectedValue={agentKind}
          options={agentOptions}
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
            machineId={issue.machineId}
            value={issue.defaultModel}
            onChange={commands.setDefaultModel}
          />
          <EffortPicker
            variant="composer"
            className="min-w-0 shrink flex-1 justify-between border-l-hairline-bar"
            agentKind={agentKind}
            machineId={issue.machineId}
            model={issue.defaultModel}
            value={issue.defaultEffort}
            onChange={commands.setDefaultEffort}
          />
          {/* The machine pin only exists as a question when there is more than
              one machine to pin to ('auto' = repo affinity) — or when there is
              something to explain about the ones that are missing (POD-2700).

              WHY THIS IS FILTERED AT ALL: the pin decides where the issue's
              worktree is cut and where its agents run, so a machine that runs no
              Podium daemon can never be its home. It used to be offered anyway,
              and an issue homed there dead-ended at start. Offline machines DO
              stay in the list, labelled — an asleep laptop is still a valid home
              for work that starts tomorrow. */}
          {(machineChoices.options.length > 1 || machineChoices.exclusionNote) && (
            <PropertyMenu
              selectedValue={issue.machineId ?? 'auto'}
              footnote={machineChoices.exclusionNote}
              options={[
                { value: 'auto', label: 'auto machine' },
                ...machineChoices.options.map((choice) => ({
                  value: choice.machine.id,
                  label: machineOptionLabel(choice),
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
        // THE FORK RIDES THE BUTTON (POD-679). The plain press keeps the shape
        // the filing agent chose, so the fast path costs no extra click; the
        // chevron is for the case the operator already knows the work is
        // something else. One control, so the two halves share a rim.
        <div className="flex items-stretch">
          <Button
            type="button"
            variant={spent ? 'outline' : 'default'}
            size="sm"
            data-testid="task-primary-action"
            data-action="start-work"
            className={cn('min-w-0 flex-1', fork && 'rounded-r-none')}
            disabled={busy}
            onClick={() => commands.startWork()}
          >
            {starting ? 'Starting…' : 'Start work'}
          </Button>
          {fork}
        </div>
      )}
    </div>
  )
}
