/**
 * NOW — what is true about this task at this second (POD-591).
 *
 * The defect this answers: the issue PAGE knew less about its own task than the
 * sidebar row for the same task did. The sidebar said `15 agents · 41 commits
 * ahead · 2 uncommitted · 12h ago` and carried a live timer; the page offered
 * fifteen session titles as plain text and a Git section that was three buttons
 * and no state at all. An operator checking on a task had to leave the task's
 * own page to find out where it stood.
 *
 * So this block sits directly under the title, before any prose, and carries the
 * volatile agent facts: who is computing and what each of them is doing. Branch
 * state has one home in the rail; repeating it here made the block louder while
 * teaching the operator nothing new.
 *
 * It only takes a FRAME while something is live (POD-635). A task whose agents
 * have all finished still has an answer to "what is happening now", but the
 * answer is one line of mono, not a panel above the description.
 *
 * It is ENGRAVED, not carded. DESIGN.md's Carved Rule: a resting surface that
 * needs to read differently from its neighbours changes tone or recesses — it
 * does not lift. A drop-shadowed panel here would also be the page's only
 * floating element, which is the SaaS-dashboard tell the anti-references name.
 *
 * The only motion is the braille spinner and its counting timer, on the rows
 * where an agent is genuinely computing (`PhaseTimer` gates that itself). A row
 * that is waiting on the human is still and amber — stillness is the signal.
 */
import { motionPhase, motionTiming } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/model'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { PhaseTimer } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import { MACHINE_LABEL } from './chrome'

/** Live rows first (working, then waiting on you), then the rest — the block is
 *  read top-down and the top is where the movement should be. */
const PHASE_RANK: Record<string, number> = { working: 0, waiting: 1, queued: 2, done: 3 }

export function IssueNow({
  issue,
  sessions,
  onOpenSession,
}: {
  issue: IssueViewModel
  sessions: SessionMeta[]
  onOpenSession: (sessionId: SessionMeta['sessionId']) => void
}): JSX.Element | null {
  if (sessions.length === 0) return null

  const ranked = [...sessions]
    .map((session) => ({ session, phase: motionPhase(session, issue as unknown as IssueWire) }))
    .sort((a, b) => (PHASE_RANK[a.phase] ?? 9) - (PHASE_RANK[b.phase] ?? 9))
  const working = ranked.filter((r) => r.phase === 'working').length
  const waiting = ranked.filter((r) => r.phase === 'waiting').length
  // Long fleets fold: POD-516 carries fifteen sessions and thirteen of them are
  // finished. The block promises what is happening NOW, so it shows the live
  // ones and lets the rail's full roster answer "who has ever been here".
  const shown = ranked.filter((r) => r.phase === 'working' || r.phase === 'waiting').slice(0, 2)
  const restCount = ranked.length - shown.length

  // NOTHING IS LIVE — so the block spends no structure on saying so (POD-635).
  // A task whose agents all finished yesterday was still getting the page's
  // strongest object: an engraved panel, a hairline header, a mono label and a
  // row, above the description, to report that nothing was happening. The fact
  // is worth one quiet line; the roster in the rail owns who has ever been here.
  if (shown.length === 0) {
    return (
      <p className="mb-9 font-mono text-[10px] text-text-faint" data-testid="issue-now">
        {sessions.length} session{sessions.length === 1 ? '' : 's'} · none working
      </p>
    )
  }

  return (
    <section
      className="mb-9 overflow-hidden rounded-[9px] border border-border/35 bg-engraved/45"
      data-testid="issue-now"
    >
      <div className="flex h-7 items-center gap-2 border-border/35 border-b px-3.5">
        <span className={MACHINE_LABEL}>Now</span>
        {/* The summary names the reason the block is here. It used to report
            `none working` over a row that was waiting on the operator — the one
            state on this page that is genuinely an ask, rendered in the faintest
            ink the theme has, while the row's amber tint sat at 4.5%. */}
        <span
          className={cn(
            'ml-auto font-mono text-[10px] tabular-nums',
            working > 0 ? 'text-live' : 'text-attention',
          )}
        >
          {working > 0
            ? `${working} of ${sessions.length} session${sessions.length === 1 ? '' : 's'} working`
            : `${waiting} waiting on you`}
        </span>
      </div>

      {shown.map(({ session, phase }) => {
        const AgentIcon = agentIconFor(session.agentKind)
        const timing = motionTiming(session)
        return (
          <button
            data-pressable
            key={session.sessionId}
            type="button"
            className={cn(
              'flex w-full items-center gap-2.5 border-border/30 border-b px-3.5 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/35',
              phase === 'waiting' && 'bg-attention/[0.07]',
            )}
            onClick={() => onOpenSession(session.sessionId)}
            title={`Open ${sessionDisplayName(session)}`}
          >
            <span
              className={cn(
                'flex size-[19px] flex-none items-center justify-center rounded-[6px] border',
                agentFleetTileTint(session.agentKind),
              )}
            >
              {AgentIcon ? <AgentIcon size={12} strokeWidth={1.8} aria-hidden="true" /> : '✳'}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90">
              {sessionDisplayName(session)}
            </span>
            <PhaseTimer
              phase={timing.phase}
              sinceMs={timing.sinceMs}
              {...(timing.baseMs !== undefined ? { baseMs: timing.baseMs } : {})}
              {...(timing.totalMs !== undefined ? { totalMs: timing.totalMs } : {})}
              size={9}
            />
          </button>
        )
      })}

      {restCount > 0 && (
        <p className="px-3.5 py-2 font-mono text-[10px] text-text-faint">
          {restCount} more session{restCount === 1 ? '' : 's'} — see the roster
        </p>
      )}
    </section>
  )
}
