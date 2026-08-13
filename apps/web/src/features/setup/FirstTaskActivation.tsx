import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { asMutationId, type GitRepositoryWire, type HarnessAgent, type IssueId } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { ArrowLeft, ArrowRight, Check, FolderGit2, LoaderCircle } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AUTO } from '@/lib/agent-models'
import {
  ISSUE_AGENT_KINDS,
  issueAgentIcon,
  issueAgentKind,
  issueAgentLabel,
  type IssueAgentKind,
} from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { PropertyMenu } from '@/lib/PropertyMenu'
import { cn } from '@/lib/utils'
import { ActivationShell } from './ActivationShell'
import {
  activationAgentIsReady,
  activationAgentReadiness,
  activationReadinessCopy,
} from './agent-readiness'
import type { ActivationRoute } from './activation-route'
import {
  clearFirstTaskDraft,
  type FirstTaskDraft,
  persistFirstTaskDraft,
  readFirstTaskDraft,
} from './first-task-draft'

function repoLabel(repo: GitRepositoryWire): string {
  return repo.path.split('/').filter(Boolean).pop() ?? repo.path
}

function ActivationSteps({ current }: { current: 'agent' | 'first-task' }): JSX.Element {
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <li className="inline-flex items-center gap-1.5 text-foreground">
        <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success">
          <Check size={12} aria-hidden="true" />
        </span>
        Project
      </li>
      <li aria-hidden="true">→</li>
      <li
        className={cn('inline-flex items-center gap-1.5', current === 'agent' && 'text-foreground')}
      >
        <span className="flex size-5 items-center justify-center rounded-full border border-border">
          2
        </span>
        Agent
      </li>
      <li aria-hidden="true">→</li>
      <li
        className={cn(
          'inline-flex items-center gap-1.5',
          current === 'first-task' && 'text-foreground',
        )}
      >
        <span className="flex size-5 items-center justify-center rounded-full border border-border">
          3
        </span>
        First task
      </li>
    </ol>
  )
}

