/**
 * RUN PROGRESS (POD-647) — the runs list and one run's card, over the workflows
 * slice's `currentStepOf` / `runAdvances` / `runAttribution` /
 * `runSubjectReference` rather than re-deriving each in render.
 *
 * ---------------------------------------------------------------------------
 * THE SUBJECT IS RESOLVED AGAINST A PARTIAL WORLD, AND IT NEVER SPINS
 * ---------------------------------------------------------------------------
 *
 * A run names the issue or session it advances. That referent may be one the
 * principal cannot see, and the client has no way to distinguish "invisible"
 * from "still arriving" for it: the run arrives whole from an RPC read, so there
 * is no in-flight fetch that could later complete. Given that, the ONLY
 * rendering that is honest in every case is an OPAQUE REFERENCE — the id, marked
 * as inaccessible. A spinner would be the loading-forever defect (§3.1.2) and a
 * strikethrough would render not-visible as removed, which under the scoped feed
 * is simply false.
 *
 * ---------------------------------------------------------------------------
 * ATTRIBUTION IS READ, NEVER ASSERTED
 * ---------------------------------------------------------------------------
 *
 * The history rows come from `WorkflowRunWire.history`, which the server projects
 * from `workflow_events` — columns stamped from the authenticated transport. The
 * card shows the PAIR: who acted, and which human they acted for. A row with no
 * human is shown as such rather than attributed to the operator by default.
 */
import { currentStepOf, runAdvances, runAttribution, runSubjectReference } from '@podium/client-core/viewmodels'
import type { WorkflowRunWire } from '@podium/protocol'
import { Check } from 'lucide-react'
import type { JSX } from 'react'
import { useStoreSelector } from '@/app/store'
import { cn } from '@/lib/utils'
import type { WorkflowsSource } from './use-workflows'
import { workflowCommands, type WorkflowRights } from './workflow-commands'
import { CommandButton, Empty, OpaqueReference, statusClass } from './workflow-ui'

export function RunProgress({
  source,
  rights,
}: {
  source: WorkflowsSource
  rights: WorkflowRights
}): JSX.Element {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Workflow progress</h2>
            <p className="text-xs text-muted-foreground">
              Independent from issue stage. Checkpoints record evidence and return what comes next.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={source.showHistory}
              onChange={(e) => {
                source.setShowHistory(e.target.checked)
                void source.refresh(e.target.checked)
              }}
            />
            Show completed
          </label>
        </div>
        {source.runs.length === 0 ? (
          <Empty>No active workflow runs.</Empty>
        ) : (
          <div className="space-y-4">
            {source.runs.map((run) => (
              <RunCard key={run.id} run={run} source={source} rights={rights} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function RunCard({
  run,
  source,
  rights,
}: {
  run: WorkflowRunWire
  source: WorkflowsSource
  rights: WorkflowRights
}): JSX.Element {
  const { issues, sessions } = useStoreSelector((s) => ({ issues: s.issues, sessions: s.sessions }))
  const current = currentStepOf(run)
  const advances = runAdvances(run)
  const subject = runSubjectReference(run, (id) =>
    run.subjectKind === 'issue'
      ? issues.find((issue) => issue.id === id)
      : sessions.find((session) => session.sessionId === id),
  )
  const attribution = runAttribution(run)

  return (
    <article className="rounded-lg border bg-card p-4" data-run-id={run.id}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {subject.state === 'present' ? (
              <>
                {run.subjectKind} · {run.subjectId}
              </>
            ) : (
              <OpaqueReference id={run.subjectId} kind={run.subjectKind} />
            )}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {run.id} · revision {run.revision.version} · coordinator {run.coordinatorSessionId}
          </p>
        </div>
        <span className={cn('rounded-full px-2 py-1 text-[11px]', statusClass(run.status))}>
          {run.status}
        </span>
      </div>

      {run.steps.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Prompt-only workflow; the coordinator checkpoints the run as a whole.
        </p>
      ) : (
        <ol className="mt-4 space-y-2">
          {run.steps.map((step) => (
            <li key={step.stepId} className="rounded-md bg-muted/35 p-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full text-[10px]',
                    statusClass(step.status),
                  )}
                >
                  {step.status === 'complete' ? <Check size={12} /> : step.position + 1}
                </span>
                <span className="text-xs font-medium">{step.title}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {step.assignedSessionId ? `assigned ${step.assignedSessionId}` : 'unassigned'} ·
                  attempt {step.attempt}
                </span>
              </div>
              {step.summary && <p className="mt-2 text-xs text-muted-foreground">{step.summary}</p>}
              {step.warnings.map((warning) => (
                <p key={warning} className="mt-1 text-[11px] text-amber-600">
                  Warning: {warning}
                </p>
              ))}
            </li>
          ))}
        </ol>
      )}

      {attribution.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Run history
          </h4>
          <ul className="space-y-1">
            {attribution.map((row) => (
              <li
                key={`${row.kind}:${row.at}`}
                data-attribution={row.kind}
                className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground"
              >
                <span className="font-medium text-foreground">{row.kind}</span>
                <span>
                  by {row.actorKind}
                  {row.actorId ? ` ${row.actorId}` : ''}
                </span>
                {/* THE PAIR. A null human is stated, never filled in. */}
                <span data-on-behalf-of={row.onBehalfOf ?? ''}>
                  {row.delegated ? `on behalf of ${row.onBehalfOf}` : 'no delegating human'}
                </span>
                <span className="ml-auto tabular-nums">{row.at}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {current && (advances.skip || advances.retry) && (
        <div className="mt-3 flex justify-end gap-2">
          {advances.skip && (
            <CommandButton
              size="sm"
              variant="outline"
              command={workflowCommands.skip}
              rights={rights}
              dispatch={source.dispatch}
              input={() => ({
                runId: run.id,
                stepId: current.stepId,
                reason: 'Skipped by operator',
              })}
            />
          )}
          {advances.retry && (
            <CommandButton
              size="sm"
              variant="outline"
              command={workflowCommands.retry}
              rights={rights}
              dispatch={source.dispatch}
              input={() => ({ runId: run.id, stepId: current.stepId })}
            />
          )}
        </div>
      )}
    </article>
  )
}
