import {
  AUTO,
  draftForLaunchContext,
  draftForReportedModels,
  type LaunchPickContext,
  readLastLaunchPicks,
  rememberLaunchPick,
} from '@podium/client-core/agent-models'
import { randomUUID } from '@podium/client-core/id'
import {
  FIRST_TASK_ACTIVATION_DRAFT_KEY,
  LAST_LAUNCH_PICK_KEY,
  SUPERAGENT_MODE_KEY,
} from '@podium/client-core/ui-state'
import {
  AGENT_NOT_READY_COPY,
  activationAgentReadiness,
  agentCanLaunch,
  indexedRepoUsageAt,
  launchAgentKind,
  machineViewsFromWire,
  type RepoView,
  reposToViews,
  signInInTerminalCopy,
  usableMachines,
} from '@podium/client-core/values'
import { asIssueId, asMutationId, asSessionId, type GitRepositoryWire } from '@podium/model'
import {
  agentLoginCondition,
  asMachineId,
  DEFAULT_HARNESS_AGENT,
  machinePathBasename,
  machinePathKey,
  preferredMachineChoices,
} from '@podium/model/browser'
import { nativeAccountId } from '@podium/runtime'
import { ChevronDown, Folder, LoaderCircle, Monitor, Paperclip } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AttachmentStrip } from '@/features/chat/AttachmentStrip'
import { useAttachments } from '@/features/chat/use-attachments'
import { useComposerChord } from '@/features/chat/use-composer-chord'
import {
  useSettingsPersistedUiState as usePersistedUiState,
  useSettingsCatalog,
  useSettingsDraftSeed,
  useSettingsSetupSummary,
} from '@/features/settings/readers'
import { useSettingsClient } from '@/features/settings/stable-access'
import { useTipMoment } from '@/features/tips'
import { noteFirstSend } from '@/features/worklist/first-send-tip'
import {
  agentFleetStatus,
  CapabilityAgentMenu,
  candidateFromAvailability,
} from '@/lib/agent-capability'
import {
  ISSUE_AGENT_KINDS,
  type IssueAgentKind,
  issueAgentIcon,
  issueAgentKind,
  issueAgentLabel,
} from '@/lib/issue-agents'
import { EffortPicker, ModelPicker } from '@/lib/ModelEffortPicker'
import { modChord } from '@/lib/mod-chord'
import { useMyCodingHarness } from '@/lib/my-preferences'
import { PropertyMenu } from '@/lib/PropertyMenu'
import {
  headlessRuntimeDrivers,
  runtimeDriverLabel,
  terminalRuntimeDriver,
} from '@/lib/runtime-driver-options'
import { useFeature } from '@/lib/use-feature'
import { useModelCatalog } from '@/lib/use-model-catalog'
import { useNativeDraftText } from '@/lib/use-native-draft-text'
import { cn } from '@/lib/utils'
import { useColdStartPromptAutoGrow } from './cold-start-prompt-height'
import { FIRST_PROMPT_ANCHOR, FirstPromptGhost, firstPromptCards } from './FirstPromptTip'
import {
  clearFirstTaskDraft,
  type FirstTaskDraft,
  readFirstTaskDraft,
  serializeFirstTaskDraft,
} from './first-task-draft'
import { SetupError } from './SetupFeedback'

