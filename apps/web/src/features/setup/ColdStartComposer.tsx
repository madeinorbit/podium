import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import {
  EMPTY_PINS,
  lastUsedMaps,
  machineViewsFromWire,
  type RepoNavView,
  sidebarSections,
  usableMachines,
} from '@podium/client-core/viewmodels'
import { asMutationId, asSessionId, type GitRepositoryWire } from '@podium/model'
import { asMachineId } from '@podium/model/browser'
import { resolveRole } from '@podium/runtime'
import { ChevronDown, LoaderCircle, Monitor, Paperclip, X } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { AttachmentStrip } from '@/features/chat/AttachmentStrip'
import { useAttachments } from '@/features/chat/use-attachments'
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
  const {
    trpc,
    repos,
    sessions,
    machines,
    uiState,
    focusIssueSession,
    spawnDraftAgent,
    setSelectedIssueId,
    setSelectedWorktree,
    setPane,
    setView,
  } = useStoreSelector(
    (store) => ({
      trpc: store.trpc,
      repos: store.repos,
      sessions: store.sessions,
      machines: store.machines,
      uiState: store.uiState,
      focusIssueSession: store.focusIssueSession,
      spawnDraftAgent: store.spawnDraftAgent,
      setSelectedIssueId: store.setSelectedIssueId,
      setSelectedWorktree: store.setSelectedWorktree,
      setPane: store.setPane,
      setView: store.setView,
    }),
    shallowEqual,
  )
  const repoChoices = useMemo(
    () => {
      const sections = sidebarSections(repos, sessions, EMPTY_PINS)
      const { byRepo } = lastUsedMaps(sections, sessions)
      return sections.repos.sort(
        (a, b) =>
          (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
    },
    [repos, sessions],
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

  /**
   * `use` IS A CODE-EXECUTION BOUNDARY, AND THIS IS NOW WHERE IT IS DRAWN
   * (§3.1.4 M5, moved here by POD-1469).
   *
   * The sidebar's agent → repo → machine menu used to be the surface that read
   * `use` before offering a host — it is gone, and this picker inherited its
   * job. Machines the principal cannot even SEE are already absent (the server's
   * per-principal projection); what is left to read is `use`, per LIST rather
   * than per machine, so a single-machine deployment that evaluates nothing is
   * not left with an empty picker. `unauthorized` is not the same answer as
   * `unreachable` and must not be collapsed into one: waiting fixes the second
   * and never the first, so the row says which it is and the launch is refused
   * only for the first.
   */
  const machineViews = machineViewsFromWire(machines)
  const usable = new Set(usableMachines(machineViews).map((machine) => machine.id))
  const authorized = new Set(
    machineViews
      .filter((view) => view.availability !== 'unauthorized')
      .map((view) => view.machine.id),
  )
  const selectedRepo =
    repoChoices.find(
      (repo) =>
        repo.path === draft.repoPath || repo.machines?.some(({ path }) => path === draft.repoPath),
    ) ?? repoChoices[0]
  const repoMachineIds = new Set(selectedRepo?.machines?.map(({ machineId }) => machineId) ?? [])
  const targetMachines =
    repoMachineIds.size > 0
      ? machines.filter((machine) => repoMachineIds.has(machine.id))
      : machines
  // AN UNAUTHORIZED HOST IS LISTED, NEVER DEFAULTED. Removing it would collapse
  // "ask its owner" into "that machine does not exist", which is the reading M5
  // spends its whole argument keeping apart — and the operator would have no way
  // to find out why the host they can see is not on offer. So the row stays,
  // says `no access`, and only the DEFAULT skips over it.
  const selectedMachine =
    targetMachines.find((machine) => machine.id === draft.machineId) ??
    targetMachines.find((machine) => usable.has(machine.id)) ??
    targetMachines.find((machine) => authorized.has(machine.id)) ??
    targetMachines[0]
  const selectedCheckout = selectedRepo
    ? checkoutForMachine(repos, selectedRepo, selectedMachine?.id)
    : undefined
  /** A host the operator may see but not run on. Everything that starts work
   *  refuses on it; the picker still shows it, saying why. */
  const machineDenied = selectedMachine !== undefined && !authorized.has(selectedMachine.id)
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

  /**
   * TWO MODES, ONE BOX (POD-1469).
   *
   * The box opened as a 132px well every time, which asserted that a mission
   * always begins with a paragraph. It does not: half the time the operator
   * wants the harness in front of them and will type into the agent itself. So
   * the well starts CLOSED — one clickable line of placeholder over the
   * instrument row — and unfolds when they say they have something to write.
   *
   * The two modes differ in exactly one more place, and it is the important one:
   * what Launch does. Closed, it starts the agent with no prompt (`startCli`)
   * and is always available, because "no prompt" is the whole request. Open, it
   * creates the mission from what was typed and is refused while that is empty,
   * because an empty box in prompt mode is an unfinished sentence rather than a
   * decision.
   *
   * EXPANSION IS DERIVED, NOT STORED. A persisted draft with words in it — the
   * operator navigated away mid-sentence — has to come back open, or the text
   * they wrote would be invisible under a placeholder saying the box is empty.
   * The same holds the moment a file is attached: the strip lives inside the
   * well, so attaching has to open it.
   */
  const [unfolded, setUnfolded] = useState(false)
  const expanded = unfolded || draft.title.length > 0 || attachments.attachments.length > 0
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const collapse = useCallback(() => {
    setUnfolded(false)
    setDraft({ ...draft, title: '' })
    attachments.clear()
    // Blur, or the field's own focus would re-open the box it just closed.
    inputRef.current?.blur()
  }, [attachments, draft, setDraft])

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
    const machine =
      candidates.find((candidate) => usable.has(candidate.id)) ??
      candidates.find((candidate) => authorized.has(candidate.id)) ??
      candidates[0]
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

  /**
   * LAUNCH WITH NOTHING WRITTEN: the agent, on this machine, in a new tab
   * (POD-1469).
   *
   * This is the action the sidebar's `New <Agent> in <Repo>` chip used to be,
   * and it is the same call it made — an optimistic `spawnDraftAgent` into a
   * fresh draft vessel, navigated with the client-minted ids so the tab is there
   * on the click rather than on the broadcast. What moved is WHERE the choices
   * are made: the harness, its model and effort, and the host are the four
   * pickers directly under this button instead of a chevron menu hidden inside
   * the chip.
   *
   * NO ISSUE IS WRITTEN FROM HERE. The draft vessel is what `spawnDraftAgent`
   * makes, and it stays a vessel — a CLI session the operator opened is not a
   * mission with a brief, and inventing a title for it out of nothing is how the
   * column fills with `Untitled task`.
   */
  const startCli = (): void => {
    if (busy || !selectedRepo || !selectedCheckout || !selectedMachine || machineDenied || !ready)
      return
    const machineId = asMachineId(selectedMachine.id)
    // The CHECKOUT's path, not the project's: a repo present on more than one
    // host has a different path on each, and the vessel has to land in the one
    // that exists on the machine the operator picked.
    const { sessionId, issueId } = spawnDraftAgent({
      target: {
        path: selectedCheckout.path,
        repoPath: selectedCheckout.path,
        machineId,
        ...(selectedRepo.repoId !== undefined ? { repoId: selectedRepo.repoId } : {}),
      },
      agentKind: agent,
      ...(draft.model !== AUTO ? { model: draft.model } : {}),
      ...(draft.effort !== AUTO ? { effort: draft.effort } : {}),
    })
    // The prompt was never written, so nothing is left to restore — but the
    // instruments were chosen and stay chosen for the next one.
    setDraft({ ...draft, title: '' })
    setSelectedIssueId(issueId)
    setSelectedWorktree(selectedCheckout.path)
    setPane('A', sessionId)
    setView('workspace')
  }

  const start = async (): Promise<void> => {
    const prompt = draft.title.trim()
    if (
      busy ||
      attachments.uploading ||
      !selectedRepo ||
      !selectedCheckout ||
      !selectedMachine ||
      machineDenied ||
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

  /** What Launch and ⌘↵ do, which is the one thing the two modes disagree about. */
  const launch = (): void => {
    if (expanded) void start()
    else startCli()
  }
  const launchable = expanded
    ? Boolean(draft.pendingIssueId) || draft.title.trim().length > 0
    : true
  const launchBlocked =
    busy ||
    // A launch that outran its uploads would create the mission with a brief
    // naming files that are still in flight.
    attachments.uploading ||
    !selectedRepo ||
    !selectedCheckout ||
    !selectedMachine ||
    machineDenied ||
    !ready ||
    !launchable

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
          data-testid="cold-start-field"
          data-expanded={expanded ? 'true' : 'false'}
          className="cold-start-field relative overflow-hidden rounded-[14px] bg-bar shadow-[inset_0_0_0_1px_var(--border-strong),0_20px_50px_-30px_var(--carve-drop)]"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              launch()
            }
          }}
          {...attachments.dropHandlers}
        >
          {/* ONE ELEMENT IN BOTH MODES, not a line that is swapped for a well.
              The field is the same textarea throughout — it is only shorter —
              so the click that opens it is the click that focuses it, the caret
              lands where the placeholder was, and there is no frame in which the
              operator is typing into something that has just been unmounted. */}
          <textarea
            ref={inputRef}
            aria-label="What do you want to work on?"
            rows={1}
            value={draft.title}
            disabled={busy || Boolean(draft.pendingIssueId)}
            onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
            onFocus={() => setUnfolded(true)}
            onKeyDown={(event) => {
              // Escape closes an EMPTY box and nothing else. Two keystrokes from
              // discarding a written prompt is not a shortcut, it is a trap —
              // the X is the way out of one of those, deliberately deliberate.
              if (event.key === 'Escape' && draft.title.length === 0) {
                event.stopPropagation()
                collapse()
              }
            }}
            onPaste={attachments.onPaste}
            placeholder={
              expanded
                ? 'Describe the mission — an outcome, a bug, a question about the codebase…'
                : 'Click here to enter a prompt.'
            }
            className="cold-start-input block w-full resize-none bg-transparent px-[22px] text-[14.5px] leading-[1.6] text-text-strong outline-none placeholder:text-text-faint disabled:opacity-60"
          />
          {/* THE WAY BACK OUT, and it is only offered where there is something to
              go back to. It clears rather than hides: a collapsed box showing
              `Click here to enter a prompt` while still holding a paragraph
              would launch a mission the operator believes they cancelled. */}
          {expanded && (
            <button
              type="button"
              data-pressable
              data-testid="cold-start-collapse"
              aria-label="Close the prompt"
              title="Close the prompt"
              onClick={collapse}
              className="absolute top-[9px] right-[10px] z-10 inline-flex size-6 items-center justify-center rounded-md text-text-faint transition-colors hover:bg-accent hover:text-text-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
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
                  {selectedMachine?.name ?? 'Choose machine'}
                  <ChevronDown size={13} className="text-text-faint" aria-hidden="true" />
                </button>
              }
              options={targetMachines.map((machine) => ({
                value: machine.id,
                label: `${machine.name}${
                  !authorized.has(machine.id) ? ' (no access)' : machine.online ? '' : ' (offline)'
                }`,
              }))}
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
            {/* THE CHORD IS IN THE BUTTON NOW (POD-1469). It used to sit beside
                it as a bare `⌘↵` in the row's ink — a mark with nothing
                attaching it to the control it fires, which is why it also had to
                be hidden below 560px to stop reading as a third instrument. On
                the button it is unambiguous at any width, and it replaces the
                arrow: an arrow says "forward", the chord says how to do this
                without the mouse, and only one of those is information. */}
            <div className="ml-auto flex flex-none items-center gap-2">
              <button
                type="button"
                data-pressable
                data-testid="cold-start-launch"
                className="btn-primary-rim inline-flex h-[30px] items-center gap-[9px] rounded-[9px] border border-transparent bg-primary px-3.5 text-[12px] leading-none font-semibold text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-strong disabled:cursor-not-allowed disabled:opacity-40"
                disabled={launchBlocked}
                onClick={launch}
                aria-label={
                  draft.pendingIssueId
                    ? 'Retry starting work'
                    : expanded
                      ? 'Start work'
                      : `Start a ${issueAgentLabel(agent)} session`
                }
                // Closed, this button does something the words do not say on
                // their own — so the tooltip says it.
                title={
                  expanded
                    ? undefined
                    : `Start a ${issueAgentLabel(agent)} session in ${
                        selectedRepo ? repoLabel(selectedRepo) : 'this project'
                      } with no prompt`
                }
              >
                {busy ? (
                  <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <>
                    Launch
                    <span
                      className="cold-start-chord font-mono text-[12.5px] leading-none text-primary-foreground/60"
                      aria-hidden="true"
                    >
                      ⌘↵
                    </span>
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

        {/* UNAUTHORIZED IS NOT UNREADY, and it is stated first: no amount of
            agent setup makes a host you have no grant on runnable, so the note
            that sends the operator to Settings would be a wrong instruction. */}
        {machineDenied ? (
          <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
            You do not have access to run work on this machine. Ask its owner for access, or pick
            another machine.
          </p>
        ) : (
          !ready && (
            <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
              The selected agent is not ready on this machine yet. Open Settings → Agents to finish
              setup.
            </p>
          )
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