export function FirstTaskActivation({
  route,
  onRouteChange,
  onExplore,
  onComplete,
}: {
  route: Extract<ActivationRoute, 'agent' | 'first-task'>
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
  onComplete: (issueId: IssueId) => void
}): JSX.Element {
  const { trpc, repos, machines, uiState, navigateToSession } = useStoreSelector(
    (store) => ({
      trpc: store.trpc,
      repos: store.repos,
      machines: store.machines,
      uiState: store.uiState,
      navigateToSession: store.navigateToSession,
    }),
    shallowEqual,
  )
  const repoChoices = useMemo(
    () =>
      repos
        .filter((repo) => repo.kind !== 'worktree')
        .sort((a, b) =>
          repoLabel(a).localeCompare(repoLabel(b), undefined, { sensitivity: 'base' }),
        ),
    [repos],
  )
  const [draft, setDraftState] = useState<FirstTaskDraft>(() =>
    readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY)),
  )
  const [configuredAgent, setConfiguredAgent] = useState<IssueAgentKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setDraft = useCallback(
    (next: FirstTaskDraft) => {
      setDraftState(next)
      persistFirstTaskDraft(uiState, next)
    },
    [uiState],
  )

  useEffect(() => {
    let cancelled = false
    void trpc.settings.get
      .query()
      .then((settings) => {
        if (cancelled) return
        setConfiguredAgent(issueAgentKind(resolveRole(settings, 'coding').harness) ?? 'claude-code')
      })
      .catch(() => {
        if (!cancelled) setConfiguredAgent('claude-code')
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  const selectedRepo = repoChoices.find((repo) => repo.path === draft.repoPath)
  useEffect(() => {
    if (selectedRepo || repoChoices.length === 0) return
    const first = repoChoices[0]
    if (first) {
      setDraft({ ...draft, repoPath: first.path, agent: '', model: AUTO, effort: AUTO })
    }
  }, [draft, repoChoices, selectedRepo, setDraft])

  const readinessByAgent = useMemo(
    () =>
      Object.fromEntries(
        ISSUE_AGENT_KINDS.map((agent) => [
          agent,
          activationAgentReadiness(selectedRepo, machines, agent),
        ]),
      ) as Record<IssueAgentKind, ReturnType<typeof activationAgentReadiness>>,
    [machines, selectedRepo],
  )

  useEffect(() => {
    if (draft.agent || !configuredAgent) return
    const preferred = activationAgentIsReady(readinessByAgent[configuredAgent])
      ? configuredAgent
      : ISSUE_AGENT_KINDS.find((agent) => activationAgentIsReady(readinessByAgent[agent]))
    if (preferred) setDraft({ ...draft, agent: preferred })
  }, [configuredAgent, draft, readinessByAgent, setDraft])

  const selectedAgent = draft.agent || configuredAgent || 'claude-code'
  const readiness = readinessByAgent[selectedAgent]
  const ready = activationAgentIsReady(readiness)
  const selectedMachine = readiness.machine

  const selectRepo = (repoPath: string): void => {
    setError(null)
    setDraft({ ...draft, repoPath, agent: '', model: AUTO, effort: AUTO })
  }

  const selectAgent = (agent: IssueAgentKind): void => {
    setError(null)
    setDraft({ ...draft, agent, model: AUTO, effort: AUTO })
  }

  const openLogin = async (): Promise<void> => {
    if (!selectedMachine || loginBusy) return
    setLoginBusy(true)
    setError(null)
    try {
      const result = await trpc.accounts.login.mutate({
        harness: selectedAgent as HarnessAgent,
        machineId: selectedMachine.id,
      })
      onExplore()
      navigateToSession(result.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoginBusy(false)
    }
  }

  const startTask = async (): Promise<void> => {
    if (busy) return
    if (draft.pendingIssueId && !ready) return
    if (!draft.pendingIssueId && (!selectedRepo || !draft.agent || !ready || !draft.title.trim())) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const createMutationId = draft.createMutationId || asMutationId(randomUUID())
      if (!draft.createMutationId) setDraft({ ...draft, createMutationId })
      const created = draft.pendingIssueId
        ? { id: draft.pendingIssueId }
        : await trpc.issues.create.mutate({
            repoPath: selectedRepo?.path ?? '',
            title: draft.title.trim(),
            description: draft.description.trim() || undefined,
            parentBranch: selectedRepo?.branch?.trim() || undefined,
            defaultAgent: draft.agent,
            defaultModel: draft.model !== AUTO ? draft.model : undefined,
            defaultEffort: draft.effort !== AUTO ? draft.effort : undefined,
            startNow: false,
            mutationId: createMutationId,
          })
      const startMutationId = draft.startMutationId || asMutationId(randomUUID())
      const resumableDraft = {
        ...draft,
        createMutationId,
        pendingIssueId: created.id,
        startMutationId,
      }
      setDraft(resumableDraft)
      await trpc.issues.start.mutate({ id: created.id, mutationId: startMutationId })
      clearFirstTaskDraft(uiState)
      onComplete(created.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  if (route === 'agent') {
    return (
      <ActivationShell
        eyebrow="Activate Podium · Step 2 of 3"
        title="Choose an agent that is ready here."
        description="Podium reads the selected project's machine inventory. Installation, reachability, and known login state must be ready before the first task can start."
        onExplore={onExplore}
      >
        <ActivationSteps current="agent" />
        <div className="max-w-[680px] space-y-5">
          <div>
            <p className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Project
            </p>
            <PropertyMenu
              trigger={
                <Button type="button" variant="outline" className="w-full justify-between">
                  <span className="flex min-w-0 items-center gap-2">
                    <FolderGit2 size={15} aria-hidden="true" />
                    <span className="truncate">
                      {selectedRepo ? repoLabel(selectedRepo) : 'Choose a project'}
                    </span>
                  </span>
                  <span className="truncate pl-3 font-mono text-[10px] text-muted-foreground">
                    {selectedRepo?.path}
                  </span>
                </Button>
              }
              options={repoChoices.map((repo) => ({ value: repo.path, label: repoLabel(repo) }))}
              selectedValue={selectedRepo?.path}
              placeholder="Choose a project…"
              onSelect={selectRepo}
            />
          </div>

          <fieldset>
            <legend className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Agent
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ISSUE_AGENT_KINDS.map((agent) => {
                const agentReadiness = readinessByAgent[agent]
                const isReady = activationAgentIsReady(agentReadiness)
                const selected = selectedAgent === agent
                return (
                  <button
                    key={agent}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      'rounded-lg border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-primary/60 bg-primary/[0.08]'
                        : 'border-border bg-background/50 hover:bg-secondary/60',
                    )}
                    onClick={() => selectAgent(agent)}
                  >
                    <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                      {issueAgentIcon(agent, 15)}
                      {issueAgentLabel(agent)}
                      <span
                        className={cn(
                          'ml-auto size-1.5 rounded-full',
                          isReady ? 'bg-success' : 'bg-muted-foreground/45',
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="mt-1.5 block text-[11.5px] leading-4 text-muted-foreground">
                      {activationReadinessCopy(agentReadiness, issueAgentLabel(agent))}
                    </span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          {readiness.state === 'logged-out' && (
            <Button
              type="button"
              variant="outline"
              disabled={loginBusy}
              onClick={() => void openLogin()}
            >
              {loginBusy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                issueAgentIcon(selectedAgent, 14)
              )}
              {loginBusy ? 'Opening login…' : `Log in to ${issueAgentLabel(selectedAgent)}`}
            </Button>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-between gap-2 border-t border-border/70 pt-4">
            <Button type="button" variant="ghost" onClick={() => onRouteChange('local-project')}>
              <ArrowLeft aria-hidden="true" />
              Change project
            </Button>
            <Button type="button" disabled={!ready} onClick={() => onRouteChange('first-task')}>
              Continue to first task
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </ActivationShell>
    )
  }

  return (
    <ActivationShell
      eyebrow="Activate Podium · Step 3 of 3"
      title="Give your first agent real work."
      description="This is Podium's production task path: it creates a tracked task, prepares its worktree, starts the selected agent, and keeps this draft if any step fails."
      onExplore={onExplore}
    >
      <ActivationSteps current="first-task" />
      <div
        className="max-w-[680px] rounded-xl border border-border bg-background/55 p-4 shadow-sm"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void startTask()
          }
        }}
      >
        <div className="mb-4 flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1">
            <FolderGit2 size={12} aria-hidden="true" />
            {selectedRepo ? repoLabel(selectedRepo) : 'No project'}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1">
            {issueAgentIcon(selectedAgent, 12)}
            {issueAgentLabel(selectedAgent)}
          </span>
          <span className={cn('ml-auto', ready ? 'text-success' : 'text-destructive')}>
            {activationReadinessCopy(readiness, issueAgentLabel(selectedAgent))}
          </span>
        </div>
        <Input
          aria-label="Task title"
          value={draft.title}
          disabled={busy || Boolean(draft.pendingIssueId)}
          onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
          placeholder="What should the agent accomplish?"
          className="border-none px-0 text-[15px] font-medium shadow-none focus-visible:ring-0"
          autoFocus
        />
        <Textarea
          aria-label="Task context"
          value={draft.description}
          disabled={busy || Boolean(draft.pendingIssueId)}
          onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })}
          placeholder="Add context, constraints, or a clear definition of done…"
          className="mt-2 min-h-36 border-none px-0 shadow-none focus-visible:ring-0"
        />
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-3">
          {!draft.pendingIssueId && (
            <>
              <ModelPicker
                agentKind={selectedAgent}
                value={draft.model}
                onChange={(model) => setDraft({ ...draft, model, effort: AUTO })}
              />
              <EffortPicker
                agentKind={selectedAgent}
                model={draft.model}
                value={draft.effort}
                onChange={(effort) => setDraft({ ...draft, effort })}
              />
            </>
          )}
          <span className="text-[11px] text-muted-foreground">
            Model and effort come from the same live catalog used by every task composer.
          </span>
        </div>
        {draft.pendingIssueId && (
          <p className="mt-3 text-[12px] text-muted-foreground">
            The tracked task already exists. Retry starts that same task, so a failed launch cannot
            create a duplicate.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-destructive">
            {error} Your project, agent, and task draft are still saved.
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy || Boolean(draft.pendingIssueId)}
            onClick={() => onRouteChange('agent')}
          >
            <ArrowLeft aria-hidden="true" />
            Back to agent
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              !ready ||
              (!draft.pendingIssueId &&
                (!selectedRepo || !draft.agent || !draft.title.trim()))
            }
            pending={busy}
            pendingLabel="Starting first task…"
            onClick={() => void startTask()}
          >
            {draft.pendingIssueId ? 'Retry starting task' : 'Start first task'}
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </ActivationShell>
  )
}
