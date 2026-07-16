import {
  AgentKind,
  type ExecutionProfileWire,
  type WorkflowBindingTarget,
  type WorkflowBindingWire,
  type WorkflowDetailWire,
  type WorkflowRunWire,
  type WorkflowScope,
  type WorkflowStep,
  type WorkflowWire,
} from '@podium/protocol'
import { Check, Plus, RefreshCw, ShieldCheck, Workflow } from 'lucide-react'
import type { FormEvent, JSX, ReactElement } from 'react'
import { cloneElement, useCallback, useEffect, useId, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { cn } from '@/lib/utils'

type Tab = 'library' | 'progress' | 'profiles'

function parseSteps(raw: string): WorkflowStep[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('Steps must be a JSON array.')
  return parsed as WorkflowStep[]
}

function scopeLabel(scope: WorkflowScope, scopeRef: string | null): string {
  return scopeRef ? `${scope} · ${scopeRef}` : scope
}

function statusClass(status: string): string {
  if (status === 'complete') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (status === 'blocked') return 'bg-destructive/10 text-destructive'
  if (status === 'active') return 'bg-primary/10 text-primary'
  return 'bg-muted text-muted-foreground'
}

function Empty({ children }: { children: string }): JSX.Element {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function WorkflowsView(): JSX.Element {
  const [tab, setTab] = useState<Tab>('library')
  const [workflows, setWorkflows] = useState<WorkflowWire[]>([])
  const [bindings, setBindings] = useState<WorkflowBindingWire[]>([])
  const trpc = useStoreSelector((state) => state.trpc)
  const [profiles, setProfiles] = useState<ExecutionProfileWire[]>([])
  const [runs, setRuns] = useState<WorkflowRunWire[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<WorkflowDetailWire | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: trpc is a stable store singleton.
  const refresh = useCallback(
    async (includeTerminal = showHistory) => {
      setError(null)
      try {
        const [workflowRows, bindingRows, profileRows, runRows] = await Promise.all([
          trpc.workflows.list.query({}),
          trpc.workflows.bindings.query({}),
          trpc.workflows.profiles.query({}),
          trpc.workflows.runs.query({ includeTerminal }),
        ])
        setWorkflows(workflowRows)
        setBindings(bindingRows)
        setProfiles(profileRows)
        setRuns(runRows)
        setSelectedId((current) => current ?? workflowRows[0]?.id ?? null)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLoading(false)
      }
    },
    [showHistory],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on selection only; trpc is a stable store singleton.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    void trpc.workflows.get
      .query({ id: selectedId })
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const action = async (run: () => Promise<unknown>, message: string): Promise<void> => {
    setError(null)
    setNotice(null)
    try {
      await run()
      setNotice(message)
      await refresh()
      if (selectedId) setDetail(await trpc.workflows.get.query({ id: selectedId }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex flex-none items-center justify-between border-b px-5 py-3">
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <Workflow size={18} aria-hidden="true" />
            Workflows
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Versioned instructions, optional linear steps, and explicit execution profiles.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent"
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} aria-hidden="true" />
          Refresh
        </button>
      </header>

      <nav className="flex flex-none gap-1 border-b px-5 pt-2" aria-label="Workflow sections">
        {(
          [
            ['library', 'Library'],
            ['progress', 'Progress'],
            ['profiles', 'Execution profiles'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'border-b-2 px-3 py-2 text-xs font-medium',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      {(error || notice) && (
        <div
          role={error ? 'alert' : 'status'}
          className={cn(
            'mx-5 mt-3 rounded-md border px-3 py-2 text-xs',
            error
              ? 'border-destructive/30 bg-destructive/5 text-destructive'
              : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
          )}
        >
          {error ?? notice}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading workflows…
        </div>
      ) : tab === 'library' ? (
        <Library
          workflows={workflows}
          detail={detail}
          bindings={bindings}
          profiles={profiles}
          selectedId={selectedId}
          creating={creating}
          onSelect={(id) => {
            setCreating(false)
            setSelectedId(id)
          }}
          onCreate={() => setCreating(true)}
          onCreated={(id) => {
            setCreating(false)
            setSelectedId(id)
            void refresh()
          }}
          action={action}
        />
      ) : tab === 'progress' ? (
        <Progress
          runs={runs}
          showHistory={showHistory}
          onHistory={(next) => {
            setShowHistory(next)
            void refresh(next)
          }}
          action={action}
        />
      ) : (
        <Profiles profiles={profiles} action={action} />
      )}
    </main>
  )
}

function Library(props: {
  workflows: WorkflowWire[]
  detail: WorkflowDetailWire | null
  bindings: WorkflowBindingWire[]
  profiles: ExecutionProfileWire[]
  selectedId: string | null
  creating: boolean
  onSelect(id: string): void
  onCreate(): void
  onCreated(id: string): void
  action(run: () => Promise<unknown>, message: string): Promise<void>
}): JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(360px,1fr)_310px] overflow-hidden">
      <aside className="min-h-0 overflow-y-auto border-r p-3">
        <button
          type="button"
          onClick={props.onCreate}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
        >
          <Plus size={14} aria-hidden="true" />
          New workflow
        </button>
        <div className="space-y-1">
          {props.workflows.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              onClick={() => props.onSelect(workflow.id)}
              className={cn(
                'w-full rounded-md px-2.5 py-2 text-left hover:bg-accent',
                props.selectedId === workflow.id && !props.creating && 'bg-accent',
              )}
            >
              <span className="block truncate text-sm font-medium">{workflow.name}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                v{workflow.latestVersion} · {scopeLabel(workflow.scope, workflow.scopeRef)}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="min-h-0 overflow-y-auto p-5">
        {props.creating ? (
          <CreateWorkflow profiles={props.profiles} onCreated={props.onCreated} />
        ) : props.detail ? (
          <WorkflowEditor detail={props.detail} profiles={props.profiles} action={props.action} />
        ) : (
          <Empty>Create a workflow to define how an agent should work.</Empty>
        )}
      </section>
      <aside className="min-h-0 overflow-y-auto border-l p-4">
        <AssignmentPanel detail={props.detail} bindings={props.bindings} action={props.action} />
      </aside>
    </div>
  )
}

function CreateWorkflow(props: {
  profiles: ExecutionProfileWire[]
  onCreated(id: string): void
}): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<WorkflowScope>('global')
  const [scopeRef, setScopeRef] = useState('')
  const [instructions, setInstructions] = useState('')
  const [steps, setSteps] = useState('[]')
  const trpc = useStoreSelector((state) => state.trpc)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      const created = await trpc.workflows.create.mutate({
        name,
        description,
        scope,
        ...(scope === 'global' ? {} : { scopeRef }),
        instructions,
        steps: parseSteps(steps),
      })
      props.onCreated(created.workflow.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="mx-auto max-w-3xl space-y-4">
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
      <button
        type="submit"
        className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
      >
        Create revision 1
      </button>
    </form>
  )
}

function WorkflowEditor(props: {
  detail: WorkflowDetailWire
  profiles: ExecutionProfileWire[]
  action(run: () => Promise<unknown>, message: string): Promise<void>
}): JSX.Element {
  const revision = props.detail.revisions[0]
  const trpc = useStoreSelector((state) => state.trpc)
  const [instructions, setInstructions] = useState(revision?.instructions ?? '')
  const [steps, setSteps] = useState(JSON.stringify(revision?.steps ?? [], null, 2))
  useEffect(() => {
    setInstructions(revision?.instructions ?? '')
    setSteps(JSON.stringify(revision?.steps ?? [], null, 2))
  }, [revision])
  if (!revision) return <Empty>This workflow has no revision.</Empty>
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{props.detail.workflow.name}</h2>
          <p className="text-xs text-muted-foreground">
            {props.detail.workflow.description || 'No description'} ·{' '}
            {scopeLabel(props.detail.workflow.scope, props.detail.workflow.scopeRef)}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-1 text-[11px]',
            revision.publishedAt
              ? 'bg-emerald-500/10 text-emerald-600'
              : 'bg-amber-500/10 text-amber-600',
          )}
        >
          revision {revision.version} · {revision.publishedAt ? 'published' : 'candidate'}
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
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground"
          onClick={() =>
            void props.action(
              () =>
                trpc.workflows.revise.mutate({
                  workflowId: props.detail.workflow.id,
                  instructions,
                  steps: parseSteps(steps),
                }),
              'Created a new immutable revision.',
            )
          }
        >
          Create revision
        </button>
        {!revision.publishedAt && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs"
            onClick={() =>
              void props.action(
                () => trpc.workflows.publish.mutate({ revisionId: revision.id }),
                'Published this revision.',
              )
            }
          >
            <ShieldCheck size={14} />
            Publish
          </button>
        )}
      </div>
      <div className="border-t pt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Revision history
        </h3>
        <div className="space-y-1">
          {props.detail.revisions.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-xs"
            >
              <span>
                v{item.version} · {item.id}
              </span>
              <span className="text-muted-foreground">
                {item.publishedAt ? 'published' : 'candidate'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function AssignmentPanel(props: {
  detail: WorkflowDetailWire | null
  bindings: WorkflowBindingWire[]
  action(run: () => Promise<unknown>, message: string): Promise<void>
}): JSX.Element {
  const trpc = useStoreSelector((state) => state.trpc)
  const [kind, setKind] = useState<WorkflowBindingTarget>('issue')
  const [targetId, setTargetId] = useState('')
  const revision = props.detail?.revisions[0]
  const assign = () => {
    if (!revision) return
    void props.action(
      () =>
        trpc.workflows.assign.mutate({
          targetKind: kind,
          targetId: kind === 'global' ? '' : targetId,
          revisionId: revision.id,
        }),
      'Pinned the exact workflow revision.',
    )
  }
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
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as WorkflowBindingTarget)}
          className="input"
        >
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
      <button
        type="button"
        disabled={!revision || (kind !== 'global' && !targetId)}
        onClick={assign}
        className="w-full rounded-md border px-3 py-2 text-xs font-medium enabled:hover:bg-accent disabled:opacity-40"
      >
        Assign latest revision
      </button>
      <div className="border-t pt-3">
        <h3 className="mb-2 text-xs font-semibold">Current bindings</h3>
        <div className="space-y-2">
          {props.bindings.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No workflow defaults or task assignments.
            </p>
          ) : (
            props.bindings.map((binding) => (
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

function Progress(props: {
  runs: WorkflowRunWire[]
  showHistory: boolean
  onHistory(next: boolean): void
  action(run: () => Promise<unknown>, message: string): Promise<void>
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
              checked={props.showHistory}
              onChange={(e) => props.onHistory(e.target.checked)}
            />
            Show completed
          </label>
        </div>
        {props.runs.length === 0 ? (
          <Empty>No active workflow runs.</Empty>
        ) : (
          <div className="space-y-4">
            {props.runs.map((run) => (
              <RunCard key={run.id} run={run} action={props.action} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function RunCard({
  run,
  action,
}: {
  run: WorkflowRunWire
  action(run: () => Promise<unknown>, message: string): Promise<void>
}): JSX.Element {
  const trpc = useStoreSelector((state) => state.trpc)
  const current =
    run.steps.find((step) => step.status === 'active' || step.status === 'blocked') ??
    run.steps.find((step) => step.status === 'pending')
  return (
    <article className="rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {run.subjectKind} · {run.subjectId}
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
      {current && (run.status === 'active' || run.status === 'blocked') && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={() =>
              void action(
                () =>
                  trpc.workflows.skip.mutate({
                    runId: run.id,
                    stepId: current.stepId,
                    reason: 'Skipped by operator',
                  }),
                'Skipped the current workflow step.',
              )
            }
            className="rounded-md border px-2.5 py-1.5 text-[11px] hover:bg-accent"
          >
            Skip current
          </button>
          {current.status === 'blocked' && (
            <button
              type="button"
              onClick={() =>
                void action(
                  () => trpc.workflows.retry.mutate({ runId: run.id, stepId: current.stepId }),
                  'Reset the step for another attempt.',
                )
              }
              className="rounded-md border px-2.5 py-1.5 text-[11px] hover:bg-accent"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </article>
  )
}

function Profiles(props: {
  profiles: ExecutionProfileWire[]
  action(run: () => Promise<unknown>, message: string): Promise<void>
}): JSX.Element {
  const [name, setName] = useState('')
  const trpc = useStoreSelector((state) => state.trpc)
  const [accountId, setAccountId] = useState('')
  const [harness, setHarness] = useState<AgentKind>('codex')
  const [model, setModel] = useState('auto')
  const [effort, setEffort] = useState('auto')
  const canSave = name && accountId && harness
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto grid max-w-5xl grid-cols-[1fr_360px] gap-6">
        <div>
          <h2 className="mb-1 text-lg font-semibold">Execution profiles</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Named launch presets only. Credentials stay in the account inventory.
          </p>
          {props.profiles.length === 0 ? (
            <Empty>No execution profiles.</Empty>
          ) : (
            <div className="space-y-2">
              {props.profiles.map((profile) => (
                <div key={profile.id} className="rounded-lg border p-3">
                  <div className="text-sm font-medium">{profile.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {profile.harness} · {profile.model} · {profile.effort}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    account {profile.accountId}
                    {profile.machineId ? ` · machine ${profile.machineId}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-semibold">New profile</h3>
          <div className="space-y-3">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            </Field>
            <Field label="Account ID">
              <input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="input"
              />
            </Field>
            <Field label="Harness">
              <select
                value={harness}
                onChange={(e) => setHarness(AgentKind.parse(e.target.value))}
                className="input"
              >
                {AgentKind.options.map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Model">
                <input value={model} onChange={(e) => setModel(e.target.value)} className="input" />
              </Field>
              <Field label="Effort">
                <input
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                  className="input"
                />
              </Field>
            </div>
            <button
              type="button"
              disabled={!canSave}
              onClick={() =>
                void props.action(
                  () =>
                    trpc.workflows.profileSave.mutate({
                      name,
                      accountId,
                      harness,
                      model,
                      effort,
                      machineId: null,
                    }),
                  'Saved the execution profile.',
                )
              }
              className="w-full rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
            >
              Save profile
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: ReactElement<{ id?: string }>
}): JSX.Element {
  const id = useId()
  return (
    <div className="block text-xs font-medium">
      <label htmlFor={id} className="mb-1.5 block text-muted-foreground">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  )
}
