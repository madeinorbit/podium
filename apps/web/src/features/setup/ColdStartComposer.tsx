import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { asMutationId, type GitRepositoryWire } from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { ArrowRight, ChevronDown, LoaderCircle, Monitor } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStoreSelector } from '@/app/store'
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

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto bg-[#131417] px-5 py-12 font-sans sm:px-10 lg:px-24 lg:py-20">
      <div className="w-full max-w-[1060px]">
        <h2 className="flex flex-wrap items-center gap-[13px] text-[clamp(26px,3vw,33px)] leading-[1.15] font-semibold tracking-[-0.022em] text-[#f2f3f5]">
          <span>{first ? 'Give' : 'What do you want to work on in'}</span>
          <PropertyMenu
            trigger={
              <button
                type="button"
                data-pressable
                aria-label={
                  selectedRepo ? `Project: ${repoLabel(selectedRepo)}` : 'Choose a project'
                }
                className="inline-flex h-12 items-center gap-[11px] rounded-[11px] bg-[#1b1d21] px-[13px] text-[#f2f3f5] shadow-[inset_0_0_0_1px_#2c2f35] transition-colors hover:bg-[#202227] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8b83ff]"
              >
                <span className="size-[13px] rounded-[4px] bg-[#d97757]" aria-hidden="true" />
                <span className="text-[28px] leading-none font-semibold tracking-[-0.02em]">
                  {selectedRepo ? repoLabel(selectedRepo) : 'a project'}
                </span>
                <ChevronDown size={20} className="text-[#949aa4]" aria-hidden="true" />
              </button>
            }
            options={repoChoices.map((repo) => ({ value: repo.path, label: repoLabel(repo) }))}
            selectedValue={selectedRepo?.path}
            placeholder="Choose a project…"
            onSelect={selectRepo}
          />
          <span>{first ? 'its first mission.' : '?'}</span>
        </h2>

        <div
          className="relative mt-[30px] overflow-hidden rounded-[14px] bg-[#1b1d21] shadow-[inset_0_0_0_1px_#2c2f35,0_20px_50px_-30px_rgba(0,0,0,.9)]"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void start()
            }
          }}
        >
          <textarea
            aria-label="What do you want to work on?"
            autoFocus
            value={draft.title}
            disabled={busy || Boolean(draft.pendingIssueId)}
            onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
            placeholder="Describe the mission — an outcome, a bug, a question about the codebase…"
            className="block min-h-[132px] w-full resize-none bg-transparent px-[22px] pt-5 pb-2.5 text-[14.5px] leading-[1.6] text-[#f2f3f5] outline-none placeholder:text-[#5e646e] disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-[#23262b] px-3.5 py-2.5 lg:flex-nowrap">
            <div className="inline-flex h-7 items-stretch overflow-hidden rounded-lg bg-[#16171a] shadow-[inset_0_0_0_1px_#26292f]">
              <PropertyMenu
                trigger={
                  <button
                    type="button"
                    aria-label="Agent"
                    className="inline-flex h-7 items-center gap-1.5 px-2.5 text-[11px] leading-none font-semibold text-[#f2f3f5] hover:bg-white/[0.035] focus-visible:outline-2 focus-visible:outline-[#8b83ff]"
                  >
                    <span className="size-[7px] rounded-[2px] bg-[#d97757]" aria-hidden="true" />
                    {issueAgentLabel(agent)}
                    <ChevronDown size={13} className="text-[#6f7580]" aria-hidden="true" />
                  </button>
                }
                options={ISSUE_AGENT_KINDS.map((candidate) => ({
                  value: candidate,
                  label: issueAgentLabel(candidate),
                  icon: issueAgentIcon(candidate, 13),
                }))}
                selectedValue={agent}
                placeholder="Choose an agent…"
                onSelect={(nextAgent) =>
                  setDraft({
                    ...draft,
                    agent: issueAgentKind(nextAgent) ?? agent,
                    model: AUTO,
                    effort: AUTO,
                  })
                }
              />
              <span className="w-px bg-[#26292f]" aria-hidden="true" />
              <ModelPicker
                variant="composer"
                agentKind={agent}
                value={draft.model}
                onChange={(model) => setDraft({ ...draft, model, effort: AUTO })}
              />
              <span className="w-px bg-[#26292f]" aria-hidden="true" />
              <EffortPicker
                variant="composer"
                agentKind={agent}
                model={draft.model}
                value={draft.effort}
                onChange={(effort) => setDraft({ ...draft, effort })}
              />
            </div>
            <PropertyMenu
              trigger={
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-[7px] rounded-lg px-2.5 font-mono text-[11px] leading-none text-[#a8adb6] shadow-[inset_0_0_0_1px_#26292f] hover:bg-white/[0.035] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-[#8b83ff]"
                >
                  <Monitor size={13} className="text-[#6f7580]" aria-hidden="true" />
                  {selectedMachine?.name ?? 'Choose machine'}
                  <ChevronDown size={13} className="text-[#6f7580]" aria-hidden="true" />
                </button>
              }
              options={targetMachines.map((machine) => ({
                value: machine.id,
                label: `${machine.name}${machine.online ? '' : ' (offline)'}`,
              }))}
              selectedValue={selectedMachine?.id}
              placeholder="Choose a machine…"
              onSelect={selectMachine}
            />
            <span className="ml-auto hidden font-mono text-[10px] leading-none text-[#6f7580] sm:inline">
              ⌘↵ to launch
            </span>
            <button
              type="button"
              className="inline-flex h-[30px] items-center gap-[7px] rounded-[9px] bg-[#e3ba52] px-3.5 text-[12px] leading-none font-semibold text-[#1a1408] transition-colors hover:bg-[#efc95f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2f3f5] disabled:cursor-not-allowed disabled:opacity-40"
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
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
              ) : (
                <>
                  Launch
                  <ArrowRight size={15} aria-hidden="true" />
                </>
              )}
            </button>
          </div>

          {busy && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-[#131417]/75 backdrop-blur-[2px]"
              role="status"
            >
              <div className="inline-flex items-center gap-2.5 rounded-lg bg-[#1b1d21] px-4 py-3 font-mono text-[11px] text-[#d7dae0] shadow-[inset_0_0_0_1px_#2c2f35,0_12px_30px_rgba(0,0,0,.45)]">
                <LoaderCircle
                  size={15}
                  className="animate-spin text-[#e3ba52]"
                  aria-hidden="true"
                />
                Starting your mission…
              </div>
            </div>
          )}
        </div>

        {!ready && (
          <p className="mt-3 font-mono text-[10.5px] leading-5 text-[#6f7580]">
            The selected agent is not ready on this machine yet. Open Settings → Agents to finish
            setup.
          </p>
        )}
        {draft.pendingIssueId && !error && (
          <p className="mt-3 font-mono text-[10.5px] leading-5 text-[#6f7580]">
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
