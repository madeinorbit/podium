import { shallowEqual } from '@podium/client-core/store'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  FolderGit2,
  Globe,
  Pencil,
  SkipForward,
  Trash2,
} from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { issueAgentLabel } from '@/lib/issue-agents'
import { cn } from '@/lib/utils'
import type { Automation, AutomationRun } from './AutomationsView'
import { cronSummary, formatTime } from './cron-format'

/** The repo basename, falling back to the full path — repos are shown by name. */
function repoLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Where the automation's session spawns: a repo, or the home directory. */
function targetLabel(a: Automation): string {
  if (a.targetSessionId) return `Session ${a.targetSessionId}`
  return a.repoPath ? repoLabel(a.repoPath) : 'Global (home directory)'
}

const OUTCOME_LABELS: Record<AutomationRun['outcome'], string> = {
  spawned: 'Spawned a session',
  missed: 'Missed',
  skipped_overlap: 'Skipped — previous run still going',
  error: 'Failed',
}

/**
 * The Scheduled surface (#470) [spec:SP-17db] — real cron automations: the list is
 * the server's, create/toggle/delete persist, and expanding a card shows the actual
 * `automation_runs` rows (including the fires that deliberately did nothing), with
 * the spawned session linked. The prototype's SEED_AUTOMATIONS/MOCK_RUNS are gone —
 * the fake "Pruned 3 worktrees" history read as real telemetry, which it never was.
 */
export function ScheduledSection({
  trpc,
  automations,
  automationRuns,
  error,
  onEdit,
  onError,
}: {
  trpc: Trpc
  automations: Automation[]
  automationRuns: AutomationRun[]
  error: string
  onEdit: (automation: Automation) => void
  onError: (message: string) => void
}): JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)

  const mutate = (id: string, run: () => Promise<unknown>): void => {
    setBusyId(id)
    run()
      .then(() => onError(''))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusyId(null))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="flex items-center gap-1.5 font-medium text-[13px] text-foreground">
          <Clock size={14} aria-hidden="true" /> Scheduled
        </h3>
        <p className="text-[12px] text-muted-foreground">
          Recurring and one-time agent tasks. Each run starts a fresh session or resumes one,
          according to its configured session mode.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
          {error}
        </div>
      )}

      {automations.length === 0 ? (
        <div className="rounded-md border border-border border-dashed bg-card px-3 py-4 text-center text-[12px] text-muted-foreground">
          No scheduled automations yet. Create one with “New automation”.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {automations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              runs={automationRuns
                .filter((run) => run.automationId === a.id)
                .sort((left, right) => right.firedAt.localeCompare(left.firedAt))}
              busy={busyId === a.id}
              onEdit={() => onEdit(a)}
              onToggle={(enabled) =>
                mutate(a.id, () => trpc.automations.setEnabled.mutate({ id: a.id, enabled }))
              }
              onRemove={() => mutate(a.id, () => trpc.automations.remove.mutate({ id: a.id }))}
            />
          ))}
        </div>
      )}

      <div className="mt-1 rounded-md border border-border bg-muted/40 px-3 py-2.5">
        <div className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Reactive automations
        </div>
        <p className="text-[12px] text-muted-foreground">
          Event-triggered tasks (on merge to main, on a new issue…) are designed but not yet wired
          to a runner. The composer shows the shape; creating one is disabled.
        </p>
      </div>
    </div>
  )
}