function repoLabel(repo: { path: string; name?: string }): string {
  return repo.name ?? (machinePathBasename(repo.path) || repo.path)
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

/** The single first-task picker owns the order for each menu opening. */
export function useFirstTaskRepositoryPicker(
  repos: GitRepositoryWire[],
  repositoryUsage: ReadonlyMap<string, number>,
) {
  // Stored on picker open: identities and recency stay still; metadata stays live.
  const [repoOrder, setRepoOrder] = useState<readonly string[] | null>(null)
  const repoIdentity = (repo: RepoView) =>
    repo.repoId ??
    (repo.originUrl ||
      JSON.stringify([repo.machines?.[0]?.machineId ?? '', machinePathKey(repo.path)]))
  const liveRepoChoices = useMemo(
    () =>
      reposToViews(repos).filter(
        (view) => checkoutForMachine(repos, view, undefined) !== undefined,
      ),
    [repos],
  )
  const rankedRepoChoices = () => {
    const usage = new Map<string, number>()
    for (const repo of repos) usage.set(repo.path, indexedRepoUsageAt(repo, repositoryUsage))
    const usageFor = (view: RepoView): number =>
      Math.max(
        usage.get(view.path) ?? 0,
        ...(view.machines ?? []).map(({ path }) => usage.get(path) ?? 0),
      )
    return [...liveRepoChoices].sort(
      (a, b) =>
        usageFor(b) - usageFor(a) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }
  const rankingUsage = repoOrder === null ? repositoryUsage : undefined
  const repoChoices = useMemo(() => {
    if (repoOrder === null) return rankedRepoChoices()
    const positions = new Map(repoOrder.map((id, position) => [id, position]))
    const choices = new Array<RepoView | undefined>(repoOrder.length)
    for (const repo of liveRepoChoices) {
      const position = positions.get(repoIdentity(repo))
      if (position !== undefined) choices[position] = repo
    }
    return choices.filter((repo): repo is RepoView => repo !== undefined)
  }, [repoOrder, liveRepoChoices, rankingUsage])
  const onOpenChange = (open: boolean) =>
    setRepoOrder(open ? rankedRepoChoices().map(repoIdentity) : null)
  return { repoChoices, onOpenChange }
}

/** Optional instructions for coordinating a complex epic. */
export const COORDINATOR_PROMPT =
  'This is a complex epic. You are the designated coordinator. Organize your work accordingly. Check with me on key decisions.'

/** Words, as a person counts them: runs of non-space. */
export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export function ColdStartComposer({
  first,
  autoFocus = false,
  onLaunched,
}: {
  first: boolean
  /** Take focus on mount — the New task overlay opens ready to type. */
  autoFocus?: boolean
  /** A launch went out; the overlay that hosts this box gets out of the way. */
  onLaunched?: () => void
}): JSX.Element {
  const {
    trpc,
    uiState,
    focusIssueSession,
    spawnDraftAgent,
    spawnIssueAgent,
    startIssueSession,
    setSelectedIssueId,
    setSelectedWorktree,
    setPane,
    setPanelMode,
    setView,
    setOpenIssueId,
    setPreferences,
  } = useSettingsClient()
  const { repos, machines } = useSettingsCatalog()
  const { usage: repositoryUsage, defaultAgent: recentAgent } = useSettingsSetupSummary(repos)
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
   * The pool maintains agent usage maxima by path as session keys change.
   * This picker asks only for its displayed repository/worktree roots.
   */
  const { repoChoices, onOpenChange: onRepositoryPickerOpen } = useFirstTaskRepositoryPicker(
    repos,
    repositoryUsage,
  )
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
  const [lastLaunchPicks] = usePersistedUiState(
    LAST_LAUNCH_PICK_KEY,
    readLastLaunchPicks,
    JSON.stringify,
  )
  const { loading: draftLoading } = useSettingsDraftSeed(
    FIRST_TASK_ACTIVATION_DRAFT_KEY,
    readFirstTaskDraft,
  )
  const previousLaunchContext = useRef<LaunchPickContext | undefined>(undefined)
  /**
   * The operator's harness, as `roles.coding` answers it — the same read the
   * deleted sidebar chip made, and held as a raw string for the same reason it
   * was there (POD-1469). It is written back from the agent menu below, which is
   * what makes "the last one you used" a fact rather than a hope.
   */
  // My coding default is a synced setting of mine (POD-6673); a pick made here
  // shows at once, ahead of the record's own paint.
  const syncedAgentSetting = useMyCodingHarness()
  const [pickedAgentSetting, setAgentSetting] = useState<string | undefined>(undefined)
  const agentSetting = pickedAgentSetting ?? syncedAgentSetting
  const [busy, setBusy] = useState(false)
  const runtimeDriversEnabled = useFeature('runtime-drivers')
  const HEADED_DRIVER = 'headed'
  const [driverChoice, setDriverChoice] = useState(HEADED_DRIVER)
  // Durable launch failures belong to the draft, not component lifetime. The
  // recovery composer can mount one microtask before the outcome writes its
  // error; reading the subscribed draft lets that late value appear. Local
  // state is reserved for synchronous faults that never reached persistence.
  const [transientError, setError] = useState<string | null>(null)
  const error = draft.launchError || transientError

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
  const preferredMachines = preferredMachineChoices(machines)
  const targetMachines =
    repoMachineIds.size > 0
      ? preferredMachines.filter((machine) => repoMachineIds.has(machine.id))
      : preferredMachines
  // AN UNAUTHORIZED HOST IS LISTED, NEVER DEFAULTED. Removing it would collapse
  // "ask its owner" into "that machine does not exist", which is the reading M5
  // spends its whole argument keeping apart — and the operator would have no way
  // to find out why the host they can see is not on offer. So the row stays,
  // says `no access`, and only the DEFAULT skips over it.
  //
  // A REMEMBERED HOST IS NOT A PICK (POD-4630). The effect below writes every
  // resolution back into the draft, so `draft.machineId` is usually yesterday's
  // default, and it outlives that machine going offline. It wins only while it
  // is usable, or when nothing on the list is; a pick made in THIS box wins
  // outright, offline or not, so the picker never undoes the operator's click.
  const [pickedMachineId, setPickedMachineId] = useState<string>()
  const selectedMachine =
    targetMachines.find((machine) => machine.id === pickedMachineId) ??
    targetMachines.find((machine) => machine.id === draft.machineId && usable.has(machine.id)) ??
    targetMachines.find((machine) => usable.has(machine.id)) ??
    targetMachines.find((machine) => machine.id === draft.machineId) ??
    targetMachines.find((machine) => authorized.has(machine.id)) ??
    targetMachines[0]
  const selectedCheckout = selectedRepo
    ? checkoutForMachine(repos, selectedRepo, selectedMachine?.id, draft.repoPath)
    : undefined
  /** A host the operator may see but not run on. Everything that starts work
   *  refuses on it; the picker still shows it, saying why. */
  const machineDenied = selectedMachine !== undefined && !authorized.has(selectedMachine.id)
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
   * answer for the inputs that can still arrive unresolved: no setting yet (my
   * synced `userPreferences` record not yet in the pool, POD-6673), or `auto`.
   *
   * Then availability, and only then: a default that cannot start on the chosen
   * machine is not a default, so it steps aside for the first harness that can.
   * A pick made in THIS box outranks both — it is the most recent thing the
   * operator said about this specific task.
   */
  const defaultAgent =
    issueAgentKind(agentSetting && agentSetting !== 'auto' ? agentSetting : recentAgent) ??
    DEFAULT_HARNESS_AGENT

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
      await setPreferences({ 'roles.coding.accountId': nativeAccountId(kind) })
    } catch {
      // Kept optimistic — see above.
    }
  }
  const agent = launchAgentKind({
    picked: issueAgentKind(draft.agent),
    preferred: defaultAgent,
    candidates: ISSUE_AGENT_KINDS,
    readiness: (candidate) =>
      activationAgentReadiness(
        selectedCheckout,
        selectedMachine ? [selectedMachine] : machines,
        candidate,
      ),
  })
  const readiness = activationAgentReadiness(
    selectedCheckout,
    selectedMachine ? [selectedMachine] : machines,
    agent,
  )
  // What the selected machine reported for this harness; `undefined` until the
  // list arrives, or if it never does. See `draftForReportedModels`.
  const reportedModels = useModelCatalog(selectedMachine?.id)[agent]
  /**
   * SIGNED OUT IS NOT A DEAD END FOR A HEADED LAUNCH (POD-3911).
   *
   * A headed session runs the harness in its own terminal, and that terminal is
   * where the operator signs in — until Podium manages logins, the only place
   * they can. Refusing the launch left them with no way forward from here. A
   * headless driver has no screen to sign in on, so it stays refused; the
   * headless driver list already drops signed-out drivers.
   */
  const headedLaunch = !runtimeDriversEnabled || driverChoice === HEADED_DRIVER
  const ready = agentCanLaunch(readiness, { headed: headedLaunch })
  const signInFirst = ready && readiness.state === 'logged-out'
  const availableHeadedDriver = runtimeDriversEnabled
    ? terminalRuntimeDriver(selectedMachine, agent)
    : undefined
  const availableHeadlessDrivers = headlessRuntimeDrivers(selectedMachine, agent).filter(
    (driver) =>
      selectedMachine !== undefined &&
      agentLoginCondition(selectedMachine, driver.harness) !== 'logged-out',
  )
  const selectedHeadlessDriver =
    runtimeDriversEnabled && driverChoice !== HEADED_DRIVER
      ? availableHeadlessDrivers.find((driver) => driver.id === driverChoice)
      : undefined
  const driverUnavailable =
    runtimeDriversEnabled && driverChoice !== HEADED_DRIVER && selectedHeadlessDriver === undefined
  // An explicit headless pick rides `requestedDriverId`; the headed choice
  // sends NOTHING — omission already means the manifest's terminal driver,
  // which the daemon binds unconditionally (the NewPanelMenu sibling got
  // this right). The deleted wire field must stay deleted: a spread of a
  // conditional object is not excess-property-checked, so a wrong name here
  // compiles while `createDraftAgent` silently drops it.
  const requestedDriverId =
    runtimeDriversEnabled && driverChoice !== HEADED_DRIVER ? selectedHeadlessDriver?.id : undefined
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

  /** The home composer has no issue yet. Picked files are held on the server
   *  (POD-2148); `sessions.create` claims them into the new draft, and its
   *  first prompt hands them to the agent like any chat message. */
  const [uploadScope] = useState(() => asSessionId(`coldstart-${randomUUID()}`))
  const attachments = useAttachments({
    sessionId: uploadScope,
    trpc,
    destination: 'issue',
  })

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initialPrompt = useNativeDraftText(inputRef, draft.title)
  const [rootEl, setRootEl] = useState<HTMLFieldSetElement | null>(null)
  useColdStartPromptAutoGrow({ taRef: inputRef, value: draft.title })
  // Mount-only: the overlay opens ready to type, and the caret lands after any
  // prompt the draft brought back.
  useEffect(() => {
    if (!autoFocus) return
    const field = inputRef.current
    if (!field) return
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [autoFocus])
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
  /** First Flights moment 1 (POD-2196). The ghost demo never touches the draft. */
  const [ghost, setGhost] = useState(false)
  const [tipShowing, setTipShowing] = useState(false)
  useTipMoment('first-prompt', {
    active: first,
    cards: firstPromptCards({ setGhost, setShowing: setTipShowing, focusComposer: focusField }),
  })
  useEffect(() => {
    const globals = globalThis as { __PODIUM_FOCUS_SESSION_PROMPT__?: () => void }
    globals.__PODIUM_FOCUS_SESSION_PROMPT__ = focusField
    return () => {
      if (globals.__PODIUM_FOCUS_SESSION_PROMPT__ === focusField) {
        delete globals.__PODIUM_FOCUS_SESSION_PROMPT__
      }
    }
  }, [focusField])
  /**
   * A DIFFERENT PATH FOR THE SAME PROJECT IS NOT A DIFFERENT PROJECT (POD-1582).
   *
   * `selectedRepo` deliberately matches a draft whose `repoPath` is one of the
   * entry's machine-specific paths rather than the group's canonical one — that
   * is how a draft written on one machine still finds its project. Comparing
   * against `selectedRepo.path` alone then read that alias as a repo SWITCH, so
   * the first render after such a draft loaded rewrote it with `model: AUTO,
   * effort: AUTO` and the operator's choices were gone before they touched
   * anything.
   *
   * A repo switch on the same machine keeps the pills. A different machine or
   * harness restores its last launched pair, then validates its reported list.
   * On open, a saved draft's own pick wins (including explicitly picked Auto).
   *
   * The alias is also kept rather than canonicalised, because it is the only
   * record of WHICH checkout the operator meant when one origin has two on a
   * machine — `checkoutForMachine` reads it back as `prefer`.
   */
  useEffect(() => {
    if (!selectedRepo || draftLoading) return
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
    let next = {
      ...draft,
      repoPath: repoChanged ? selectedRepo.path : draft.repoPath,
      machineId: selectedMachine?.id ?? '',
      ...(agentChanged ? { agent } : {}),
    }
    // Wait for the default harness before restoring a pair. A launch that owns
    // the draft keeps its reserved request unchanged for retries.
    if (
      !busy &&
      !draft.pendingIssueId &&
      !draft.createIssueId &&
      selectedMachine &&
      (draft.agent || agentSetting !== undefined)
    ) {
      const context = { machineId: selectedMachine.id, harness: agent }
      next = draftForLaunchContext(next, previousLaunchContext.current, context, lastLaunchPicks)
      previousLaunchContext.current = context
      next = draftForReportedModels(next, reportedModels) ?? next
    }
    if (
      repoChanged ||
      machineChanged ||
      agentChanged ||
      next.model !== draft.model ||
      next.effort !== draft.effort ||
      next.launchPickTouched !== draft.launchPickTouched
    )
      setDraft(next)
  }, [
    agent,
    agentSetting,
    busy,
    draft,
    draftLoading,
    lastLaunchPicks,
    reportedModels,
    selectedMachine,
    selectedRepo,
    setDraft,
  ])

  const selectRepo = (repoPath: string): void => {
    const repo = repoChoices.find((candidate) => candidate.path === repoPath)
    const repoMachines = new Set(repo?.machines?.map(({ machineId }) => machineId) ?? [])
    const candidates =
      repoMachines.size > 0
        ? preferredMachineChoices(machines).filter((candidate) => repoMachines.has(candidate.id))
        : preferredMachineChoices(machines)
    const machine =
      candidates.find((candidate) => usable.has(candidate.id)) ??
      candidates.find((candidate) => authorized.has(candidate.id)) ??
      candidates[0]
    setError(null)
    setPickedMachineId(undefined)
    setDraft({
      ...draft,
      repoPath,
      machineId: machine?.id ?? '',
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
    setPickedMachineId(machineId)
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
      ...(requestedDriverId !== undefined ? { requestedDriverId } : {}),
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
      const uploaded = readyAttachments.refs
      const brief = attachmentBrief(attachmentPaths)
      // Drafts left by the old two-mutation path may already have a durable issue.
      // Finish those in place; every new launch uses the single optimistic path.
      if (draft.pendingIssueId) {
        const pendingIssueId = draft.pendingIssueId
        const startMutationId = draft.startMutationId || asMutationId(randomUUID())
        setDraft({ ...draft, startMutationId, launchError: '' })
        // An `issue.begin` record under the draft's mutation id (POD-6526): a
        // retry writes the same record. Queued is launched; a later failure is
        // told once, from the record.
        void startIssueSession({
          issueId: asIssueId(pendingIssueId),
          mode: 'begin',
          mutationId: startMutationId,
        })
          .settled.then(async (queued) => {
            if (!queued) throw new Error("Couldn't start the task")
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
          // Not queued at all (a start that fails later shows on its task).
          setDraft({ ...launchDraft, launchError: "Couldn't start the task." })
          setBusy(false)
        })
        if (first) noteFirstSend(uiState, started.issueId)
        setSelectedIssueId(started.issueId)
        setSelectedWorktree(selectedCheckout.path)
        setPanelMode(started.sessionId, 'chat')
        setPane('A', started.sessionId)
        setView('workspace')
        // Filed as a proposal: no agent comes, so show the task rather than
        // the pane of a session that will never exist.
        void started.proposed.then((proposed) => {
          if (!proposed) return
          setPane('A', null)
          setOpenIssueId(started.issueId)
          setView('issues')
        })
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
        ...(uploaded.length ? { attachments: uploaded } : {}),
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
        ...(requestedDriverId !== undefined ? { requestedDriverId } : {}),
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
      // First Flights: the task this first launch opens gets the list tip.
      if (first) noteFirstSend(uiState, started.issueId)
      setSelectedIssueId(started.issueId)
      setSelectedWorktree(selectedCheckout.path)
      // A signed-out harness opens on its terminal: the sign-in screen is the
      // first thing it shows, and the chat view has nothing to show until then.
      setPanelMode(started.sessionId, signInFirst ? 'native' : 'chat')
      setPane('A', started.sessionId)
      setView('workspace')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const hasPrompt = draft.title.trim().length > 0
  const launchBlocked =
    busy ||
    draftLoading ||
    // A launch that outran its uploads would create the mission with a brief
    // naming files that are still in flight.
    attachments.uploading ||
    !selectedRepo ||
    !selectedCheckout ||
    !selectedMachine ||
    machineDenied ||
    !ready ||
    driverUnavailable ||
    // The promptless path has no way to deliver uploaded files to the agent.
    (!draft.pendingIssueId && !hasPrompt && attachments.attachments.length > 0)

  /** What Start task and ⌘↵ do. Text starts the agent on that prompt in a draft
   *  issue (or resumes a mission a previous launch already created); no text
   *  starts a bare session. */
  const launch = (): void => {
    if (launchBlocked) return
    // Starting work on a harness is what makes it the operator's harness — see
    // `persistDefaultAgent`. Once, for both modes, and only when the pick is
    // actually news: relaunching on the harness that is already the default has
    // nothing to write.
    if (agent !== defaultAgent) void persistDefaultAgent(agent)
    rememberLaunchPick(uiState, { machineId: selectedMachine!.id, harness: agent }, draft)
    // The new task gets the room, as it did when New task folded the deck.
    uiState.set(SUPERAGENT_MODE_KEY, 'folded')
    if (draft.pendingIssueId || hasPrompt) void start()
    else startCli()
    onLaunched?.()
  }

  /** The coordinator prompt is one link away rather than on screen (POD-2079):
   *  most tasks are not epics, and the tip used to sit under every one of them. */
  const insertCoordinatorPrompt = (): void => {
    const current = draft.title.trimEnd()
    setDraft(
      withoutCreateReservation({
        ...draft,
        title: current ? `${current}\n\n${COORDINATOR_PROMPT}` : COORDINATOR_PROMPT,
      }),
    )
    requestAnimationFrame(() => {
      const field = inputRef.current
      if (!field) return
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
      field.scrollTop = field.scrollHeight
    })
  }
  const words = countWords(draft.title)

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

  /** The chip text inside the box: muted ink for the parts that only describe. */
  const chip =
    'inline-flex h-7 max-w-full flex-none items-center gap-1.5 rounded-[7px] px-2 text-[12px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring'

  return (
    <div
      data-testid="cold-start-deck"
      className="cold-start relative flex min-h-0 flex-1 flex-col font-sans"
      {...paneDrop}
    >
      {/* THE SCROLLER IS NOT THE DROP TARGET'S BOX (POD-1669). An absolutely
          positioned veil inside an `overflow-y-auto` element is laid out against
          the SCROLLED content, so the "drop here" frame would scroll with it.
          Splitting the two puts the veil over the pane. */}
      <div data-cold-start-bounds className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div data-cold-start-body className="cold-start-body">
          {/* WHERE IT LANDS, said once and quietly (POD-2079). The 33px question
              this replaced asked the operator something the box itself asks; the
              label only names the project, and the pill is how to change it. */}
          <h2 className="cold-start-head">
            {first ? 'First task in' : 'New task in'}
            <PropertyMenu
              typeahead
              trigger={
                <button
                  type="button"
                  data-pressable
                  aria-label={
                    selectedRepo ? `Project: ${repoLabel(selectedRepo)}` : 'Choose a project'
                  }
                  className="cold-start-project focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Folder size={12} className="flex-none text-text-dim" aria-hidden="true" />
                  <span className="cold-start-project-name">
                    {selectedRepo ? repoLabel(selectedRepo) : 'a project'}
                  </span>
                  <ChevronDown size={11} className="flex-none text-text-dim" aria-hidden="true" />
                </button>
              }
              onOpenChange={onRepositoryPickerOpen}
              options={repoChoices.map((repo) => ({ value: repo.path, label: repoLabel(repo) }))}
              selectedValue={selectedRepo?.path}
              placeholder="Choose a project…"
              onSelect={selectRepo}
            />
          </h2>

          {/* The drop target is the PANE, not this box (POD-1669) — see
              `paneDrop`. What stays here is the chord and the paste. */}
          <fieldset
            ref={setRootEl}
            data-testid="cold-start-field"
            data-tip-anchor={FIRST_PROMPT_ANCHOR}
            className="cold-start-field relative min-w-0 overflow-hidden border-0 p-0"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                launch()
              }
            }}
          >
            <textarea
              ref={inputRef}
              aria-label="What do you want to work on?"
              rows={2}
              defaultValue={initialPrompt}
              disabled={busy || Boolean(draft.pendingIssueId)}
              data-ghosted={ghost ? 'true' : undefined}
              aria-hidden={ghost || undefined}
              onChange={(event) =>
                setDraft(withoutCreateReservation({ ...draft, title: event.currentTarget.value }))
              }
              onPaste={attachments.onPaste}
              placeholder="What should change, and why?"
              className="cold-start-input block w-full resize-none bg-transparent text-text-strong outline-none placeholder:text-text-faint disabled:opacity-60"
            />
            {ghost && <FirstPromptGhost />}
            {attachments.attachments.length > 0 && (
              <div className="px-8 pb-3">
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
            <div className="cold-start-foot">
              {/* ONE CHIP FOR THE HARNESS (POD-2079): `Codex GPT-6.1-Sol · Max`.
                  Agent, model and effort are still three menus, because they are
                  three decisions, but they read as one phrase with the parts that
                  only qualify it in a quieter ink. */}
              <span className={cn(chip, 'gap-0 px-0 hover:bg-transparent')}>
                <CapabilityAgentMenu
                  typeahead
                  trigger={
                    <button
                      type="button"
                      data-pressable
                      aria-label="Agent"
                      className="inline-flex h-7 items-center gap-1.5 rounded-[7px] pr-1 pl-2 hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {issueAgentIcon(agent, 13)}
                      {issueAgentLabel(agent)}
                    </button>
                  }
                  options={agentOptions}
                  selectedValue={agent}
                  onSelect={(nextAgent) => {
                    const kind = issueAgentKind(nextAgent) ?? agent
                    if (kind !== agent) setDriverChoice(HEADED_DRIVER)
                    setDraft(
                      withoutCreateReservation({
                        ...draft,
                        agent: kind,
                      }),
                    )
                  }}
                />
                <ModelPicker
                  variant="inline"
                  allowFreeText={false}
                  agentKind={agent}
                  machineId={selectedMachine?.id}
                  value={draft.model}
                  className="h-7 px-1 text-text-faint hover:text-text-strong"
                  onChange={(model) =>
                    setDraft(
                      withoutCreateReservation({
                        ...draft,
                        model,
                        effort: AUTO,
                        launchPickTouched: true,
                      }),
                    )
                  }
                />
                <span className="text-text-faint" aria-hidden="true">
                  ·
                </span>
                <EffortPicker
                  variant="inline"
                  agentKind={agent}
                  machineId={selectedMachine?.id}
                  model={draft.model}
                  value={draft.effort}
                  className="h-7 pr-2 pl-1 text-text-faint enabled:hover:text-text-strong"
                  onChange={(effort) =>
                    setDraft(
                      withoutCreateReservation({ ...draft, effort, launchPickTouched: true }),
                    )
                  }
                />
              </span>
              <PropertyMenu
                typeahead
                trigger={
                  <button type="button" data-pressable className={chip}>
                    <Monitor size={13} className="flex-none text-text-dim" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      {selectedMachine?.name ?? 'Choose machine'}
                    </span>
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
              {runtimeDriversEnabled &&
              (availableHeadedDriver !== undefined || availableHeadlessDrivers.length > 0) ? (
                <PropertyMenu
                  typeahead
                  trigger={
                    <button type="button" data-pressable aria-label="Driver" className={chip}>
                      {driverChoice === HEADED_DRIVER ? 'Headed' : runtimeDriverLabel(driverChoice)}
                    </button>
                  }
                  options={[
                    ...(availableHeadedDriver ? [{ value: HEADED_DRIVER, label: 'Headed' }] : []),
                    ...availableHeadlessDrivers.map((driver) => ({
                      value: driver.id,
                      label: runtimeDriverLabel(driver.id),
                      group: 'Headless drivers',
                    })),
                  ]}
                  selectedValue={driverChoice}
                  placeholder="Choose a driver…"
                  onSelect={setDriverChoice}
                />
              ) : null}
              {driverUnavailable && (
                <span role="status" className="px-1 text-[11px] text-danger">
                  {driverChoice} unavailable
                </span>
              )}
              <button
                type="button"
                data-pressable
                aria-label="Attach a file"
                title="Attach a file"
                disabled={busy || Boolean(draft.pendingIssueId) || Boolean(draft.createIssueId)}
                onClick={attachments.openFilePicker}
                className="inline-flex size-7 flex-none items-center justify-center rounded-[7px] text-text-dim transition-colors hover:bg-accent hover:text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Paperclip size={14} aria-hidden="true" />
              </button>
              <div className="ml-auto flex flex-none items-center">
                {words > 0 && (
                  <span
                    data-testid="cold-start-words"
                    className="mr-2.5 font-mono text-[10.5px] text-text-faint tabular-nums"
                  >
                    {words} {words === 1 ? 'word' : 'words'}
                  </span>
                )}
                <button
                  type="button"
                  data-pressable
                  data-testid="cold-start-launch"
                  className="cold-start-launch btn-primary-rim"
                  // Empty, it still starts the agent with no prompt, but in the
                  // quiet secondary face: the empty box stays calm (POD-2079).
                  data-quiet={!hasPrompt && !draft.pendingIssueId ? 'true' : undefined}
                  disabled={launchBlocked}
                  onClick={launch}
                  aria-label={draft.pendingIssueId ? 'Retry starting work' : 'Start task'}
                  // Empty, this button opens the agent with no prompt — the
                  // words do not say so on their own.
                  title={
                    hasPrompt || draft.pendingIssueId
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
                      Start task
                      <span className="cold-start-launch-chord" aria-hidden="true">
                        {modChord('↵')}
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
                <div className="inline-flex items-center gap-2.5 rounded-lg bg-bar px-4 py-3 text-[12px] text-foreground shadow-[inset_0_0_0_1px_var(--border-strong),0_12px_30px_var(--carve-popover-near)]">
                  <LoaderCircle
                    size={15}
                    className="animate-spin text-primary"
                    aria-hidden="true"
                  />
                  Starting your task…
                </div>
              </div>
            )}
          </fieldset>

          {/* THREE DEAD ENDS, THREE ANSWERS (POD-1469, POD-1582).
              UNAUTHORIZED IS NOT UNREADY, and it is stated first: no amount of
              agent setup makes a host you have no grant on runnable. NEITHER IS
              A MISSING CHECKOUT: the machine picker is the control that fixes
              that one, so name it. */}
          {machineDenied ? (
            <p className="cold-start-note">
              You do not have access to run work on this machine. Ask its owner for access, or pick
              another machine.
            </p>
          ) : signInFirst ? (
            <p className="cold-start-note">
              {signInInTerminalCopy(readiness, issueAgentLabel(agent))}
            </p>
          ) : (
            !ready &&
            (selectedCheckout ? (
              <p className="cold-start-note">{AGENT_NOT_READY_COPY}</p>
            ) : (
              <p className="cold-start-note">
                {selectedRepo ? repoLabel(selectedRepo) : 'This project'} is not checked out on{' '}
                {selectedMachine?.name ?? 'this machine'}. Pick another machine, or clone it there
                first.
              </p>
            ))
          )}
          {draft.pendingIssueId && !error && (
            <p className="cold-start-note">
              The task is saved. Podium is retrying the same task, so it cannot create a duplicate.
            </p>
          )}
          {error && (
            <div className="mt-3">
              <SetupError>{error} Your request and selections are still saved.</SetupError>
            </div>
          )}
          {!busy && !draft.pendingIssueId && !draft.title.includes(COORDINATOR_PROMPT) && (
            // Hidden, not removed, while the first-prompt tip shows: one tip at a time,
            // and on a narrow pane the tip card lands on this line.
            <p className="cold-start-tip" style={tipShowing ? { visibility: 'hidden' } : undefined}>
              Something big?{' '}
              <button
                type="button"
                data-testid="cold-start-coordinator"
                onClick={insertCoordinatorPrompt}
                title="Adds a prompt that has the agent break the work into sub-issues and coordinate other sessions"
              >
                Try adding a coordinator prompt
              </button>
            </p>
          )}
        </div>
      </div>
      {/* One frame over the WHOLE deck, because that is what accepts the drop. */}
      {dragging && (
        <div className="pointer-events-none absolute inset-2.5 z-20 flex items-center justify-center rounded-[18px] border-2 border-dashed border-primary bg-primary/[0.07]">
          <span className="inline-flex items-center gap-2.5 rounded-lg bg-bar px-4 py-3 text-[12.5px] font-semibold text-text-strong shadow-[inset_0_0_0_1px_var(--border-strong),0_12px_30px_var(--carve-popover-near)]">
            <Paperclip size={14} className="text-primary" aria-hidden="true" />
            Drop files to attach
          </span>
        </div>
      )}
    </div>
  )
}
