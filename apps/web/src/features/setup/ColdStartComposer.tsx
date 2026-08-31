import { randomUUID } from '@podium/client-core/id'
import { shallowEqual } from '@podium/client-core/store'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import {
  machineViewsFromWire,
  reposToViews,
  repoUsageAt,
  type RepoView,
  resolveDefaultAgent,
  sidebarSessions,
  usableMachines,
} from '@podium/client-core/viewmodels'
import { asIssueId, asMutationId, asSessionId, type GitRepositoryWire } from '@podium/model'
import { asMachineId } from '@podium/model/browser'
import { nativeAccountId, resolveRole } from '@podium/runtime'
import { ChevronDown, LoaderCircle, Monitor, Paperclip, X } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { AttachmentStrip } from '@/features/chat/AttachmentStrip'
import { useAttachments } from '@/features/chat/use-attachments'
import { chordLabel, useComposerChord } from '@/features/chat/use-composer-chord'
import {
  agentFleetStatus,
  CapabilityAgentMenu,
  candidateFromAvailability,
} from '@/lib/agent-capability'
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
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
import { activationAgentIsReady, activationAgentReadiness } from './agent-readiness'
import {
  clearFirstTaskDraft,
  type FirstTaskDraft,
  readFirstTaskDraft,
  serializeFirstTaskDraft,
} from './first-task-draft'
import { SetupError } from './SetupFeedback'

function repoLabel(repo: { path: string; name?: string }): string {
  return repo.name ?? repo.path.split('/').filter(Boolean).pop() ?? repo.path
}

/**
 * WHICH CHECKOUT ON DISK A PICKER ENTRY MEANS (POD-1582).
 *
 * A picker entry is a repo IDENTITY, not a directory: `reposToViews` groups by
 * `repoId`, which is derived from the origin URL alone, so two clones of one
 * origin on one machine arrive as a single entry carrying two `machines[]` rows
 * with the same `machineId`. Something has to choose between them, and the two
 * ways to get that wrong are both live:
 *
 *  - SCAN ORDER. `find` took whichever row the scanner happened to append
 *    first, so which clone a mission was created in could change between
 *    refreshes. The candidates are sorted, so the answer is at least the same
 *    answer twice.
 *  - THE OPERATOR'S OWN CHOICE. A draft's `repoPath` may already name one of
 *    those checkouts — that is how `selectedRepo` matched the entry. `prefer`
 *    honours it, which is the only way the second clone is reachable at all
 *    until the picker offers both (POD-1629).
 *
 * Returns undefined when the identity has no non-worktree checkout on that
 * machine; every caller treats that as "cannot launch here" rather than as a
 * repo that merely needs setup.
 */
