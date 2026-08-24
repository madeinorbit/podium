import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import {
  EMPTY_PINS,
  lastUsedMaps,
  type RepoNavView,
  sidebarSections,
} from '@podium/client-core/viewmodels'
import {
  asMutationId,
  asSessionId,
  type GitRepositoryWire,
  HOST_REPOS,
  type MachineActionCopy,
} from '@podium/model'
import { resolveRole } from '@podium/runtime'
import { ArrowRight, ChevronDown, LoaderCircle, Monitor, Paperclip } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { AttachmentStrip } from '@/features/chat/AttachmentStrip'
import { useAttachments } from '@/features/chat/use-attachments'
import { machineOptionLabel, useMachineChoices } from '@/features/machines/machine-choices'
import { AUTO } from '@/lib/agent-models'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentIcon,
  issueAgentKind,
  issueAgentLabel,
} from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { PropertyMenu } from '@/lib/PropertyMenu'

/** What the cold-start composer is choosing a machine FOR. */
const COLD_START_COPY: MachineActionCopy = {
  action: 'run this mission',
  capability: 'run agents',
  remedy: 'Pair a machine that runs the Podium daemon.',
}

import { activationAgentIsReady, activationAgentReadiness } from './agent-readiness'
import { clearFirstTaskDraft, persistFirstTaskDraft, readFirstTaskDraft } from './first-task-draft'
import { SetupError } from './SetupFeedback'

function repoLabel(repo: { path: string; name?: string }): string {
  return repo.name ?? repo.path.split('/').filter(Boolean).pop() ?? repo.path
}

function checkoutForMachine(
  repos: GitRepositoryWire[],
  repo: RepoNavView,
  machineId: string | undefined,
): GitRepositoryWire | undefined {
  const path =
    repo.machines?.find((candidate) => candidate.machineId === machineId)?.path ?? repo.path
  return repos.find(
    (candidate) =>
      candidate.kind !== 'worktree' &&
      candidate.path === path &&
      (machineId === undefined || candidate.machineId === machineId),
  )
}

function promptTitle(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return (firstLine ?? prompt.trim()).slice(0, 120)
}

/**
 * THE BRIEF IS WHERE THE ATTACHED PATHS GO (POD-1203).
 *
 * A started issue's first prompt is `description` then `brief`, joined
 * ([spec:SP-6144]) — so either field reaches the agent. The brief is the right
 * half: the description is prose a HUMAN reads, on the issue card, in the
 * sidebar and as the source of the title, and three absolute upload paths
 * stapled to the front of it would be the first thing they see about their own
 * mission. The brief is where technical detail belongs, and the agent reads both.
 *
 * The chat composer's own convention is paths first, then prose; the ordering
 * differs here for the same reason the fields do — an issue leads with its
 * summary, and the spec says so.
 */
function attachmentBrief(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  return [
    paths.length === 1
      ? 'The operator attached this file to the mission:'
      : 'The operator attached these files to the mission:',
    ...paths,
  ].join('\n')
}

