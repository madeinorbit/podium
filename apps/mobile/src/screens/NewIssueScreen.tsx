import {
  AUTO,
  agentDescriptors,
  draftForLaunchContext,
  draftForReportedModels,
  effortLabel,
  effortOptionsForModel,
  ISSUE_AGENT_KINDS,
  issueAgentKind,
  issueAgentLabel,
  type LaunchPickContext,
  modelName,
  modelOptions,
  readLastLaunchPicks,
  rememberLaunchPick,
} from '@podium/client-core/agent-models'
import {
  clearFirstTaskDraft,
  type FirstTaskDraft,
  readFirstTaskDraft,
  serializeFirstTaskDraft,
  withoutCreateReservation,
} from '@podium/client-core/first-task-draft'
import { randomUUID } from '@podium/client-core/id'
import {
  COORDINATOR_PROMPT,
  checkoutForMachine,
  firstTaskLaunchNote,
  firstTaskMachineDenied,
  firstTaskMachines,
  firstTaskRepositorySubtitle,
  nativeAccountId,
  promptTitle,
  selectedFirstTaskMachine,
  selectedFirstTaskRepository,
} from '@podium/client-core/new-task'
import {
  useCommands,
  useFirstTaskRepositoryPicker,
  useHarnessDescriptors,
  useModelCatalog,
} from '@podium/client-core/react'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY, LAST_LAUNCH_PICK_KEY } from '@podium/client-core/ui-state'
import {
  activationAgentReadiness,
  agentCanLaunch,
  launchAgentKind,
} from '@podium/client-core/values'
import { LOADING } from '@podium/client-graph/loading'
import type { MobxPool } from '@podium/client-graph/pool'
import { useOpeningView } from '@podium/client-graph/react'
import {
  createSettingsViews,
  readSettingsCatalog,
  type SettingsCatalog,
} from '@podium/client-graph/settings-views'
import { issueWrites } from '@podium/commands/issues-synced'
import {
  asIssueId,
  asMachineId,
  asMutationId,
  asSessionId,
  DEFAULT_HARNESS_AGENT,
  machinePathBasename,
} from '@podium/model'
import { useLocalSearchParams } from 'expo-router'
import { HeaderHeightContext } from 'expo-router/react-navigation'
import { observer } from 'mobx-react-lite'
import { use, useCallback, useEffect, useRef, useState } from 'react'
import { Platform, type TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTrpc, useUiState } from '../client/hooks'
import { useMobilePool, useMobilePoolProjection } from '../client/mobile-pool'
import { useMyCodingHarness } from '../client/my-preferences'
import type { MobileTrpc } from '../client/trpc'
import { ComposeBody, ComposeFieldRow } from '../components/compose/ComposeBody'
import type { ComposeMenuItem } from '../components/compose/ComposeMenu'
import { ComposeSheetHeader } from '../components/compose/ComposeSheetHeader'
import { ComposeStartButton } from '../components/compose/ComposeStartButton'
import { useComposePresentation } from '../components/compose/useComposePresentation'
import { useComposerAttachments } from '../components/useComposerAttachments'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { usePersistedUiState } from '../hooks/usePersistedUiState'
import { onMediaPaste, pickDocuments, pickPhotos, takePhoto } from '../lib/composer-media'
import { newTaskInput, newTaskSubmitState } from '../lib/new-task'
import { sessionBackTarget, sessionHref } from '../lib/session-route'
import { useRootScreenRouter } from '../navigation/use-root-screen-router'
import { color } from '../theme/theme'

const EMPTY_CATALOG: SettingsCatalog = { repos: [], machines: [] }
const EMPTY_SETUP = {
  usage: new Map<string, number>(),
  defaultAgent: DEFAULT_HARNESS_AGENT as string,
  pending: 0,
}
const readDraftLoading = (pool: MobxPool) =>
  pool.row('preference', FIRST_TASK_ACTIVATION_DRAFT_KEY) === LOADING
const readCatalogLoading = (pool: MobxPool) => pool.row('settingsCatalog', 'catalog') === LOADING

