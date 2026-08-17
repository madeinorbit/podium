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
    <div className="cold-start flex min-h-0 flex-1 flex-col overflow-y-auto bg-card font-sans">
      <div className="cold-start-body">
        {/* ONE SENTENCE, SET AS TEXT (POD-1184). The headline used to be a
            wrapping FLEX row of three items — sentence, project pill, tail —
            and a flex line break is not a text line break: at a ~680px pane
            the sentence wrapped internally, leaving "in" alone on its own
            line, and the tail "?" landed after the pill as a separate item
            with a 0.4em gap in front of it, reading as a stranded glyph rather
            than the sentence's punctuation. Inline flow has neither problem —
            the pill is one unbreakable word inside the sentence and the mark
            sits hard against it. */}
        <h2 className="cold-start-head font-semibold text-text-strong">
          {first ? 'Give ' : 'What do you want to work on in '}
          <PropertyMenu
            trigger={
              <button
                type="button"
                data-pressable
                aria-label={
                  selectedRepo ? `Project: ${repoLabel(selectedRepo)}` : 'Choose a project'
                }
                className="cold-start-project items-center bg-bar text-text-strong shadow-[inset_0_0_0_1px_var(--border-strong)] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="cold-start-project-mark bg-claude" aria-hidden="true" />
                <span className="cold-start-project-name leading-none font-semibold tracking-[-0.02em]">
                  {selectedRepo ? repoLabel(selectedRepo) : 'a project'}
                </span>
                <ChevronDown className="cold-start-project-caret text-label" aria-hidden="true" />
              </button>
            }
            options={repoChoices.map((repo) => ({ value: repo.path, label: repoLabel(repo) }))}
            selectedValue={selectedRepo?.path}
            placeholder="Choose a project…"
            onSelect={selectRepo}
          />
          {/* U+2060 WORD JOINER. A line may break either side of an atomic
              inline box, so a pill that nearly fills the measure could strand
              the question mark alone on the next line — the same orphan this
              rewrite removed, one character smaller. The tail of the first-run
              wording is a phrase and breaks normally. */}
          {first ? ' its first mission.' : '⁠?'}
        </h2>

        <div
          className="cold-start-field relative overflow-hidden rounded-[14px] bg-bar shadow-[inset_0_0_0_1px_var(--border-strong),0_20px_50px_-30px_var(--carve-drop)]"
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
            className="cold-start-input block w-full resize-none bg-transparent px-[22px] text-[14.5px] leading-[1.6] text-text-strong outline-none placeholder:text-text-faint disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-hairline-soft px-3.5 py-2.5">
            {/* The instrument strip is a WELL cut into the composer's bar. The
                floor is --well-floor rather than a flat tone because the well
                inks are an ALPHA over whatever surface they land on, which is
                the only way one value stays a recess in both modes: over the
                dark bar it lands on the mock's #16171a, over paper it darkens
                the stone by the same fraction. The rim is the bar seam.

                `flex-none` is load-bearing: `overflow-hidden` sets this box's
                automatic minimum size to 0, so as a shrinkable flex item it
                SQUASHED rather than wrapped — the row never ran out of room by
                its own arithmetic, it just clipped the pickers mid-word and
                then to nothing at all. It is one instrument; it wraps whole. */}
            <div className="inline-flex h-7 max-w-full flex-none items-stretch overflow-hidden rounded-lg bg-[var(--well-floor)] shadow-[inset_0_0_0_1px_var(--hairline-bar)]">
              <PropertyMenu
                trigger={
                  <button
                    type="button"
                    data-pressable
                    aria-label="Agent"
                    className="inline-flex h-7 items-center gap-1.5 px-2.5 text-[11px] leading-none font-semibold text-text-strong hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="size-[7px] rounded-[2px] bg-claude" aria-hidden="true" />
                    {issueAgentLabel(agent)}
                    <ChevronDown size={13} className="text-text-faint" aria-hidden="true" />
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
              <span className="w-px bg-hairline-bar" aria-hidden="true" />
              <ModelPicker
                variant="composer"
                agentKind={agent}
                value={draft.model}
                onChange={(model) => setDraft({ ...draft, model, effort: AUTO })}
              />
              <span className="w-px bg-hairline-bar" aria-hidden="true" />
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
                  data-pressable
                  className="inline-flex h-7 max-w-full flex-none items-center gap-[7px] rounded-lg px-2.5 font-mono text-[11px] leading-none text-text-dim shadow-[inset_0_0_0_1px_var(--hairline-bar)] hover:bg-accent hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Monitor size={13} className="text-text-faint" aria-hidden="true" />
                  {selectedMachine?.name ?? 'Choose machine'}
                  <ChevronDown size={13} className="text-text-faint" aria-hidden="true" />
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
            {/* The chord and the launch travel together in one auto-margined
                group, so hiding the chord on a narrow pane cannot strand the
                button in the middle of the row. */}
            <div className="ml-auto flex flex-none items-center gap-2">
              <span
                className="cold-start-chord font-mono text-[14px] leading-none text-text-faint"
                aria-label="Command Enter"
                title="Command Enter"
              >
                ⌘↵
              </span>
              <button
                type="button"
                data-pressable
                className="btn-primary-rim inline-flex h-[30px] items-center gap-[7px] rounded-[9px] border border-transparent bg-primary px-3.5 text-[12px] leading-none font-semibold text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-strong disabled:cursor-not-allowed disabled:opacity-40"
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
          </div>

          {busy && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-background/75 backdrop-blur-[2px]"
              role="status"
            >
              <div className="inline-flex items-center gap-2.5 rounded-lg bg-bar px-4 py-3 font-mono text-[11px] text-foreground shadow-[inset_0_0_0_1px_var(--border-strong),0_12px_30px_var(--carve-popover-near)]">
                <LoaderCircle size={15} className="animate-spin text-primary" aria-hidden="true" />
                Starting your mission…
              </div>
            </div>
          )}
        </div>

        {!ready && (
          <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
            The selected agent is not ready on this machine yet. Open Settings → Agents to finish
            setup.
          </p>
        )}
        {draft.pendingIssueId && !error && (
          <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
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