function AutomationCard({
  automation: a,
  runs,
  busy,
  onEdit,
  onToggle,
  onRemove,
}: {
  automation: Automation
  runs: AutomationRun[]
  busy: boolean
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const lastRun = runs[0]
  const completedOneOff = a.scheduleKind === 'once' && a.lastRunAt !== null
  const scheduleSummary =
    a.scheduleKind === 'once' ? `One time at ${formatTime(a.runAt)}` : cronSummary(a.cron)
  const statusSummary = completedOneOff
    ? `Completed: ${formatTime(a.lastRunAt)}`
    : a.enabled
      ? `Next run: ${formatTime(a.nextRunAt)}`
      : 'Disabled'
  const modeSummary = a.targetSessionId
    ? 'Wake targeted session'
    : a.sessionMode === 'resume'
      ? 'Resume previous session'
      : a.scheduleKind === 'once'
        ? 'Fresh session'
        : 'Fresh session per run'
  return (
    <div
      className={cn(
        'rounded-md border border-border bg-card transition-colors',
        !a.enabled && 'opacity-80',
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          className="-ml-1 flex size-6 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${a.name} runs`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
        </button>
        <span
          className={cn(
            'flex size-8 flex-none items-center justify-center rounded-md bg-muted/60',
            a.enabled ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {a.repoPath ? (
            <FolderGit2 size={16} aria-hidden="true" />
          ) : (
            <Globe size={16} aria-hidden="true" />
          )}
        </span>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: convenience click target; the chevron button is the accessible control */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users get the chevron button (aria-expanded), which this only duplicates for the mouse */}
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-[13px] text-foreground">{a.name}</span>
            <Badge variant="outline" className="font-normal">
              {a.scheduleKind === 'once' ? 'One-off' : 'Recurring'}
            </Badge>
          </div>
          <div className="truncate text-[12px] text-muted-foreground">
            {scheduleSummary} — {targetLabel(a)}
          </div>
          <div className="truncate text-[11px] text-muted-foreground/70">
            {statusSummary} · {issueAgentLabel(a.agentKind)}
            {a.model !== 'auto' ? ` · ${a.model}` : ''} · {modeSummary}
          </div>
        </div>
        <button
          type="button"
          className="flex size-7 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          aria-label={`Edit ${a.name}`}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
        <Switch
          checked={a.enabled}
          disabled={busy || completedOneOff}
          onCheckedChange={onToggle}
          aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
        />
        <button
          type="button"
          className="flex size-7 flex-none items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-red-500 disabled:opacity-50"
          aria-label={`Delete ${a.name}`}
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      {expanded && (
        <div className="border-border border-t px-3 py-2">
          <div className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Recent runs
          </div>
          {runs.length === 0 ? (
            <div className="py-1 text-[12px] text-muted-foreground/70">No runs yet</div>
          ) : (
            <ul className="flex flex-col">
              {runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </ul>
          )}
          {lastRun?.detail && (
            <p className="mt-1 truncate text-[11px] text-muted-foreground/70">{lastRun.detail}</p>
          )}
        </div>
      )}
    </div>
  )
}

/** One run: what happened, when, and — for a spawn — the session it produced. */
function RunRow({ run }: { run: AutomationRun }): JSX.Element {
  const { sessions, navigateToSession } = useStoreSelector(
    (s) => ({
      sessions: s.sessions,
      navigateToSession: s.navigateToSession,
    }),
    shallowEqual,
  )
  // Only a session that still exists can be opened — a deleted one leaves the run
  // row intact (the history is the truth about what happened, not about what lives).
  const session = run.sessionId ? sessions.find((s) => s.sessionId === run.sessionId) : undefined

  const open = (): void => {
    if (session) navigateToSession(session.sessionId)
  }

  return (
    <li className="flex items-center gap-2 py-1 text-[12px]">
      <RunOutcomeIcon outcome={run.outcome} />
      <span className="w-28 flex-none text-muted-foreground">{formatTime(run.firedAt)}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{OUTCOME_LABELS[run.outcome]}</span>
      {session && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 flex-none px-2 text-[11px]"
          onClick={open}
        >
          Open session
        </Button>
      )}
    </li>
  )
}

function RunOutcomeIcon({ outcome }: { outcome: AutomationRun['outcome'] }): JSX.Element {
  if (outcome === 'spawned')
    return <CircleCheck size={14} aria-label="Spawned" className="flex-none text-success" />
  if (outcome === 'error')
    return <CircleX size={14} aria-label="Failed" className="flex-none text-red-500" />
  return (
    <SkipForward
      size={14}
      aria-label={outcome === 'missed' ? 'Missed' : 'Skipped'}
      className="flex-none text-muted-foreground"
    />
  )
}
