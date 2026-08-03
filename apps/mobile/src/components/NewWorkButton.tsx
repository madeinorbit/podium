import { useSlice } from '@podium/client-core/react'
import {
  lastUsedMaps,
  machineViewsFromWire,
  panelLabel,
  type RepoNavView,
  resolveSpawnTargetMachine,
  spawnTargetForRepo,
  usableMachines,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { AgentKind } from '@podium/model'
import { machinesWithRepo } from '@podium/model'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { useMobileStore, useSessions } from '../client/hooks'
import { color } from '../theme/theme'
import { ActionSheet, type SheetAction } from './ActionSheet'
import { Icon } from './Icon'
import { HeaderButton } from './Screen'

const HARNESSES: { kind: AgentKind; label: string }[] = [
  { kind: 'claude-code', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'grok', label: 'Grok' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'shell', label: 'Shell' },
]

type PickerStep = 'harness' | 'repo' | 'machine' | null

/**
 * The pocket equivalent of desktop's New Agent dropdown. Every quick launch
 * goes through store.spawnDraftAgent, so the session is born inside a durable
 * draft issue and receives the same issue-prime lifecycle as desktop.
 */
export function NewWorkButton() {
  const router = useRouter()
  const store = useMobileStore()
  const sessions = useSessions()
  const { sections } = useSlice(worklistSlice)
  const [step, setStep] = useState<PickerStep>(null)
  const [harness, setHarness] = useState<AgentKind>('claude-code')
  const [repoPath, setRepoPath] = useState<string | null>(null)

  // Machines as THIS principal may act on them (doc §3.1.4 M1/M5): `see` is
  // already applied by the server's per-principal projection, `use` is read per
  // LIST by the shared helper — the identical reading the desktop spawn row,
  // the automations form and the execution-profile picker use. Two spellings of
  // "may I run here" is exactly how one surface comes to offer a machine
  // another refuses.
  const machineViews = useMemo(() => machineViewsFromWire(store.machines), [store.machines])

  const repos = useMemo(() => {
    const choices = [...sections.pinnedRepos, ...sections.repos]
    const { byRepo } = lastUsedMaps(sections, sessions)
    return choices.sort(
      (a, b) =>
        (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }, [sections, sessions])

  const selectedRepo = repos.find((repo) => repo.path === repoPath)

  /**
   * Where this spawn lands, or `null` to refuse it outright — the same shape
   * the desktop spawn row uses.
   *
   * DENIED IS NOT NO TARGET (§3.1.4 M5). An `unauthorized` refusal must STOP
   * the spawn: falling through to the repo's primary checkout is the silently
   * retargeted placement M5 forbids. `no-repo` and `unreachable` both resolve to
   * `undefined`, which `spawnTargetForRepo` turns into the repo's own main
   * checkout exactly as before — that split is what keeps single-user parity
   * while closing the hole.
   */
  const resolveSpawnMachine = (
    repo: RepoNavView,
    machineId?: string,
  ): string | undefined | null => {
    if (machineId !== undefined)
      return usableMachines(machineViews).some((m) => m.id === machineId) ? machineId : null
    const { machineId: resolved, refusal } = resolveSpawnTargetMachine(repo, sessions, machineViews)
    return refusal === 'unauthorized' ? null : resolved
  }

  /** The machines that hold this repo, as views — the population the two
   *  refusals are distinguished within. */
  const machineChoices = (repo: RepoNavView) => {
    const withRepo = new Set(
      machinesWithRepo(
        repo,
        machineViews.map((v) => v.machine),
      ).map((m) => m.id),
    )
    return machineViews.filter((v) => withRepo.has(v.machine.id))
  }

  const start = (repo: RepoNavView, machineId?: string) => {
    const targetMachine = resolveSpawnMachine(repo, machineId)
    if (targetMachine === null) return
    const { worktree } = spawnTargetForRepo(repo, targetMachine)
    const { sessionId } = store.spawnDraftAgent({ target: worktree, agentKind: harness })
    setStep(null)
    router.push(`/session/${sessionId}`)
  }

  const actions: SheetAction[] = (() => {
    if (step === 'harness') {
      return [
        {
          label: 'New task',
          hint: 'Tracked work with its own branch and worktree',
          onPress: () => router.push('/new-issue'),
        },
        ...HARNESSES.map(({ kind, label }) => ({
          label,
          onPress: () => {
            setHarness(kind)
            setStep('repo')
          },
        })),
        {
          label: 'Session options…',
          hint: 'Title, first prompt, or a custom working directory',
          onPress: () => router.push('/new-session'),
        },
      ]
    }

    if (step === 'repo') {
      if (repos.length === 0) {
        return [{ label: 'No repositories available', disabled: true, onPress: () => {} }]
      }
      return repos.map((repo) => ({
        label: repo.name,
        onPress: () => {
          if (machineChoices(repo).length <= 1) {
            start(repo)
            return
          }
          setRepoPath(repo.path)
          setStep('machine')
        },
      }))
    }

    if (step === 'machine' && selectedRepo) {
      // UNAUTHORIZED AND UNREACHABLE ARE DIFFERENT WORDS (§3.1.4 M5). Both
      // produce a machine you cannot spawn on, and collapsing them makes a
      // person wait for a wake-up that will never help. Neither is pressable —
      // the picker must not OFFER a machine the principal lacks `use` on — but
      // the denied one says so rather than vanishing.
      return machineChoices(selectedRepo).map((view) => ({
        label:
          view.availability === 'available'
            ? view.machine.name
            : `${view.machine.name} · ${view.availability === 'unauthorized' ? 'no access' : 'offline'}`,
        disabled: view.availability !== 'available',
        onPress: () => start(selectedRepo, view.machine.id),
      }))
    }

    return []
  })()

  const title =
    step === 'harness'
      ? 'New work'
      : step === 'repo'
        ? `New ${panelLabel(harness)} · repository`
        : selectedRepo
          ? `${selectedRepo.name} · machine`
          : 'Choose machine'

  return (
    <>
      <HeaderButton label="New work" onPress={() => setStep('harness')}>
        <Icon as={Plus} size={19} color={color.text} />
      </HeaderButton>
      <ActionSheet
        visible={step !== null}
        title={title}
        actions={actions}
        onClose={() => setStep(null)}
      />
    </>
  )
}