function checkoutForMachine(
  repos: GitRepositoryWire[],
  repo: RepoView,
  machineId: string | undefined,
  prefer?: string,
): GitRepositoryWire | undefined {
  const onMachine = (repo.machines ?? [])
    .filter((candidate) => machineId === undefined || candidate.machineId === machineId)
    .map((candidate) => candidate.path)
    .sort()
  const ordered = [
    ...(prefer !== undefined && onMachine.includes(prefer) ? [prefer] : []),
    ...onMachine,
    repo.path,
  ]
  for (const path of ordered) {
    const found = repos.find(
      (candidate) =>
        candidate.kind !== 'worktree' &&
        candidate.path === path &&
        (machineId === undefined || candidate.machineId === machineId),
    )
    if (found) return found
  }
  return undefined
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
 * Persisted launches from before direct issue attachments still carry daemon
 * paths. Keep those retries readable without putting paths into human-facing
 * issue metadata. New launches send browser bytes to the draft issue instead.
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

function withoutCreateReservation(draft: FirstTaskDraft): FirstTaskDraft {
  return {
    ...draft,
    launchKind: '',
    createIssueId: '',
    createSessionId: '',
    createMutationId: '',
    attachmentPaths: [],
    launchError: '',
  }
}

export function ColdStartComposer({ first }: { first: boolean }): JSX.Element {
  const {
    trpc,
    repos,
    // Read to rank the project list AND to answer "which harness did you last
    // run" — see `repoChoices` and `defaultAgent`.
    sessions,
    machines,
    uiState,
    focusIssueSession,
    spawnDraftAgent,
    spawnIssueAgent,
    setSelectedIssueId,
    setSelectedWorktree,
    setPane,
    setPanelMode,
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
      spawnIssueAgent: store.spawnIssueAgent,
      setSelectedIssueId: store.setSelectedIssueId,
      setSelectedWorktree: store.setSelectedWorktree,
      setPane: store.setPane,
      setPanelMode: store.setPanelMode,
      setView: store.setView,
    }),
    shallowEqual,
  )
  /**
   * THE PICKER OFFERS EXACTLY WHAT LAUNCH CAN RESOLVE (POD-1582).
   *
   * Two rules that used to disagree. The list came from `sidebarSections`,
   * which drops nothing by `kind`, while `checkoutForMachine` rejects a
   * `worktree` — so a linked worktree registered as its own root, with no
   * registered parent to nest it under, rendered as a project whose Launch
   * button could never enable and whose only explanation was an agent-setup
   * message about an agent that was fine. One predicate now answers both: an
   * entry is listed only if it resolves to a real checkout somewhere.
   *
   * Ordering is `repoUsageAt`, which exists for this ("for sorting repo
   * pickers by recent use") and reads the two session fields it needs. The
   * sidebar model this used to build was thrown away except for path, name and
   * machines, and it rebuilt the whole session-ownership index every time the
   * sessions array was replaced — which is many times a second next to a busy
   * fleet, for a pane that is not even showing sessions.
   */
  const repoChoices = useMemo(() => {
    const usage = new Map<string, number>()
    const active = sidebarSessions(sessions)
    for (const repo of repos) usage.set(repo.path, repoUsageAt(repo, active))
    const usageFor = (view: RepoView): number =>
      Math.max(
        usage.get(view.path) ?? 0,
        ...(view.machines ?? []).map(({ path }) => usage.get(path) ?? 0),
      )
    return reposToViews(repos)
      .filter((view) => checkoutForMachine(repos, view, undefined) !== undefined)
      .sort(
        (a, b) =>
          usageFor(b) - usageFor(a) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
  }, [repos, sessions])
  /**
   * THE DRAFT IS SUBSCRIBED, NOT SEEDED (POD-1469).
   *
   * A `useState(() => uiState.get(...))` initializer runs once, and this box is
   * mounted for the whole time the shell has nothing selected — which is exactly
   * the state `New task` and `Start first task` are pressed from. Those write the
   * seed into this key and clear the selection; with a seeded copy the composer
   * never re-read it, so the sidebar's buttons appeared to do nothing: the old
   * half-typed prompt stayed on screen, the named project was discarded, and the
   * next keystroke wrote the stale draft back over the seed.
   *
   * `usePersistedUiState` removes that second source of truth by construction —
   * the stored row IS the state. This key is device-local, so the write and the
   * read back are synchronous and typing costs the same render it always did.
   */
  const [draft, setDraft] = usePersistedUiState(
    FIRST_TASK_ACTIVATION_DRAFT_KEY,
    readFirstTaskDraft,
    serializeFirstTaskDraft,
  )
  /**
   * The operator's harness, as `roles.coding` answers it — the same read the
   * deleted sidebar chip made, and held as a raw string for the same reason it
   * was there (POD-1469). It is written back from the agent menu below, which is
   * what makes "the last one you used" a fact rather than a hope.
   */
  const [agentSetting, setAgentSetting] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Durable launch failures belong to the draft, not component lifetime. The
  // recovery composer can mount one microtask before the outcome writes its
  // error; reading the subscribed draft lets that late value appear. Local
  // state is reserved for synchronous faults that never reached persistence.
  const [transientError, setError] = useState<string | null>(null)
  const error = draft.launchError || transientError

  useEffect(() => {
    let cancelled = false
    void trpc.settings.get
      .query()
      .then((settings) => {
        if (!cancelled) setAgentSetting(resolveRole(settings, 'coding').harness)
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
  // Memoized on `machines` alone: this box re-renders on every keystroke in the
  // prompt, and neither set has anything to do with what was typed.
  const { usable, authorized } = useMemo(() => {
    const views = machineViewsFromWire(machines)
    return {
      usable: new Set(usableMachines(views).map((machine) => machine.id)),
      authorized: new Set(
        views.filter((view) => view.availability !== 'unauthorized').map((view) => view.machine.id),
      ),
    }
  }, [machines])
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
    ? checkoutForMachine(repos, selectedRepo, selectedMachine?.id, draft.repoPath)
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
  /**
   * WHICH HARNESS THIS BOX OPENS ON — the sidebar chip's rule, inherited whole
   * (POD-1469).
   *
   * `New <Agent> in <Repo>` answered this with `resolveDefaultAgent` over the
   * `roles.coding` harness, so that is the call, unchanged. In practice the
   * settings read always yields a concrete harness — a native account NAMES its
   * CLI (`native:codex`) and the role's default account names Claude Code — so
   * what actually carries "the last one you used" is the write in
   * `persistDefaultAgent` below, exactly as it did for the chip. The resolver's
   * session fallback stays because it is the same resolver, and it is the right
   * answer for the one input that can still arrive unresolved (`auto`).
   *
   * Then availability, and only then: a default that cannot start on the chosen
   * machine is not a default, so it steps aside for the first harness that can.
   * A pick made in THIS box outranks both — it is the most recent thing the
   * operator said about this specific task.
   */
  const defaultAgent = issueAgentKind(resolveDefaultAgent(agentSetting, sessions)) ?? 'claude-code'

  /**
   * PICKING A HARNESS HERE IS A WRITE (POD-1469).
   *
   * This is the half of the sidebar chip's behaviour that did not survive the
   * move. `New <Agent> in <Repo>` showed the last harness you chose because its
   * menu PERSISTED the choice — `roles.coding.accountId` — so the next spawn,
   * from any surface, opened on it. The composer only ever held the pick in its
   * own draft: correct for one run of the box, forgotten by the issue page, the
   * dock and the CLI, and gone the moment ui-state was cleared.
   *
   * It is deliberately the same key and the same account spelling
   * (`nativeAccountId`), because the point is that every surface reads ONE
   * answer to "which harness does this operator work in".
   *
   * IT FIRES ON LAUNCH, NOT ON SELECT, which is also the chip's own rule:
   * `NewAgentMenu.pick()` persisted and spawned as ONE action, so the operator's
   * global default only ever moved when work actually started on that harness.
   * Writing it from the menu's `onSelect` would mean opening the chip to look at
   * Codex, changing your mind, and navigating away had silently retargeted the
   * issue page, the dock and the CLI — with nothing to undo it. The draft already
   * carries the pick for THIS task; this key is only for the next one.
   *
   * Best-effort: the local read is updated first either way, so a failed write
   * costs the operator the persistence and never the pick they just made.
   */
  const persistDefaultAgent = async (kind: IssueAgentKind): Promise<void> => {
    setAgentSetting(kind)
    try {
      const updated = await trpc.settings.updatePersonal.mutate({
        values: { 'roles.coding.accountId': nativeAccountId(kind) },
      })
      setAgentSetting(resolveRole(updated, 'coding').harness)
    } catch {
      // Kept optimistic — see above.
    }
  }
  const agent =
    issueAgentKind(draft.agent) ??
    (activationAgentIsReady(
      activationAgentReadiness(
        selectedCheckout,
        selectedMachine ? [selectedMachine] : machines,
        defaultAgent,
      ),
    )
      ? defaultAgent
      : detectedReadyAgent) ??
    defaultAgent
  const readiness = activationAgentReadiness(
    selectedCheckout,
    selectedMachine ? [selectedMachine] : machines,
    agent,
  )
  const ready = activationAgentIsReady(readiness)
  /**
   * THE SAME REFUSAL VOCABULARY AS EVERY OTHER SPAWN MENU (POD-1201).
   *
   * This chip used PropertyMenu, which has no idea a harness can be missing,
   * signed out, or unauthorized — so Cursor on a machine without Cursor looked
   * exactly as startable as Grok. CapabilityAgentMenu is the shared picker the
   * issue page, the new-issue dialog and the tab strip already wear; the
   * reading is the selected host, because that is the host Launch will spend.
   */
  const agentOptions = useMemo(() => {
    const hosts = selectedMachine ? [selectedMachine] : []
    return ISSUE_AGENT_KINDS.map((kind) => {
      const label = issueAgentLabel(kind)
      const candidates = hosts.map((machine) =>
        candidateFromAvailability(
          machine,
          !authorized.has(machine.id)
            ? 'unauthorized'
            : machine.online
              ? 'available'
              : 'unreachable',
          kind,
        ),
      )
      return {
        value: kind,
        label,
        icon: issueAgentIcon(kind, 13),
        status: hosts.length > 0 ? agentFleetStatus(candidates, label) : {},
      }
    })
  }, [authorized, selectedMachine])

  /** The home composer has no issue yet. Keep picked bytes in browser memory;
   *  `sessions.create` snapshots them onto the new draft before its agent runs.
   *  Existing-session chat keeps using daemon workspace uploads. */
  const [uploadScope] = useState(() => asSessionId(`coldstart-${randomUUID()}`))
  const attachments = useAttachments({
    sessionId: uploadScope,
    trpc,
    destination: 'issue',
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
   * well, so attaching has to open it. And a FAILED launch holds the box open by
   * the same rule: `pendingIssueId` means an issue exists and is waiting to be
   * started, so Launch must stay the retry — a closed box would route the press
   * to `startCli` and strand the mission the operator thought they were retrying.
   *
   * FIRST RUN OPENS WRITTEN. The headline above says "give this project its first
   * mission", and a closed box under that sentence answers it with a promptless
   * CLI vessel on the most obvious click there is.
   */
  const [unfolded, setUnfolded] = useState(first)
  const expanded =
    unfolded ||
    draft.title.trim().length > 0 ||
    attachments.attachments.length > 0 ||
    Boolean(draft.pendingIssueId)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const [focused, setFocused] = useState(false)
  /**
   * THE FOCUS CHORD (POD-993). The session prompt already answers ⌘/ (and ⌘L
   * from the macOS View menu). This box is the prompt when nothing is open, so
   * it registers as the same target: the slash chord via the shared listener,
   * and `__PODIUM_FOCUS_SESSION_PROMPT__` so the native menu has somewhere to
   * land when there is no session panel.
   */
  const focusField = useCallback(() => {
    inputRef.current?.focus()
  }, [])
  useComposerChord(rootEl, focusField)
  useEffect(() => {
    const globals = globalThis as { __PODIUM_FOCUS_SESSION_PROMPT__?: () => void }
    globals.__PODIUM_FOCUS_SESSION_PROMPT__ = focusField
    return () => {
      if (globals.__PODIUM_FOCUS_SESSION_PROMPT__ === focusField) {
        delete globals.__PODIUM_FOCUS_SESSION_PROMPT__
      }
    }
  }, [focusField])
  const collapse = useCallback(() => {
    // A retry in flight owns this box; there is no closed mode that could carry
    // it, so the control is not offered and this is a no-op if it is reached.
    if (draft.pendingIssueId) return
    setUnfolded(false)
    setDraft(withoutCreateReservation({ ...draft, title: '' }))
    attachments.clear()
    // Blur, or the field's own focus would re-open the box it just closed.
    inputRef.current?.blur()
  }, [attachments, draft, setDraft])

  /**
   * A DIFFERENT PATH FOR THE SAME PROJECT IS NOT A DIFFERENT PROJECT (POD-1582).
   *
   * `selectedRepo` deliberately matches a draft whose `repoPath` is one of the
   * entry's machine-specific paths rather than the group's canonical one — that
   * is how a draft written on one machine still finds its project. Comparing
   * against `selectedRepo.path` alone then read that alias as a repo SWITCH, so
   * the first render after such a draft loaded rewrote it with `model: AUTO,
   * effort: AUTO` and the operator's choices were gone before they touched
   * anything. Model and effort reset when the project actually changes, which
   * is what `selectRepo` does explicitly.
   *
   * The alias is also kept rather than canonicalised, because it is the only
   * record of WHICH checkout the operator meant when one origin has two on a
   * machine — `checkoutForMachine` reads it back as `prefer`.
   */
  useEffect(() => {
    if (!selectedRepo) return
    const aliases = [selectedRepo.path, ...(selectedRepo.machines ?? []).map(({ path }) => path)]
    const repoChanged = !aliases.includes(draft.repoPath)
    const machineChanged = selectedMachine && draft.machineId !== selectedMachine.id
    /**
     * NOT BEFORE THE SETTINGS LAND (POD-1469).
     *
     * This clause is what writes the resolved harness into the draft, and the
     * draft then OUTRANKS everything — it is the operator's own pick. So filling
     * it one render too early is not a cosmetic race: on the first paint
     * `agentSetting` is still undefined, `defaultAgent` is therefore the bare
     * `claude-code` fallback, and this effect pinned that into the draft before
     * the settings query had answered. Every later render read the draft and
     * found `claude-code` sitting there, so an operator whose harness is Codex
     * got Claude Code on every new task — and the `roles.coding` read this whole
     * resolution rests on could never be seen to matter.
     *
     * The repo and machine clauses have no such problem: both come from the
     * replica, which is already there on the first paint.
     */
    const agentChanged = !draft.agent && agentSetting !== undefined
    if (!repoChanged && !machineChanged && !agentChanged) return
    setDraft({
      ...draft,
      repoPath: repoChanged ? selectedRepo.path : draft.repoPath,
      machineId: selectedMachine?.id ?? '',
      ...(agentChanged ? { agent } : {}),
      ...(repoChanged ? { model: AUTO, effort: AUTO } : {}),
    })
  }, [agent, agentSetting, draft, selectedMachine, selectedRepo, setDraft])

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
      createIssueId: '',
      createSessionId: '',
      createMutationId: '',
      launchKind: '',
      startMutationId: '',
      attachmentPaths: [],
      launchError: '',
    })
  }

  const selectMachine = (machineId: string): void => {
    setError(null)
    setDraft(withoutCreateReservation({ ...draft, machineId }))
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
    // LAUNCHING WITH NOTHING WRITTEN ASKS FOR THE CLI, so the panel opens on it
    // (POD-1669). Nothing else about this session says so: `effectivePanelMode`
    // would hand it whatever the operator's `startScreen`/per-device default
    // says, and on a chat-first setup that is a conversation view over a harness
    // the operator asked to see raw. Written BEFORE the pane is pointed at it,
    // which is the order that matters: `usePanelSurface` materializes its
    // derived fallback only while the per-session mode is still undefined, so a
    // value already sitting here is left alone rather than raced.
    //
    // Per-session only. `pickMode` is what writes the per-DEVICE default, and
    // this is not the operator picking a surface for every session to come.
    setPanelMode(sessionId, 'native')
    setPane('A', sessionId)
    setView('workspace')
  }

  const start = (): void => {
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
      const readyAttachments = attachments.ready()
      const attachmentPaths =
        draft.attachmentPaths.length > 0 ? draft.attachmentPaths : readyAttachments.paths
      const draftArtifacts = readyAttachments.draftArtifacts
      const brief = attachmentBrief(attachmentPaths)
      // Drafts left by the old two-mutation path may already have a durable issue.
      // Finish those in place; every new launch uses the single optimistic path.
      if (draft.pendingIssueId) {
        const pendingIssueId = draft.pendingIssueId
        const startMutationId = draft.startMutationId || asMutationId(randomUUID())
        setDraft({ ...draft, startMutationId, launchError: '' })
        void trpc.issues.start
          .mutate({ id: pendingIssueId, mutationId: startMutationId })
          .then(async () => {
            clearFirstTaskDraft(uiState)
            attachments.clear()
            const opened = await focusIssueSession(pendingIssueId)
            if (opened) setPanelMode(opened, 'chat')
          })
          .catch((cause) => {
            const launchError = cause instanceof Error ? cause.message : String(cause)
            setDraft({ ...draft, startMutationId, launchError })
            setBusy(false)
          })
        return
      }

      // A pre-POD-1838 checkpoint may already name a real issue mutation. Finish
      // that exact launch instead of changing its meaning during a retry.
      const legacyIssueId = draft.createIssueId || undefined
      const legacySessionId = draft.createSessionId || undefined
      const legacyMutationId = draft.createMutationId || undefined
      if (
        draft.launchKind !== 'draft' &&
        legacyIssueId !== undefined &&
        legacySessionId !== undefined &&
        legacyMutationId !== undefined
      ) {
        const launchDraft: FirstTaskDraft = {
          ...draft,
          launchKind: 'issue',
          title: prompt,
          attachmentPaths: [...attachmentPaths],
          launchError: '',
        }
        setDraft(launchDraft)
        const started = spawnIssueAgent({
          issueId: legacyIssueId,
          sessionId: legacySessionId,
          mutationId: legacyMutationId,
          target: {
            path: selectedCheckout.path,
            repoPath: selectedCheckout.path,
            machineId: asMachineId(selectedMachine.id),
            ...(selectedRepo.repoId !== undefined ? { repoId: selectedRepo.repoId } : {}),
          },
          title: promptTitle(prompt),
          description: prompt,
          ...(brief ? { brief } : {}),
          ...(selectedCheckout.branch?.trim()
            ? { parentBranch: selectedCheckout.branch.trim() }
            : {}),
          agentKind: agent,
          ...(draft.model !== AUTO ? { model: draft.model } : {}),
          ...(draft.effort !== AUTO ? { effort: draft.effort } : {}),
        })
        attachments.clear()
        void started.outcome.then((outcome) => {
          if (outcome === 'started') {
            clearFirstTaskDraft(uiState)
            return
          }
          if (outcome === 'issue-only') {
            setDraft({
              ...launchDraft,
              pendingIssueId: started.issueId,
              createIssueId: '',
              createSessionId: '',
              createMutationId: '',
              launchError: "The task was saved, but its agent couldn't start.",
            })
          } else {
            setDraft({ ...launchDraft, launchError: "Couldn't start the task." })
          }
          setBusy(false)
        })
        setSelectedIssueId(started.issueId)
        setSelectedWorktree(selectedCheckout.path)
        setPanelMode(started.sessionId, 'chat')
        setPane('A', started.sessionId)
        setView('workspace')
        return
      }

      const retryCreate =
        draft.launchKind === 'draft' &&
        draft.createIssueId &&
        draft.createSessionId &&
        draft.createMutationId
          ? {
              issueId: draft.createIssueId,
              sessionId: draft.createSessionId,
              mutationId: draft.createMutationId,
            }
          : {
              issueId: asIssueId(`iss_${randomUUID()}`),
              sessionId: asSessionId(randomUUID()),
              mutationId: asMutationId(randomUUID()),
            }
      const launchDraft: FirstTaskDraft = {
        ...draft,
        launchKind: 'draft',
        title: prompt,
        pendingIssueId: '',
        createIssueId: retryCreate.issueId,
        createSessionId: retryCreate.sessionId,
        createMutationId: retryCreate.mutationId,
        startMutationId: '',
        attachmentPaths: [...attachmentPaths],
        launchError: '',
      }
      // Persist BEFORE dispatch. If this tab dies after the authority accepts
      // the mutation, the next Launch reuses these exact identities instead of
      // minting a second draft session around a response it never saw.
      setDraft(launchDraft)
      const started = spawnDraftAgent({
        ...retryCreate,
        ...(draftArtifacts.length ? { draftArtifacts } : {}),
        target: {
          path: selectedCheckout.path,
          repoPath: selectedCheckout.path,
          machineId: asMachineId(selectedMachine.id),
          ...(selectedRepo.repoId !== undefined ? { repoId: selectedRepo.repoId } : {}),
        },
        firstPrompt: [prompt, brief].filter(Boolean).join('\n\n'),
        agentKind: agent,
        ...(draft.model !== AUTO ? { model: draft.model } : {}),
        ...(draft.effort !== AUTO ? { effort: draft.effort } : {}),
      })
      // Keep prompt, attachments and ids until the authority has accepted the
      // draft vessel and its first session. The mutation and client-minted ids
      // make an ambiguous retry duplicate-safe.
      void started.settled.then((settled) => {
        if (settled) {
          attachments.clear()
          clearFirstTaskDraft(uiState)
          return
        }
        setDraft({ ...launchDraft, launchError: "Couldn't start the agent." })
        setBusy(false)
      })
      setSelectedIssueId(started.issueId)
      setSelectedWorktree(selectedCheckout.path)
      setPanelMode(started.sessionId, 'chat')
      setPane('A', started.sessionId)
      setView('workspace')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
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

  /** What Launch and ⌘↵ do, which is the one thing the two modes disagree about. */
  const launch = (): void => {
    if (launchBlocked) return
    // Starting work on a harness is what makes it the operator's harness — see
    // `persistDefaultAgent`. Once, for both modes, and only when the pick is
    // actually news: relaunching on the harness that is already the default has
    // nothing to write.
    if (agent !== defaultAgent) void persistDefaultAgent(agent)
    if (expanded) void start()
    else startCli()
  }

  /**
   * THE WHOLE EMPTY DECK TAKES A DROP (POD-1669).
   *
   * The well was the only thing listening, and on this screen the well is a
   * 46px line floating in the middle of a pane that is mostly air — so a file
   * dragged at "the box I am about to write in" landed on the DOCUMENT nine
   * times out of ten, and the browser's own default for that is to NAVIGATE to
   * the file: the shell, the draft and the launch in progress all replaced by a
   * PDF in a tab. The gesture was not merely ignored, it was destructive.
   *
   * So the pane is the target. The strip and the well still hold the result —
   * an attachment unfolds the box by the same rule a written prompt does.
   *
   * A LAUNCH IN FLIGHT REFUSES THE FILES BUT STILL SWALLOWS THE DROP. `busy` is
   * a mission already being created and `pendingIssueId` one already created and
   * waiting to be retried; neither can be given another attachment, since the
   * brief that names them is written once. Letting the event fall through to the
   * browser instead would answer "you cannot attach that right now" by throwing
   * the operator off the page mid-launch, so the default is cancelled either way
   * — the same reason the paperclip is disabled rather than absent.
   */
  const attaching = !busy && !draft.pendingIssueId && !draft.createIssueId
  const dragging = attaching && attachments.dragOver
  const paneDrop = {
    onDragOver: (event: React.DragEvent): void => {
      event.preventDefault()
      if (attaching) attachments.dropHandlers.onDragOver(event)
    },
    onDragLeave: attachments.dropHandlers.onDragLeave,
    onDrop: (event: React.DragEvent): void => {
      event.preventDefault()
      if (attaching) attachments.dropHandlers.onDrop(event)
    },
  }

  return (
    <div
      data-testid="cold-start-deck"
      className="cold-start relative flex min-h-0 flex-1 flex-col bg-card font-sans"
      {...paneDrop}
    >
      {/* THE SCROLLER IS NOT THE DROP TARGET'S BOX (POD-1669). An absolutely
          positioned veil inside an `overflow-y-auto` element is laid out against
          the SCROLLED content, so on the short panes where this deck actually
          overflows the "drop here" frame would sit above the visible area and
          scroll with it. Splitting the two puts the veil over the pane and
          leaves the scrolling exactly where it was. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
                  {/* NO MARK (POD-1469). The pill carried a 7px Claude-clay square:
                      the harness's brand colour, on the control that names the
                      PROJECT. It said nothing true about the repo — every project
                      wore the same dot whatever was going to run in it — and beside
                      the agent chip's identical dot it read as a shared bullet
                      rather than as anything meaningful. The word is the pill. */}
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

          {/* The drop target is the PANE now, not this box (POD-1669) — see
              `paneDrop`. What stays here is the chord and the paste. */}
          <div
            ref={setRootEl}
            data-testid="cold-start-field"
            data-expanded={expanded ? 'true' : 'false'}
            className="cold-start-field relative overflow-hidden rounded-[14px] bg-bar shadow-[inset_0_0_0_1px_var(--border-strong),0_20px_50px_-30px_var(--carve-drop)]"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                launch()
              }
            }}
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
              onChange={(event) =>
                setDraft(withoutCreateReservation({ ...draft, title: event.currentTarget.value }))
              }
              onFocus={() => {
                setFocused(true)
                setUnfolded(true)
              }}
              onBlur={() => setFocused(false)}
              onKeyDown={(event) => {
                // Escape closes an EMPTY box and nothing else. Two keystrokes from
                // discarding written work is not a shortcut, it is a trap — the X
                // is the way out of one of those, deliberately deliberate. An
                // ATTACHED FILE counts as written work: the file was chosen through
                // a picker or a drop, and the key most likely to be pressed after
                // either of those is the one dismissing whatever it left behind.
                const empty =
                  draft.title.trim().length === 0 && attachments.attachments.length === 0
                if (event.key === 'Escape' && empty) {
                  event.stopPropagation()
                  collapse()
                }
              }}
              onPaste={attachments.onPaste}
              placeholder={
                expanded
                  ? 'Describe the mission — an outcome, a bug, a question about the codebase…'
                  : 'Click here to enter a prompt'
              }
              className="cold-start-input block w-full resize-none bg-transparent px-[22px] text-[14.5px] leading-[1.6] text-text-strong outline-none placeholder:text-text-faint disabled:opacity-60"
            />
            {/* Shown only while the box is closed and unfocused — the expanded
                well already gives its right shoulder to the close control, and
                a chord hint under the operator's own words is a puzzle. */}
            {!expanded && (
              <span
                className="composer-chord"
                data-show={!focused ? 'true' : undefined}
                data-testid="composer-chord"
                aria-hidden="true"
              >
                {chordLabel()} to focus
              </span>
            )}
            {/* THE WAY BACK OUT, and it is only offered where there is something to
                go back to. It clears rather than hides: a collapsed box showing
                `Click here to enter a prompt` while still holding a paragraph
                would launch a mission the operator believes they cancelled. */}
            {expanded && !draft.pendingIssueId && (
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
                <CapabilityAgentMenu
                  trigger={
                    <button
                      type="button"
                      data-pressable
                      aria-label="Agent"
                      className="inline-flex h-7 items-center gap-1.5 px-2.5 text-[11px] leading-none font-semibold text-text-strong hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {/* THE HARNESS'S OWN MARK, ALWAYS (POD-1469). This was a
                          7px square in Claude clay — hue and nothing else, and the
                          SAME hue whichever harness was selected, so picking Codex
                          left an orange dot in front of the word `Codex`. The menu
                          this chip opens draws every harness's real glyph; the
                          chip now draws the selected one, at the menu's own 13px
                          column, and the swatch's job is done properly. */}
                      {issueAgentIcon(agent, 13)}
                      {issueAgentLabel(agent)}
                      <ChevronDown size={13} className="text-text-faint" aria-hidden="true" />
                    </button>
                  }
                  options={agentOptions}
                  selectedValue={agent}
                  onSelect={(nextAgent) => {
                    const kind = issueAgentKind(nextAgent) ?? agent
                    setDraft(
                      withoutCreateReservation({
                        ...draft,
                        agent: kind,
                        model: AUTO,
                        effort: AUTO,
                      }),
                    )
                  }}
                />
                <span className="w-px bg-hairline-bar" aria-hidden="true" />
                <ModelPicker
                  variant="composer"
                  agentKind={agent}
                  machineId={selectedMachine?.id}
                  value={draft.model}
                  onChange={(model) =>
                    setDraft(withoutCreateReservation({ ...draft, model, effort: AUTO }))
                  }
                />
                <span className="w-px bg-hairline-bar" aria-hidden="true" />
                <EffortPicker
                  variant="composer"
                  agentKind={agent}
                  machineId={selectedMachine?.id}
                  model={draft.model}
                  value={draft.effort}
                  onChange={(effort) => setDraft(withoutCreateReservation({ ...draft, effort }))}
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
                    !authorized.has(machine.id)
                      ? ' (no access)'
                      : machine.online
                        ? ''
                        : ' (offline)'
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
                disabled={busy || Boolean(draft.pendingIssueId) || Boolean(draft.createIssueId)}
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
                        className="font-mono text-[12.5px] leading-none text-primary-foreground/60"
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
                  <LoaderCircle
                    size={15}
                    className="animate-spin text-primary"
                    aria-hidden="true"
                  />
                  Starting your mission…
                </div>
              </div>
            )}
          </div>

          {/* THREE DEAD ENDS, THREE ANSWERS (POD-1469, POD-1582).
              UNAUTHORIZED IS NOT UNREADY, and it is stated first: no amount of
              agent setup makes a host you have no grant on runnable, so the note
              that sends the operator to Settings would be a wrong instruction.
              NEITHER IS A MISSING CHECKOUT. `activationAgentReadiness` reports
              `unavailable` both when the harness is not set up and when there is
              no checkout to run it in, and one message for both sent the second
              case to Settings → Agents — where nothing on the page changes the
              outcome, with Launch dead and no way to tell why. The machine
              picker is the control that fixes that one, so name it. */}
          {machineDenied ? (
            <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
              You do not have access to run work on this machine. Ask its owner for access, or pick
              another machine.
            </p>
          ) : (
            !ready &&
            (selectedCheckout ? (
              <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
                The selected agent is not ready on this machine yet. Open Settings → Agents to
                finish setup.
              </p>
            ) : (
              <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
                {selectedRepo ? repoLabel(selectedRepo) : 'This project'} is not checked out on{' '}
                {selectedMachine?.name ?? 'this machine'}. Pick another machine, or clone it there
                first.
              </p>
            ))
          )}
          {draft.pendingIssueId && !error && (
            <p className="mt-3 font-mono text-[10.5px] leading-5 text-text-faint">
              The task is saved. Podium is retrying the same task, so it cannot create a duplicate.
            </p>
          )}
          {error && (
            <div className="mt-3">
              <SetupError>{error} Your request and selections are still saved.</SetupError>
            </div>
          )}
        </div>
      </div>
      {/* One frame over the WHOLE deck, because that is what now accepts the
          drop. It is drawn here rather than inside the well so the answer to
          "will this land?" covers the same area as the question. */}
      {dragging && (
        <div className="pointer-events-none absolute inset-2.5 z-20 flex items-center justify-center rounded-[18px] border-2 border-dashed border-primary bg-primary/[0.07]">
          {/* THE LABEL IS A CHIP, NOT LOOSE INK. Centred in the pane it lands on
              the centred well, and bare text over the placeholder read as a
              collision. It is the busy overlay's own chip — bar tone, inset rim,
              the popover carve — so the two things this deck can say over itself
              say them the same way, and neither depends on a scrim: a veil that
              dims the deck to answer a hover is a heavier promise than "this
              will land here", and on paper it bleached the whole screen. */}
          <span className="inline-flex items-center gap-2.5 rounded-lg bg-bar px-4 py-3 text-[12.5px] font-semibold text-text-strong shadow-[inset_0_0_0_1px_var(--border-strong),0_12px_30px_var(--carve-popover-near)]">
            <Paperclip size={14} className="text-primary" aria-hidden="true" />
            Drop files to attach
          </span>
        </div>
      )}
    </div>
  )
}
