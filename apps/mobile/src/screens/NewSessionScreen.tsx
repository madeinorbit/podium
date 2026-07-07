import type { AgentKind } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Screen } from '../components/Screen'
import { SectionHeader } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'

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

  const [repos, setRepos] = useState<string[]>([])
  const [cwd, setCwd] = useState(presetCwd ?? '')
  const [agentKind, setAgentKind] = useState<AgentKind | undefined>(undefined)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    client.trpc.repos.list
      .query()
      .then((list) => {
        setRepos(list)
        setCwd((prev) => prev || list[0] || '')
      })
      .catch(() => setRepos([]))
  }, [client.trpc])

  const issue = issueId ? client.issueById(issueId) : undefined
  const canCreate = useMemo(() => cwd.trim().length > 0 && !busy, [cwd, busy])

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const created = await client.trpc.sessions.create.mutate({
        cwd: cwd.trim(),
        ...(agentKind ? { agentKind } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(issueId ? { issueId } : {}),
      })
      const text = prompt.trim()
      if (text) await client.sendMessage(created.sessionId, text)
      router.replace(`/session/${created.sessionId}`)
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Screen title="New session" onBack={() => router.back()}>
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
              const name = repo.split('/').filter(Boolean).pop() ?? repo
              const active = cwd === repo
              return (
                <Pressable
                  key={repo}
                  accessibilityRole="button"
                  accessibilityLabel={`Repository ${name}`}
                  onPress={() => setCwd(repo)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{name}</Text>
                </Pressable>
              )
            })}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel="Working directory"
          style={styles.input}
          value={cwd}
          onChangeText={setCwd}
          placeholder="/path/to/repo"
          placeholderTextColor={color.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
        />

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
          accessibilityLabel="Start session"
          disabled={!canCreate}
          onPress={() => void create()}
          style={[styles.createBtn, !canCreate && styles.createBtnDisabled]}
        >
          <Text style={styles.createText}>{busy ? 'Starting…' : 'Start session'}</Text>
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
  chipText: {
    color: color.textDim,
    fontSize: font.small,
    fontWeight: '600',
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
    fontWeight: '700',
  },
})