/** One compose flow for filing a task, starting an agent, or opening a shell. */
export const NewIssueScreen = observer(function NewIssueScreen() {
  const router = useRootScreenRouter()
  const params = useLocalSearchParams<{ repoPath?: string; backTo?: string }>()
  const trpc = useTrpc()
  const uiState = useUiState()
  const commands = useCommands<MobileTrpc>()
  const { spawnDraftAgent } = commands.sessions
  const { setPreferences } = commands.preferences
  const pool = useMobilePool()
  const view = useOpeningView(pool, createSettingsViews)
  const readCatalog = useCallback(() => view?.catalog() ?? EMPTY_CATALOG, [view])
  const { repos, machines } = useMobilePoolProjection(readCatalog, EMPTY_CATALOG)
  const readSetup = useCallback(() => view?.setupCatalog() ?? EMPTY_SETUP, [view])
  const setup = useMobilePoolProjection(readSetup, EMPTY_SETUP)
  // Keep the inputs live between menu openings. UIKit snapshots SwiftUI Menu's
  // UIMenu at presentation; the ActionSheet fallback snapshots in its open().
  // Freezing this hook for the sheet's lifetime would hide new project discovery.
  const { repoChoices } = useFirstTaskRepositoryPicker(repos, setup.usage)
  const catalogLoading = useMobilePoolProjection(readCatalogLoading, true)
  const draftLoading = useMobilePoolProjection(readDraftLoading, true)
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
  // My coding default is my synced `userPreferences` record (POD-6673).
  const codingHarness = useMyCodingHarness()
  const [pickedMachine, setPickedMachine] = useState<string>()
  const [busy, setBusy] = useState(false)
  const starting = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const promptRef = useRef<TextInput>(null)
  const [pasteInput, setPasteInput] = useState<TextInput | null>(null)
  const previousContext = useRef<LaunchPickContext | undefined>(undefined)
  const presetApplied = useRef(false)
  const presetPath = !presetApplied.current ? params.repoPath : undefined
  const selectedRepo = selectedFirstTaskRepository(repoChoices, presetPath ?? draft.repoPath)
  const targetMachines = firstTaskMachines(selectedRepo, machines)
  const machine = selectedFirstTaskMachine(
    targetMachines,
    presetPath ? '' : draft.machineId,
    pickedMachine,
    machines,
  )
  const checkout = selectedRepo
    ? checkoutForMachine(repos, selectedRepo, machine?.id, draft.repoPath)
    : undefined
  const defaultAgent = issueAgentKind(codingHarness ?? setup.defaultAgent) ?? DEFAULT_HARNESS_AGENT
  const agent = launchAgentKind({
    picked: issueAgentKind(draft.agent),
    preferred: defaultAgent,
    candidates: ISSUE_AGENT_KINDS,
    readiness: (kind) => activationAgentReadiness(checkout, machine ? [machine] : machines, kind),
  })
  const shell = draft.model === 'shell'
  const readiness = activationAgentReadiness(checkout, machine ? [machine] : machines, agent)
  const machineDenied = firstTaskMachineDenied(machine, machines)
  const ready = shell
    ? !!machine?.online && !machineDenied
    : agentCanLaunch(readiness, { headed: true })
  const signInFirst = !shell && ready && readiness.state === 'logged-out'
  const catalog = useModelCatalog<MobileTrpc>(machine?.id)
  const { served } = useHarnessDescriptors<MobileTrpc>(machine?.id)
  const reported = catalog[agent]
  const [uploadScope] = useState(() => asSessionId(`coldstart-${randomUUID()}`))
  const attachments = useComposerAttachments(uploadScope, {
    destination: 'issue',
    draft: { attachments: draft.attachments, uiState },
  })
  const insets = useSafeAreaInsets()
  const headerHeight = use(HeaderHeightContext) ?? 0
  const keyboardLift = useKeyboardLift()
  const promptReady = useComposePresentation()

  // Same context restoration as desktop, after the coding role and stored draft arrive.
  useEffect(() => {
    if (draftLoading || !selectedRepo || busy || draft.createIssueId || draft.pendingIssueId) return
    presetApplied.current = true
    const aliases = [selectedRepo.path, ...(selectedRepo.machines ?? []).map((row) => row.path)]
    let next = {
      ...draft,
      repoPath: aliases.includes(draft.repoPath) ? draft.repoPath : selectedRepo.path,
      machineId: machine?.id ?? '',
      ...(draft.agent || codingHarness === undefined ? {} : { agent }),
    }
    if (!shell && machine && (draft.agent || codingHarness !== undefined)) {
      const context = { machineId: machine.id, harness: agent }
      next = draftForLaunchContext(next, previousContext.current, context, lastLaunchPicks)
      previousContext.current = context
      next = draftForReportedModels(next, reported) ?? next
    }
    if (
      serializeFirstTaskDraft(next) !== serializeFirstTaskDraft(draft) &&
      serializeFirstTaskDraft(readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))) ===
        serializeFirstTaskDraft(draft)
    )
      setDraft(next)
  }, [
    draftLoading,
    selectedRepo,
    machine,
    busy,
    draft,
    shell,
    codingHarness,
    agent,
    reported,
    lastLaunchPicks,
    setDraft,
    uiState,
  ])

  // The prompt mounts after the sheet transition. Its own layout event means
  // Fabric has mounted the input; a parent mount effect can only see null.
  useEffect(() => {
    if (!pasteInput) return
    return onMediaPaste(pasteInput, attachments.accept, attachments.fromSource)
  }, [pasteInput, attachments.accept, attachments.fromSource])

  const write = (patch: Partial<FirstTaskDraft>) => {
    setError(null)
    const current = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    setDraft(withoutCreateReservation({ ...current, ...patch }))
  }
  const selectProject = (path: string) => {
    const repo = repoChoices.find((row) => row.path === path)
    const host = selectedFirstTaskMachine(
      firstTaskMachines(repo, machines),
      '',
      undefined,
      machines,
    )
    setPickedMachine(undefined)
    write({ repoPath: path, machineId: host?.id ?? '' })
  }
  const status = newTaskSubmitState({
    busy,
    draftLoading: draftLoading || catalogLoading,
    hasProject: !!selectedRepo,
    hasMachine: !!machine,
    hasCheckout: !!checkout,
    machineDenied,
    ready,
    prompt: draft.title,
    attachmentCount: attachments.attachments.length,
    uploading: attachments.uploading,
    shell,
  })
  const note = catalogLoading
    ? undefined
    : (firstTaskLaunchNote({
        machineDenied,
        signInFirst,
        ready,
        hasCheckout: !!checkout,
        readiness,
        agentLabel: issueAgentLabel(agent, served),
        projectLabel: selectedRepo?.name ?? 'This project',
        machineLabel: machine?.name ?? 'this machine',
      }) ??
      (shell && attachments.attachments.length
        ? 'This agent cannot accept file attachments.'
        : undefined))

  const persistFailure = (reserved: FirstTaskDraft, message: string) => {
    const current = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    if (current.createMutationId === reserved.createMutationId) {
      uiState.set(
        FIRST_TASK_ACTIVATION_DRAFT_KEY,
        serializeFirstTaskDraft({ ...reserved, launchError: message }),
      )
    }
    starting.current = false
    setBusy(false)
    setError(message)
  }
  const clearAccepted = (reserved: FirstTaskDraft) => {
    const current = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    if (current.createMutationId === reserved.createMutationId) clearFirstTaskDraft(uiState)
  }
  const start = () => {
    // A second tap at the opening control's old position must not launch work
    // while UIKit is still presenting the sheet.
    if (!promptReady || attachments.uploading) return
    const current = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    if (!status.canStart || starting.current || !selectedRepo || !checkout || !machine) return
    starting.current = true
    setBusy(true)
    setError(null)
    const reserved: FirstTaskDraft = {
      ...current,
      launchKind: 'draft',
      launchError: '',
      createIssueId:
        current.launchKind === 'draft' && current.createIssueId
          ? current.createIssueId
          : asIssueId(`iss_${randomUUID()}`),
      createSessionId:
        current.launchKind === 'draft' && current.createSessionId
          ? current.createSessionId
          : asSessionId(randomUUID()),
      createMutationId:
        current.launchKind === 'draft' && current.createMutationId
          ? current.createMutationId
          : asMutationId(randomUUID()),
    }
    setDraft(reserved)
    try {
      const files = attachments.ready()
      const refs = files.flatMap((file) => file.ref ?? [])
      const launched = spawnDraftAgent({
        issueId: asIssueId(reserved.createIssueId),
        sessionId: asSessionId(reserved.createSessionId),
        mutationId: asMutationId(reserved.createMutationId),
        target: {
          path: checkout.path,
          repoPath: checkout.path,
          machineId: asMachineId(machine.id),
          ...(selectedRepo.repoId === undefined ? {} : { repoId: selectedRepo.repoId }),
        },
        agentKind: shell ? 'shell' : agent,
        ...(!shell && current.title.trim() ? { firstPrompt: current.title.trim() } : {}),
        ...(!shell && refs.length ? { attachments: refs } : {}),
        ...(!shell && current.model !== AUTO ? { model: current.model } : {}),
        ...(!shell && current.effort !== AUTO ? { effort: current.effort } : {}),
      })
      rememberLaunchPick(
        uiState,
        { machineId: machine.id, harness: shell ? 'shell' : agent },
        shell ? { model: AUTO, effort: AUTO } : current,
      )
      if (!shell && agent !== defaultAgent)
        void setPreferences({ 'roles.coding.accountId': nativeAccountId(agent) }).catch(() => {})
      void launched.settled.then((accepted) => {
        if (accepted) clearAccepted(reserved)
        else persistFailure(reserved, "Couldn't start the agent.")
      })
      const backTo = sessionBackTarget(params.backTo)
      // A plain session, shell, or headed login needs the existing usable terminal route.
      router.replace(
        shell || signInFirst || !current.title.trim()
          ? {
              pathname: '/session/[sessionId]/terminal',
              params: { sessionId: launched.sessionId, backTo },
            }
          : sessionHref(launched.sessionId, backTo),
      )
    } catch (cause) {
      persistFailure(reserved, cause instanceof Error ? cause.message : String(cause))
    }
  }
  const save = async () => {
    const current = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    if (!status.canSave || starting.current || !selectedRepo) return
    starting.current = true
    setBusy(true)
    const reserved: FirstTaskDraft = {
      ...current,
      launchKind: 'issue',
      launchError: '',
      createIssueId:
        current.launchKind === 'issue' && current.createIssueId
          ? current.createIssueId
          : asIssueId(`iss_${randomUUID()}`),
      createMutationId:
        current.launchKind === 'issue' && current.createMutationId
          ? current.createMutationId
          : asMutationId(randomUUID()),
    }
    setDraft(reserved)
    try {
      const issue = await issueWrites(trpc).create.mutate({
        ...newTaskInput({
          repoPath: checkout?.path ?? selectedRepo.path,
          title: promptTitle(current.title),
          prompt: current.title,
          type: 'task',
          priority: 2,
          startNow: false,
          launch: { defaultModel: AUTO, defaultEffort: AUTO, machineId: null },
        }),
        id: asIssueId(reserved.createIssueId),
        mutationId: asMutationId(reserved.createMutationId),
      })
      clearAccepted(reserved)
      router.replace(`/issue/${encodeURIComponent(issue.id)}`)
    } catch (cause) {
      persistFailure(reserved, cause instanceof Error ? cause.message : String(cause))
    }
  }

  const models = modelOptions(agent, reported, served)
  const efforts = effortOptionsForModel(agent, draft.model, reported, served)
  const modelText = shell ? 'Shell' : modelName(agent, draft.model, reported, served)
  const agentChoices: ComposeMenuItem[] = agentDescriptors(served).flatMap((row) => {
    const kind = issueAgentKind(row.kind)
    if (!kind) return []
    const state = activationAgentReadiness(checkout, machine ? [machine] : [], kind)
    const canRun = !machineDenied && agentCanLaunch(state, { headed: true })
    return {
      id: kind,
      label: row.label,
      selected: !shell && agent === kind,
      disabled: !canRun,
      ...(!canRun
        ? {
            subtitle:
              state.state === 'missing'
                ? `Not installed on ${machine?.name ?? 'this machine'}`
                : state.state === 'offline'
                  ? `${machine?.name ?? 'This machine'} is offline`
                  : state.state === 'unauthorized'
                    ? 'No access to this machine'
                    : 'Not ready on this machine',
          }
        : {}),
      onPress: () => write({ agent: kind, model: AUTO, effort: AUTO, launchPickTouched: false }),
    }
  })
  const unavailableAgents = agentChoices.filter((row) => row.disabled && !row.selected)
  const agentItems: ComposeMenuItem[] = [
    {
      id: 'agents',
      label: 'Agent',
      inline: true,
      items: [
        ...agentChoices.filter((row) => !row.disabled || row.selected),
        // Keep the root menu short enough for Model and Effort above the
        // software keyboard. Installation reasons remain in a native submenu.
        ...(unavailableAgents.length
          ? [{ id: 'unavailable', label: 'Unavailable agents', items: unavailableAgents }]
          : []),
      ],
    },
    {
      id: 'configuration',
      label: 'Configuration',
      inline: true,
      items: [
        {
          id: 'model',
          label: `Model · ${modelText}`,
          items: [
            ...models.map((row) => ({
              id: row.value,
              label: row.label,
              selected: !shell && draft.model === row.value,
              onPress: () => write({ model: row.value, effort: AUTO, launchPickTouched: true }),
            })),
            {
              id: 'shell',
              label: 'Shell',
              symbol: 'terminal',
              selected: shell,
              onPress: () => write({ model: 'shell', effort: AUTO, launchPickTouched: true }),
            },
          ],
        },
        ...(!shell && efforts.length
          ? [
              {
                id: 'effort',
                label: `Effort · ${effortLabel(agent, draft.effort)}`,
                items: efforts.map((row) => ({
                  id: row.value,
                  label: row.label,
                  selected: draft.effort === row.value,
                  onPress: () => write({ effort: row.value, launchPickTouched: true }),
                })),
              },
            ]
          : []),
      ],
    },
  ]
  const fields = (
    <>
      <ComposeFieldRow
        label="Project"
        value={selectedRepo?.name ?? (catalogLoading ? 'Loading…' : 'No projects')}
        disabled={busy}
        items={repoChoices.map((repo) => ({
          id: repo.path,
          label: repo.name || machinePathBasename(repo.path),
          subtitle: firstTaskRepositorySubtitle(repo, machines),
          selected: repo === selectedRepo,
          onPress: () => selectProject(repo.path),
        }))}
      />
      <ComposeFieldRow
        label="Agent"
        value={shell ? 'Shell' : issueAgentLabel(agent, served)}
        agent={shell ? 'shell' : agent}
        detail={shell ? undefined : `${modelText} · ${effortLabel(agent, draft.effort)}`}
        items={agentItems}
        disabled={busy}
      />
      <ComposeFieldRow
        label="Machine"
        value={machine?.name ?? 'No machine'}
        disabled={busy}
        items={targetMachines.map((host) => ({
          id: host.id,
          label: `${host.name}${firstTaskMachineDenied(host, machines) ? ' (no access)' : !host.online ? ' (offline)' : ''}`,
          selected: host.id === machine?.id,
          onPress: () => {
            setPickedMachine(host.id)
            write({ machineId: host.id })
          },
        }))}
      />
    </>
  )
  const headerProps = {
    ...status,
    hasPrompt: !!draft.title.trim(),
    busy,
    onCancel: () => router.back(),
    onStart: start,
    onSave: () => void save(),
  }
  return (
    <View collapsable={false} style={{ flex: 1, minHeight: 0, backgroundColor: color.groupedCard }}>
      <ComposeSheetHeader {...headerProps} />
      <ComposeBody
        trailingAction={Platform.OS === 'ios' ? <ComposeStartButton {...headerProps} /> : undefined}
        promptReady={promptReady}
        fields={fields}
        prompt={draft.title}
        promptRef={promptRef}
        onPromptLayout={setPasteInput}
        onPrompt={(title) => write({ title })}
        onStart={start}
        onCancel={() => router.back()}
        onCoordinator={() => {
          const current = draft.title.trimEnd()
          write({ title: current ? `${current}\n\n${COORDINATOR_PROMPT}` : COORDINATOR_PROMPT })
          promptRef.current?.focus()
        }}
        busy={busy}
        note={note}
        error={draft.launchError || error}
        attachments={attachments.attachments}
        onRemoveAttachment={attachments.remove}
        bottomInset={insets.bottom}
        topInset={Platform.OS === 'ios' ? headerHeight : 0}
        keyboardLift={keyboardLift}
        onPhotos={shell ? undefined : () => attachments.fromSource(pickPhotos)}
        onCamera={shell ? undefined : () => attachments.fromSource(takePhoto)}
        onFiles={shell ? undefined : () => attachments.fromSource(pickDocuments)}
      />
    </View>
  )
})
