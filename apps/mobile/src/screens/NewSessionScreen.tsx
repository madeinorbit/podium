import {
  machinesWithRepo,
  resolveDefaultAgent,
  resolveTargetMachine,
  sidebarSections,
  spawnTargetForRepo,
} from '@podium/client-core/viewmodels'
import type { AgentKind } from '@podium/model'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Screen } from '../components/Screen'
import { SectionHeader } from '../components/ui'
import { color, font, radius, sans, space } from '../theme/theme'

const AGENT_KINDS: { key: AgentKind | undefined; label: string }[] = [
  { key: undefined, label: 'Default' },
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'grok', label: 'Grok' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'cursor', label: 'Cursor' },
]

function param(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value
  return v ? decodeURIComponent(v) : undefined
}

export function NewSessionScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const params = useLocalSearchParams<{ cwd?: string | string[]; issueId?: string | string[] }>()
  const presetCwd = param(params.cwd)
  const issueId = param(params.issueId)

  const repos = useMemo(() => {
    const sections = sidebarSections(
      client.repos,
      client.sessions,
      client.pins,
      Date.now(),
      client.issues,
    )
    return [...sections.pinnedRepos, ...sections.repos]
  }, [client.repos, client.sessions, client.pins, client.issues])
  const [cwd, setCwd] = useState(presetCwd ?? '')
  const [agentKind, setAgentKind] = useState<AgentKind | undefined>(undefined)
  const [machineId, setMachineId] = useState<string | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (cwd || repos.length === 0) return
    const repo = repos[0]
    if (!repo) return
    const targetMachine = resolveTargetMachine(repo, client.sessions, client.machines)
    const { worktree } = spawnTargetForRepo(repo, targetMachine)
    setCwd(worktree.path)
    setMachineId(targetMachine)
  }, [cwd, repos, client.sessions, client.machines])

  const issue = issueId ? client.issueById(issueId) : undefined
  const selectedRepo = repos.find((repo) =>
    repo.worktrees.some((worktree) => worktree.path === cwd),
  )
  const repoMachines = selectedRepo ? machinesWithRepo(selectedRepo, client.machines) : []
  const canCreate = useMemo(() => cwd.trim().length > 0 && !busy, [cwd, busy])
  const screenTitle = issueId ? 'Add agent' : 'New session'
  const submitLabel = issueId ? 'Add agent' : 'Start session'

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const path = cwd.trim()
      const target = selectedRepo
        ? spawnTargetForRepo(selectedRepo, machineId).worktree
        : { path, repoPath: path, ...(machineId ? { machineId } : {}) }
      const text = prompt.trim()

      // The common root launch uses the shared desktop mechanism: optimistic
      // session + draft vessel now, server reconciliation by those same ids.
      if (!issueId && !title.trim()) {
        const created = client.spawnDraftAgent({
          target,
          agentKind: resolveDefaultAgent(agentKind, client.sessions),
          ...(text ? { firstPrompt: text } : {}),
        })
        router.replace(`/session/${created.sessionId}`)
        return
      }

      // A custom title still uses the server half of that mechanism. The shared
      // optimistic helper does not carry titles, but the draft issue is durable.
      const created = await client.trpc.sessions.create.mutate({
        cwd: target.path,
        ...(target.machineId ? { machineId: target.machineId } : {}),
        ...(agentKind ? { agentKind } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(issueId ? { issueId } : { draftIssue: { repoPath: target.repoPath } }),
      })
      if (text) await client.sendMessage(created.sessionId, text)
      router.replace(`/session/${created.sessionId}`)
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Screen title={screenTitle} onBack={() => router.back()}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {issue ? (
          <Text style={styles.issueNote}>
            Attached to #{issue.seq} {issue.title}
          </Text>
        ) : null}

        <SectionHeader label="Repository" />
        {repos.length > 0 ? (
          <View style={styles.chipWrap}>
            {repos.map((repo) => {
              const active = selectedRepo?.path === repo.path
              return (
                <Pressable
                  key={repo.path}
                  accessibilityRole="button"
                  accessibilityLabel={`Repository ${repo.name}`}
                  onPress={() => {
                    const targetMachine = resolveTargetMachine(
                      repo,
                      client.sessions,
                      client.machines,
                    )
                    const { worktree } = spawnTargetForRepo(repo, targetMachine)
                    setCwd(worktree.path)
                    setMachineId(targetMachine)
                  }}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {repo.name}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel="Working directory"
          style={styles.input}
          value={cwd}
          onChangeText={(value) => {
            setCwd(value)
            setMachineId(undefined)
          }}
          placeholder="/path/to/repo"
          placeholderTextColor={color.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
        />

        {repoMachines.length > 1 ? (
          <>
            <SectionHeader label="Machine" />
            <View style={styles.chipWrap}>
              {repoMachines.map((machine) => {
                const active = machineId === machine.id
                return (
                  <Pressable
                    key={machine.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Machine ${machine.name}${machine.online ? '' : ' offline'}`}
                    accessibilityState={{ disabled: !machine.online }}
                    disabled={!machine.online}
                    onPress={() => {
                      if (!selectedRepo) return
                      const { worktree } = spawnTargetForRepo(selectedRepo, machine.id)
                      setMachineId(machine.id)
                      setCwd(worktree.path)
                    }}
                    style={[
                      styles.chip,
                      active && styles.chipActive,
                      !machine.online && styles.chipDisabled,
                    ]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {machine.name}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </>
        ) : null}

        <SectionHeader label="Agent" />
        <View style={styles.chipWrap}>
          {AGENT_KINDS.map((kind) => {
            const active = agentKind === kind.key
            return (
              <Pressable
                key={kind.label}
                accessibilityRole="button"
                accessibilityLabel={`Agent ${kind.label}`}
                onPress={() => setAgentKind(kind.key)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{kind.label}</Text>
              </Pressable>
            )
          })}
        </View>

        <SectionHeader label="Title (optional)" />
        <TextInput
          accessibilityLabel="Session title"
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="What is this session for?"
          placeholderTextColor={color.textFaint}
        />

        <SectionHeader label="First prompt (optional)" />
        <TextInput
          accessibilityLabel="First prompt"
          style={[styles.input, styles.promptInput]}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Delivered as soon as the agent is up."
          placeholderTextColor={color.textFaint}
          multiline
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={submitLabel}
          disabled={!canCreate}
          onPress={() => void create()}
          style={[styles.createBtn, !canCreate && styles.createBtnDisabled]}
        >
          <Text style={styles.createText}>{busy ? 'Starting…' : submitLabel}</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: space.xxl,
  },
  issueNote: {
    color: color.accent,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  chip: {
    borderRadius: radius.full,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    backgroundColor: color.card,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipActive: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  chipDisabled: {
    opacity: 0.38,
  },
  chipText: {
    color: color.textDim,
    fontSize: font.small,
    ...sans(600),
  },
  chipTextActive: {
    color: color.accentText,
  },
  input: {
    marginHorizontal: space.lg,
    color: color.text,
    fontSize: font.body,
    backgroundColor: color.bgSunken,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  promptInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  createBtn: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    alignItems: 'center',
    paddingVertical: space.md,
  },
  createBtnDisabled: {
    opacity: 0.4,
  },
  createText: {
    color: color.accentText,
    fontSize: font.body,
    ...sans(700),
  },
})
