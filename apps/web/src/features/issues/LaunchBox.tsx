import { here } from '@podium/client-graph/lookup'
import { isFinished } from '@podium/model/browser'
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
 * The settings are owned by IssueAgentSettings, also used in the ref miniview.
 * IT LIVES IN TWO PLACES (POD-1457). The issue page's Sessions block owns it,
 * and the right dock's task panel — the issue explorer — mounts the same box in
 * place of the bare `Start work` chip it used to carry. The dock's chip could
 * say WHETHER to start and (for discovered work) WHERE, but never with what: an
 * operator who wanted Codex on this one had to leave the explorer, open the full
 * page, set it there, and come back. One box, one grammar, both surfaces.
 *
 * IT EXISTS ONLY BEFORE THE WORK STARTS (POD-1585). The box is a LAUNCH
 * instrument: four decisions and the button that spends them. Once an agent is
 * on the task those decisions are spent — the harness a running session uses is
 * fixed, and another session is not this surface's job. Adding an agent to work
 * already under way is the flight deck's move, and a shell is a tab, so the box
 * carried a `+ Session` / `+ Shell` face that duplicated both and put the two
 * loudest buttons in the panel on the one task that needed nothing. Its callers
 * mount it only where the work has not begun; there is one face left.
 */
import { type JSX, type ReactNode, useCallback, useState } from 'react'
import type { IssueViewModel } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { Button } from '@/components/ui/button'
import type { ChoosableMachine } from '@/features/machines/machine-choices'
import { cn } from '@/lib/utils'
import { IssueAgentSettings } from './IssueAgentSettings'

/** Both launch surfaces ask the shared issue model at their visibility gate. */
export function useIssueWorkBegun(id: string): boolean {
  const read = useCallback((pool: import('@podium/client-graph').MobxPool) =>
    here(pool.model('issue', id))?.workBegun ?? true, [id])
  return useWorklistPoolProjection(read, true)
}

export type LaunchMachine = ChoosableMachine

/**
 * The action surrounding the shared, self-saving agent settings.
 */
export interface LaunchCommands {
  startWork: () => void
}

export function LaunchBox({
  issue,
  busy,
  starting = false,
  commands,
  machines,
  fork,
}: {
  issue: IssueViewModel
  busy: boolean
  /** The start itself is in flight — the button says so. Distinct from `busy`,
   *  which any property write raises. */
  starting?: boolean
  commands: LaunchCommands
  machines: LaunchMachine[]
  /** WHERE the work will live, offered at the moment it starts (POD-679). The
   *  explorer hands in its placement chevron, which then rides the right edge of
   *  Start work as one split control. */
  fork?: (busy: boolean) => ReactNode
}): JSX.Element {
  const [savingSettings, setSavingSettings] = useState(false)
  const spent = isFinished(issue) || issue.archived
  return (
    <div
      data-testid="launch-box"
      className="flex flex-col gap-2 rounded-[10px] bg-bar p-2 shadow-[inset_0_0_0_1px_var(--hairline-bar)]"
    >
      <IssueAgentSettings
        key={issue.id}
        issue={issue}
        machines={machines}
        disabled={busy}
        onSavingChange={setSavingSettings}
      />

      {/* THE FORK RIDES THE BUTTON (POD-679). The plain press keeps the shape
          the filing agent chose, so the fast path costs no extra click; the
          chevron is for the case the operator already knows the work is
          something else. One control, so the two halves share a rim. */}
      <div className="flex items-stretch">
        <Button
          type="button"
          variant={spent ? 'outline' : 'default'}
          size="sm"
          data-testid="task-primary-action"
          data-action="start-work"
          className={cn('min-w-0 flex-1', fork && 'rounded-r-none')}
          disabled={busy || savingSettings}
          onClick={() => commands.startWork()}
        >
          {starting ? 'Starting…' : 'Start work'}
        </Button>
        {fork?.(busy || savingSettings)}
      </div>
    </div>
  )
}
