import {
  lastUsedMaps,
  machinesWithRepo,
  panelLabel,
  type RepoNavView,
  resolveTargetMachine,
  sidebarSections,
  spawnTargetForRepo,
} from '@podium/client-core/viewmodels'
import type { AgentKind } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { useMobileClient } from '../client/MobileClientProvider'
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
  const client = useMobileClient()
  const [step, setStep] = useState<PickerStep>(null)
  const [harness, setHarness] = useState<AgentKind>('claude-code')
  const [repoPath, setRepoPath] = useState<string | null>(null)

  const repos = useMemo(() => {
    const now = Date.now()
    const sections = sidebarSections(client.repos, client.sessions, client.pins, now, client.issues)
    const choices = [...sections.pinnedRepos, ...sections.repos]
    const { byRepo } = lastUsedMaps(sections, client.sessions)
    return choices.sort(
      (a, b) =>
        (byRepo.get(b.path) ?? 0) - (byRepo.get(a.path) ?? 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }, [client.repos, client.sessions, client.pins, client.issues])

  const selectedRepo = repos.find((repo) => repo.path === repoPath)

  const start = (repo: RepoNavView, machineId?: string) => {
    const targetMachine = machineId ?? resolveTargetMachine(repo, client.sessions, client.machines)
    const { worktree } = spawnTargetForRepo(repo, targetMachine)
    const { sessionId } = client.spawnDraftAgent({ target: worktree, agentKind: harness })
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
          const repoMachines = machinesWithRepo(repo, client.machines)
          if (repoMachines.length <= 1) {
            start(repo)
            return
          }
          setRepoPath(repo.path)
          setStep('machine')
        },
      }))
    }

    if (step === 'machine' && selectedRepo) {
      return machinesWithRepo(selectedRepo, client.machines).map((machine) => ({
        label: machine.online ? machine.name : `${machine.name} · offline`,
        disabled: !machine.online,
        onPress: () => start(selectedRepo, machine.id),
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
