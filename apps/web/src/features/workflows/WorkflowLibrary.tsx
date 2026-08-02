/**
 * THE LIBRARY (POD-647) — list, editor and assignment, each over the workflows
 * slice's published derivations rather than shaping wires in render.
 *
 * THE LIST IS THE PRINCIPAL'S SLICE. It renders exactly the entries the read
 * returned and shows no count, total or summary of anything else. Workflows are
 * PERSONAL/PRIVATE by §3.1.1 rule 1, so "3 workflows" must mean "three you can
 * see" and never "three exist" — and the only way to guarantee that is for the
 * component never to learn a second number.
 *
 * NO SHARING UX IS INVENTED HERE. Per-feature sharing is deferred; when it
 * arrives it is one more entry in `workflow-commands.ts` with its own predicate,
 * rendered by the same `CommandButton`, and nothing in this file restructures.
 */
import type { WorkflowScope } from '@podium/protocol'
import {
  workflowLibraryEntries,
  workflowRevisionDetail,
} from '@podium/client-core/viewmodels'
import { Plus, ShieldCheck } from 'lucide-react'
import type { FormEvent, JSX } from 'react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { WorkflowsSource } from './use-workflows'
import { workflowCommands, type WorkflowRights } from './workflow-commands'
import { CommandButton, Empty, Field } from './workflow-ui'

function parseSteps(raw: string): unknown[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('Steps must be a JSON array.')
  return parsed
}

export function WorkflowLibrary({
  source,
  rights,
}: {
  source: WorkflowsSource
  rights: WorkflowRights
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const entries = workflowLibraryEntries(source.workflows, source.detail)

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(360px,1fr)_310px] overflow-hidden">
      <aside className="min-h-0 overflow-y-auto border-r p-3" aria-label="Workflow library">
        {rights.write && (
          <button
            data-pressable
            type="button"
            onClick={() => setCreating(true)}
            className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
          >
            <Plus size={14} aria-hidden="true" />
            New workflow
          </button>
        )}
        <div className="space-y-1">
          {entries.map((entry) => (
            <button
              data-pressable
              data-workflow-id={entry.id}
              key={entry.id}
              type="button"
              onClick={() => {
                setCreating(false)
                source.select(entry.id)
              }}
              className={cn(
                'w-full rounded-md px-2.5 py-2 text-left hover:bg-accent',
                source.selectedId === entry.id && !creating && 'bg-accent',
              )}
            >
              <span className="block truncate text-sm font-medium">{entry.name}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                v{entry.version} · {entry.scopeLabel}
                {entry.archived ? ' · archived' : ''}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-h-0 overflow-y-auto p-5">
        {creating ? (
          <CreateWorkflow
            source={source}
            rights={rights}
            onCreated={() => setCreating(false)}
          />
        ) : source.detail ? (
          <WorkflowEditor source={source} rights={rights} />
        ) : (
          <Empty>Create a workflow to define how an agent should work.</Empty>
        )}
      </section>

      <aside className="min-h-0 overflow-y-auto border-l p-4">
        <AssignmentPanel source={source} rights={rights} />
      </aside>
    </div>
  )
}

function CreateWorkflow({
  source,
  rights,
  onCreated,
}: {
  source: WorkflowsSource
  rights: WorkflowRights
  onCreated(): void
}): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<WorkflowScope>('global')
  const [scopeRef, setScopeRef] = useState('')
  const [instructions, setInstructions] = useState('')
  const [steps, setSteps] = useState('[]')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const applied = await source.dispatch(workflowCommands.create, {
        name,
        description,
        scope,
        scopeRef,
        instructions,
        steps: parseSteps(steps),
      })
      // Only a write the AUTHORITY applied closes the form. A refusal leaves the
      // draft exactly as typed — rolling the user's input back with it would be
      // a second loss on top of the denial.
      if (applied) onCreated()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      aria-busy={submitting || undefined}
      onSubmit={(event) => void submit(event)}
      className="mx-auto max-w-3xl space-y-4"
    >
      <div>
        <h2 className="text-lg font-semibold">New workflow</h2>
        <p className="text-xs text-muted-foreground">
          Markdown is the primary contract. Steps are optional and remain linear.
        </p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Field label="Name">
        <input required value={name} onChange={(e) => setName(e.target.value)} className="input" />
      </Field>
      <Field label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="input"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Scope">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as WorkflowScope)}
            className="input"
          >
            <option value="global">Global candidate</option>
            <option value="repository">Repository</option>
            <option value="task">Task</option>
          </select>
        </Field>
        {scope !== 'global' && (
          <Field label="Scope ID">
            <input
              required
              value={scopeRef}
              onChange={(e) => setScopeRef(e.target.value)}
              className="input"
            />
          </Field>
        )}
      </div>
      <Field label="Instructions (Markdown)">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          className="input min-h-52 font-mono text-xs"
        />
      </Field>
      <Field label="Ordered steps (JSON)">
        <textarea
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          className="input min-h-32 font-mono text-xs"
        />
      </Field>
      {workflowCommands.create.enabledBy(rights) && (
        <Button
          type="submit"
          data-command={workflowCommands.create.id}
          pending={submitting}
          pendingLabel={workflowCommands.create.pendingLabel}
        >
          {workflowCommands.create.label}
        </Button>
      )}
    </form>
  )
}

