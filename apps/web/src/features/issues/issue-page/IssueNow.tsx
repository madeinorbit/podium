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
 * three volatile facts: who is computing, what each of them is doing, and where
 * the branch is. Everything else on the page is comparatively still.
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
import { FolderGit2 } from 'lucide-react'
import type { JSX } from 'react'
import type { IssueViewModel } from '@/app/store'
import { agentFleetTileTint, agentIconFor } from '@/lib/agent-tone'
import { PhaseTimer } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { sessionDisplayName } from '@/lib/WorkerLabel'
import { aheadCount } from '../issue-card'

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
  const git = issue.gitState
  const ahead = aheadCount(issue)
  const dirty = git?.dirtyOwn ?? git?.dirtyFiles ?? 0
  const hasGit = Boolean(issue.worktreePath || git?.branch)
  if (sessions.length === 0 && !hasGit) return null

  const ranked = [...sessions]
    .map((session) => ({ session, phase: motionPhase(session, issue as unknown as IssueWire) }))
    .sort((a, b) => (PHASE_RANK[a.phase] ?? 9) - (PHASE_RANK[b.phase] ?? 9))
  const working = ranked.filter((r) => r.phase === 'working').length
  // Long fleets fold: POD-516 carries fifteen sessions and thirteen of them are
  // finished. The block promises what is happening NOW, so it shows the live
  // ones and lets the rail's full roster answer "who has ever been here".
  const shown = ranked.filter((r) => r.phase === 'working' || r.phase === 'waiting').slice(0, 5)
  const restCount = ranked.length - shown.length

  return (
    <section
      className="mb-6 overflow-hidden rounded-[10px] bg-engraved shadow-engraved"
      data-testid="issue-now"
    >
      {sessions.length > 0 && (
        <div className="flex h-[26px] items-center gap-2 border-hairline-soft border-b px-3">
          <span className="label-mono">Now</span>
          <span
            className={cn(
              'ml-auto font-mono text-[9px] tabular-nums',
              working > 0 ? 'text-live' : 'text-text-faint',
            )}
          >
            {working > 0
              ? `${working} of ${sessions.length} session${sessions.length === 1 ? '' : 's'} working`
              : `${sessions.length} session${sessions.length === 1 ? '' : 's'} · none working`}
          </span>
        </div>
      )}

      {shown.map(({ session, phase }) => {
        const AgentIcon = agentIconFor(session.agentKind)
        const timing = motionTiming(session)
        return (
          <button
            data-pressable
            key={session.sessionId}
            type="button"
            className={cn(
              'flex w-full items-center gap-2.5 border-hairline-soft border-b px-3 py-1.5 text-left transition-colors last:border-b-0 hover:bg-accent/60',
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
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
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

      {sessions.length > 0 && shown.length === 0 && (
        <p className="px-3 py-2 text-[11.5px] text-text-dim">
          No agent is computing on this task right now.
        </p>
      )}
      {restCount > 0 && (
        <p className="border-hairline-soft border-b px-3 py-1.5 font-mono text-[9px] text-text-faint">
          {restCount} more session{restCount === 1 ? '' : 's'} — see the roster
        </p>
      )}

      {hasGit && (
        <div className="flex items-center gap-2 bg-card/50 px-3 py-1.5 font-mono text-[9.5px] text-text-dim tabular-nums">
          <FolderGit2 size={11} aria-hidden="true" className="flex-none" />
          <span className="min-w-0 truncate" title={issue.worktreePath ?? undefined}>
            {git?.branch ?? issue.branch ?? issue.worktreePath ?? '—'}
          </span>
          {git?.computing && (
            <span className="ml-auto animate-pulse text-text-faint">probing…</span>
          )}
          {!git?.computing && (
            <span className="ml-auto flex flex-none items-center gap-2.5">
              {ahead > 0 && (
                <span className="text-info" title={`${ahead} ahead of ${issue.parentBranch}`}>
                  ↑{ahead}
                </span>
              )}
              {dirty > 0 && (
                <span className="text-attention" title={`${dirty} uncommitted`}>
                  {dirty} uncommitted
                </span>
              )}
              {ahead === 0 && dirty === 0 && <span className="text-text-faint">clean</span>}
            </span>
          )}
        </div>
      )}
    </section>
  )
}
