import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { asMutationId, type GitRepositoryWire } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { ArrowRight, Check, FolderGit2, LoaderCircle, Monitor } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
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
import { activationAgentIsReady, activationAgentReadiness } from './agent-readiness'
import { clearFirstTaskDraft, persistFirstTaskDraft, readFirstTaskDraft } from './first-task-draft'
import { SetupError } from './SetupFeedback'

function repoLabel(repo: GitRepositoryWire): string {
  return repo.path.split('/').filter(Boolean).pop() ?? repo.path
}

function promptTitle(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return (firstLine ?? prompt.trim()).slice(0, 120)
}

export function ColdStartComposer({ first }: { first: boolean }): JSX.Element {
  const { trpc, repos, machines, uiState, setSelectedIssueId } = useStoreSelector(
    (store) => ({
      trpc: store.trpc,
      repos: store.repos,
      machines: store.machines,
      uiState: store.uiState,
      setSelectedIssueId: store.setSelectedIssueId,
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
  const [draft, setDraftState] = useState(() =>
    readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY)),
  )
  const [configuredAgent, setConfiguredAgent] = useState<IssueAgentKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setDraft = useCallback(
    (next: typeof draft) => {
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
        if (!cancelled) {
          setConfiguredAgent(
            issueAgentKind(resolveRole(settings, 'coding').harness) ?? 'claude-code',
          )
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [trpc])

  const selectedRepo = repoChoices.find((repo) => repo.path === draft.repoPath) ?? repoChoices[0]
  const targetMachines = selectedRepo?.machineId
    ? machines.filter((machine) => machine.id === selectedRepo.machineId)
    : machines
  const selectedMachine =
    targetMachines.find((machine) => machine.id === draft.machineId) ??
    targetMachines.find((machine) => machine.online) ??
    targetMachines[0]
  const detectedReadyAgent = ISSUE_AGENT_KINDS.find((candidate) =>
    activationAgentIsReady(
      activationAgentReadiness(
        selectedRepo,
        selectedMachine ? [selectedMachine] : machines,
        candidate,
      ),
    ),
  )
  const agent =
    issueAgentKind(draft.agent) ??
    (configuredAgent &&
    activationAgentIsReady(
      activationAgentReadiness(
        selectedRepo,
        selectedMachine ? [selectedMachine] : machines,
        configuredAgent,
      ),
    )
      ? configuredAgent
      : detectedReadyAgent) ??
    configuredAgent ??
    'claude-code'
  const readiness = activationAgentReadiness(
    selectedRepo,
    selectedMachine ? [selectedMachine] : machines,
    agent,
  )
  const ready = activationAgentIsReady(readiness)

  useEffect(() => {
    if (!selectedRepo) return
    const repoChanged = draft.repoPath !== selectedRepo.path
    const machineChanged = selectedMachine && draft.machineId !== selectedMachine.id
    const agentChanged = !draft.agent
    if (!repoChanged && !machineChanged && !agentChanged) return
    setDraft({
      ...draft,
      repoPath: selectedRepo.path,
      machineId: selectedMachine?.id ?? '',
      agent,
      ...(repoChanged ? { model: AUTO, effort: AUTO } : {}),
    })
  }, [agent, draft, selectedMachine, selectedRepo, setDraft])

  const selectRepo = (repoPath: string): void => {
    const repo = repoChoices.find((candidate) => candidate.path === repoPath)
    const machine = repo?.machineId
      ? machines.find((candidate) => candidate.id === repo.machineId)
      : (machines.find((candidate) => candidate.online) ?? machines[0])
    setError(null)
    setDraft({
      ...draft,
      repoPath,
      machineId: machine?.id ?? '',
      model: AUTO,
      effort: AUTO,
      pendingIssueId: '',
      createMutationId: '',
      startMutationId: '',
    })
  }

  const selectMachine = (machineId: string): void => {
    setError(null)
    setDraft({ ...draft, machineId })
  }

  const start = async (): Promise<void> => {
    const prompt = draft.title.trim()
    if (busy || !selectedRepo || !selectedMachine || !ready || (!draft.pendingIssueId && !prompt))
      return
    setBusy(true)
    setError(null)
    try {
      const createMutationId = draft.createMutationId || asMutationId(randomUUID())
      const created = draft.pendingIssueId
        ? { id: draft.pendingIssueId }
        : await trpc.issues.create.mutate({
            repoPath: selectedRepo.path,
            machineId: selectedMachine.id,
            title: promptTitle(prompt),
            description: prompt,
            parentBranch: selectedRepo.branch?.trim() || undefined,
            defaultAgent: agent,
            defaultModel: draft.model !== AUTO ? draft.model : undefined,
            defaultEffort: draft.effort !== AUTO ? draft.effort : undefined,
            startNow: false,
            mutationId: createMutationId,
          })
      const startMutationId = draft.startMutationId || asMutationId(randomUUID())
      setDraft({
        ...draft,
        createMutationId,
        pendingIssueId: created.id,
        startMutationId,
      })
      await trpc.issues.start.mutate({ id: created.id, mutationId: startMutationId })
      clearFirstTaskDraft(uiState)
      setSelectedIssueId(created.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const headline = first ? 'Start your first thing in' : 'What do you want to work on in'

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-muted/[0.08] px-5 py-8">
      <div className="w-full max-w-[760px]">
        <div className="mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-xl font-medium tracking-[-0.02em] text-foreground">{headline}</h2>
          <PropertyMenu
            trigger={
              <button
                type="button"
                data-pressable
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xl font-medium tracking-[-0.02em] text-foreground underline decoration-border-strong underline-offset-4 hover:bg-muted/55"
              >
                <FolderGit2 size={17} className="text-muted-foreground" aria-hidden="true" />
                {selectedRepo ? repoLabel(selectedRepo) : 'a project'}
              </button>
            }
            options={repoChoices.map((repo) => ({ value: repo.path, label: repoLabel(repo) }))}
            selectedValue={selectedRepo?.path}
            placeholder="Choose a project…"
            onSelect={selectRepo}
          />
          <span className="text-xl font-medium text-foreground">.</span>
        </div>

        <div
          className="rounded-xl border border-border-strong bg-background/65 shadow-sm"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void start()
            }
          }}
        >
          <Textarea
            aria-label="What do you want to work on?"
            autoFocus
            value={draft.title}
            disabled={busy || Boolean(draft.pendingIssueId)}
            onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
            placeholder="Describe what you want the agent to do…"
            className="min-h-40 resize-none border-0 bg-transparent px-4 py-4 text-sm leading-6 shadow-none focus-visible:ring-0"
          />
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2.5">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2.5 text-xs text-muted-foreground">
              {issueAgentIcon(agent, 13)}
              {issueAgentLabel(agent)}
              {ready && <Check size={12} className="text-success" aria-hidden="true" />}
            </span>
            <ModelPicker
              agentKind={agent}
              value={draft.model}
              onChange={(model) => setDraft({ ...draft, model, effort: AUTO })}
            />
            <EffortPicker
              agentKind={agent}
              model={draft.model}
              value={draft.effort}
              onChange={(effort) => setDraft({ ...draft, effort })}
            />
            <PropertyMenu
              trigger={
                <Button type="button" size="sm" variant="ghost" className="h-8 text-xs font-normal">
                  <Monitor size={13} aria-hidden="true" />
                  {selectedMachine?.name ?? 'Choose machine'}
                </Button>
              }
              options={targetMachines.map((machine) => ({
                value: machine.id,
                label: `${machine.name}${machine.online ? '' : ' (offline)'}`,
              }))}
              selectedValue={selectedMachine?.id}
              placeholder="Choose a machine…"
              onSelect={selectMachine}
            />
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              disabled={
                busy ||
                !selectedRepo ||
                !selectedMachine ||
                !ready ||
                (!draft.pendingIssueId && !draft.title.trim())
              }
              onClick={() => void start()}
              aria-label={draft.pendingIssueId ? 'Retry starting work' : 'Start work'}
            >
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>

        {!ready && (
          <p className="mt-3 text-xs text-muted-foreground">
            The selected agent is not ready on this machine yet. Open Settings → Agents to finish
            setup.
          </p>
        )}
        {draft.pendingIssueId && !error && (
          <p className="mt-3 text-xs text-muted-foreground">
            The task is saved. Podium is retrying the same task, so it cannot create a duplicate.
          </p>
        )}
        {error && (
          <div className="mt-3">
            <SetupError>{error} Your prompt and selections are still saved.</SetupError>
          </div>
        )}
      </div>
    </div>
  )
}