function WorkflowEditor({
  source,
  rights,
}: {
  source: WorkflowsSource
  rights: WorkflowRights
}): JSX.Element {
  const detail = source.detail
  const model = detail ? workflowRevisionDetail(detail) : null
  const head = model?.head
  const [instructions, setInstructions] = useState(model?.instructions ?? '')
  const [steps, setSteps] = useState(model?.stepsJson ?? '[]')

  // Re-seed the buffers when the HEAD REVISION changes — a new revision, a
  // different workflow, or a re-read after a write. Keyed on the revision id
  // rather than on the detail object so a refetch that returns the same revision
  // does not discard what the user is typing.
  useEffect(() => {
    setInstructions(model?.instructions ?? '')
    setSteps(model?.stepsJson ?? '[]')
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the head revision, deliberately.
  }, [head?.id])

  if (!model) return <Empty>Select a workflow.</Empty>
  if (!head) return <Empty>This workflow has no revision.</Empty>

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{model.name}</h2>
          <p className="text-xs text-muted-foreground">
            {model.description || 'No description'} · {model.scopeLabel}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-1 text-[11px]',
            head.published
              ? 'bg-emerald-500/10 text-emerald-600'
              : 'bg-amber-500/10 text-amber-600',
          )}
        >
          revision {head.version} · {head.published ? 'published' : 'candidate'}
        </span>
      </div>
      <Field label="Instructions (Markdown)">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          className="input min-h-64 font-mono text-xs"
        />
      </Field>
      <Field label="Ordered steps (JSON)">
        <textarea
          value={steps}
          onChange={(e) => setSteps(e.target.value)}
          className="input min-h-44 font-mono text-xs"
        />
      </Field>
      <div className="flex gap-2">
        <CommandButton
          command={workflowCommands.revise}
          rights={rights}
          dispatch={source.dispatch}
          input={() => ({
            workflowId: model.workflowId,
            instructions,
            steps: parseSteps(steps),
          })}
        />
        {!head.published && (
          <CommandButton
            variant="outline"
            command={workflowCommands.publish}
            rights={rights}
            dispatch={source.dispatch}
            input={() => ({ revisionId: head.id })}
          >
            <ShieldCheck size={14} />
            {workflowCommands.publish.label}
          </CommandButton>
        )}
      </div>
      <div className="border-t pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Revision history
        </h3>
        <div className="space-y-1">
          {model.history.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-xs"
            >
              <span>
                v{item.version} · {item.id}
              </span>
              <span className="text-muted-foreground">
                {item.published ? 'published' : 'candidate'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AssignmentPanel({
  source,
  rights,
}: {
  source: WorkflowsSource
  rights: WorkflowRights
}): JSX.Element {
  const [kind, setKind] = useState('issue')
  const [targetId, setTargetId] = useState('')
  const model = source.detail ? workflowRevisionDetail(source.detail) : null
  const head = model?.head
  // The principal's bindings, unfiltered — parity with what this panel has
  // always shown. It is a list of the rows the read returned and claims no
  // total, so it reveals nothing about bindings the principal cannot see.
  const mine = source.bindings

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Assignment</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Resolution is session → issue → repository → global. A session pins one exact revision at
          start.
        </p>
      </div>
      <Field label="Target">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="input">
          <option value="session">Session</option>
          <option value="issue">Task</option>
          <option value="repository">Repository default</option>
          <option value="global">Global default</option>
        </select>
      </Field>
      {kind !== 'global' && (
        <Field label="Target ID">
          <input value={targetId} onChange={(e) => setTargetId(e.target.value)} className="input" />
        </Field>
      )}
      <CommandButton
        className="w-full"
        variant="outline"
        command={workflowCommands.assign}
        rights={rights}
        dispatch={source.dispatch}
        disabled={!head || (kind !== 'global' && !targetId)}
        input={() => ({
          targetKind: kind,
          targetId: kind === 'global' ? '' : targetId,
          revisionId: head?.id ?? '',
        })}
      />
      <div className="border-t pt-3">
        <h3 className="mb-2 text-xs font-semibold">Current bindings</h3>
        <div className="space-y-2">
          {mine.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No workflow defaults or task assignments.
            </p>
          ) : (
            mine.map((binding) => (
              <div
                key={`${binding.targetKind}:${binding.targetId}`}
                className="rounded-md bg-muted/40 p-2 text-[11px]"
              >
                <div className="font-medium">
                  {binding.targetKind}
                  {binding.targetId ? ` · ${binding.targetId}` : ''}
                </div>
                <div className="mt-0.5 truncate text-muted-foreground">{binding.revisionId}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