export function ColdStartComposer({ first }: { first: boolean }): JSX.Element {
  const { trpc, repos, sessions, machines, uiState, focusIssueSession } = useStoreSelector(
    (store) => ({
      trpc: store.trpc,
      repos: store.repos,
      sessions: store.sessions,
      machines: store.machines,
      uiState: store.uiState,
      focusIssueSession: store.focusIssueSession,
    }),
    shallowEqual,
  )
  const repoChoices = useMemo(() => {
    const sections = sidebarSections(repos, sessions, EMPTY_PINS)
    const { byRepo } = lastUsedMaps(sections, sessions)
    return sections.repos.sort(
      (a, b) =>
        (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }, [repos, sessions])
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

  const selectedRepo =
    repoChoices.find(
      (repo) =>
        repo.path === draft.repoPath || repo.machines?.some(({ path }) => path === draft.repoPath),
    ) ?? repoChoices[0]
  const repoMachineIds = new Set(selectedRepo?.machines?.map(({ machineId }) => machineId) ?? [])
  /**
   * POD-2700. The fallback here used to be THE WHOLE FLEET: when the repo named
   * no machines, every row was offered — coordinator included — and the auto-pick
   * below then landed on `targetMachines[0]`. Two of §3.3's retired fallbacks in
   * four lines. The population is now the machines that could actually run this
   * mission, and when that is empty the composer says so instead of picking.
   */
  const machineChoices = useMachineChoices(
    repoMachineIds.size > 0
      ? machines.filter((machine) => repoMachineIds.has(machine.id))
      : machines,
    HOST_REPOS,
    COLD_START_COPY,
    draft.machineId,
  )
  const targetMachines = machineChoices.options.map((choice) => choice.machine)
  const selectedMachine =
    machineChoices.selectable.find((machine) => machine.id === draft.machineId) ??
    machineChoices.selectable.find((machine) => machine.online) ??
    machineChoices.selectable[0]
  const selectedCheckout = selectedRepo
    ? checkoutForMachine(repos, selectedRepo, selectedMachine?.id)
    : undefined
  const detectedReadyAgent = ISSUE_AGENT_KINDS.find((candidate) =>
    activationAgentIsReady(
      activationAgentReadiness(
        selectedCheckout,
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
        selectedCheckout,
        selectedMachine ? [selectedMachine] : machines,
        configuredAgent,
      ),
    )
      ? configuredAgent
      : detectedReadyAgent) ??
    configuredAgent ??
    'claude-code'
  const readiness = activationAgentReadiness(
    selectedCheckout,
    selectedMachine ? [selectedMachine] : machines,
    agent,
  )
  const ready = activationAgentIsReady(readiness)

  /**
   * ATTACHING BEFORE THERE IS ANYTHING TO ATTACH TO (POD-1203).
   *
   * The same hook, the same mutation and the same daemon that the session chat
   * composer uses — a second upload path would be a second set of size limits,
   * failure shapes and GC rules to keep in step, for no gain. The two things it
   * has to be told are the two the session normally answers:
   *
   *  - WHICH MACHINE. The chosen one, because the paths that come back have to be
   *    valid on the disk this mission is about to run on. The hook re-uploads by
   *    itself if that choice changes underneath an attachment.
   *  - WHICH FOLDER. Uploads are filed per session, and this one has no session.
   *    A scope id minted here stands in for it: the daemon treats it as an opaque
   *    directory name (it deliberately validates no session — a client may upload
   *    before the PTY is live), so the bytes land beside every other upload and
   *    are swept by the same 24h TTL. It is NOT a session id in disguise; nothing
   *    ever looks it up, and the session this mission spawns gets its own.
   */
  const [uploadScope] = useState(() => asSessionId(`coldstart-${randomUUID()}`))
  const attachments = useAttachments({
    sessionId: uploadScope,
    trpc,
    ...(selectedMachine ? { machineId: selectedMachine.id } : {}),
  })

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
    const repoMachines = new Set(repo?.machines?.map(({ machineId }) => machineId) ?? [])
    const candidates =
      repoMachines.size > 0
        ? machines.filter((candidate) => repoMachines.has(candidate.id))
        : machines
    const machine = candidates.find((candidate) => candidate.online) ?? candidates[0]
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
    if (
      busy ||
      attachments.uploading ||
      !selectedRepo ||
      !selectedCheckout ||
      !selectedMachine ||
      !ready ||
      (!draft.pendingIssueId && !prompt)
    )
      return
    setBusy(true)
    setError(null)
    try {
      const brief = attachmentBrief(attachments.ready().paths)
      const createMutationId = draft.createMutationId || asMutationId(randomUUID())
      const created = draft.pendingIssueId
        ? { id: draft.pendingIssueId }
        : await trpc.issues.create.mutate({
            repoPath: selectedCheckout.path,
            machineId: selectedMachine.id,
            title: promptTitle(prompt),
            description: prompt,
            ...(brief ? { brief } : {}),
            parentBranch: selectedCheckout.branch?.trim() || undefined,
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
      attachments.clear()
      // SENDING A PROMPT LANDS ON THE TRANSCRIPT IT STARTED (POD-1202).
      //
      // Selecting the issue was all this used to do, and at that moment the
      // issue has no session: the mission came on screen with an empty tab area
      // and the launch read as having done nothing. `focusIssueSession` holds
      // for the session row and opens its tab, so the operator arrives on the
      // agent that is already working. The overlay above stays up for that wait
      // — this composer unmounts the moment the workspace has the tab.
      await focusIssueSession(created.id)
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

        {/* The DROP TARGET is the whole box, not the textarea (POD-1203): a drag
            aimed at a mission is aimed at the composer, and half of this box is
            the instrument row. Same reach the chat composer gives it. */}
        <div
          className="cold-start-field relative overflow-hidden rounded-[14px] bg-bar shadow-[inset_0_0_0_1px_var(--border-strong),0_20px_50px_-30px_var(--carve-drop)]"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void start()
            }
          }}
          {...attachments.dropHandlers}
        >
          <textarea
            aria-label="What do you want to work on?"
            autoFocus
            value={draft.title}
            disabled={busy || Boolean(draft.pendingIssueId)}
            onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
            onPaste={attachments.onPaste}
            placeholder="Describe the mission — an outcome, a bug, a question about the codebase…"
            className="cold-start-input block w-full resize-none bg-transparent px-[22px] text-[14.5px] leading-[1.6] text-text-strong outline-none placeholder:text-text-faint disabled:opacity-60"
          />
          {attachments.attachments.length > 0 && (
            <div className="px-[22px] pb-2.5">
              <AttachmentStrip
                attachments={attachments.attachments}
                onRemove={attachments.remove}
              />
            </div>
          )}
          <input
            ref={attachments.fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={attachments.onFileInputChange}
          />
          {attachments.dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[14px] border-2 border-dashed border-primary bg-primary/5">
              <span className="text-sm font-medium text-primary">Drop files to attach</span>
            </div>
          )}
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
                machineId={selectedMachine?.id}
                value={draft.model}
                onChange={(model) => setDraft({ ...draft, model, effort: AUTO })}
              />
              <span className="w-px bg-hairline-bar" aria-hidden="true" />
              <EffortPicker
                variant="composer"
                agentKind={agent}
                machineId={selectedMachine?.id}
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
                  {selectedMachine?.name ??
                    (machineChoices.emptyState ? 'No machine can run this' : 'Choose machine')}
                  <ChevronDown size={13} className="text-text-faint" aria-hidden="true" />
                </button>
              }
              options={machineChoices.options.map((choice) => ({
                value: choice.machine.id,
                label: machineOptionLabel(choice),
              }))}
              footnote={machineChoices.exclusionNote ?? machineChoices.emptyState?.detail}
              selectedValue={selectedMachine?.id}
              placeholder="Choose a machine…"
              onSelect={selectMachine}
            />
            {/* The clip sits with the machine picker rather than beside Launch:
                both name WHAT the mission is given, and the auto-margined group
                to its right is reserved for the act of launching it. */}
            <button
              type="button"
              data-pressable
              aria-label="Attach a file"
              title="Attach a file"
              disabled={busy || Boolean(draft.pendingIssueId)}
              onClick={attachments.openFilePicker}
              className="inline-flex size-7 flex-none items-center justify-center rounded-lg text-text-dim shadow-[inset_0_0_0_1px_var(--hairline-bar)] hover:bg-accent hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Paperclip size={13} aria-hidden="true" />
            </button>
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
                  // A launch that outran its uploads would create the mission
                  // with a brief naming files that are still in flight.
                  attachments.uploading ||
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
