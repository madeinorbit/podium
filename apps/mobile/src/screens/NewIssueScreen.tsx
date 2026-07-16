import type { IssueType } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Screen } from '../components/Screen'
import { SectionHeader } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'

const TYPES: IssueType[] = ['task', 'bug', 'feature', 'chore']
const PRIORITIES = [0, 1, 2, 3, 4]

export function NewIssueScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const [repos, setRepos] = useState<string[]>([])
  const [repoPath, setRepoPath] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<IssueType>('task')
  const [priority, setPriority] = useState(2)
  const [startNow, setStartNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    client.trpc.repos.list
      .query()
      .then((list) => {
        setRepos(list)
        setRepoPath((prev) => prev || list[0] || '')
      })
      .catch(() => setRepos([]))
  }, [client.trpc])

  const canCreate = repoPath.trim().length > 0 && title.trim().length > 0 && !busy

  const create = async () => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      const issue = await client.trpc.issues.create.mutate({
        repoPath: repoPath.trim(),
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        type,
        priority,
        startNow,
      })
      router.replace(`/issue/${encodeURIComponent(issue.id)}`)
    } catch (e) {
      setBusy(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Screen title="New task" onBack={() => router.back()}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SectionHeader label="Repository" />
        <View style={styles.chipWrap}>
          {repos.map((repo) => {
            const name = repo.split('/').filter(Boolean).pop() ?? repo
            const active = repoPath === repo
            return (
              <Pressable
                key={repo}
                accessibilityRole="button"
                accessibilityLabel={`Repository ${name}`}
                onPress={() => setRepoPath(repo)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{name}</Text>
              </Pressable>
            )
          })}
        </View>

        <SectionHeader label="Title" />
        <TextInput
          accessibilityLabel="Task title"
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="What needs doing?"
          placeholderTextColor={color.textFaint}
        />

        <SectionHeader label="Description (optional)" />
        <TextInput
          accessibilityLabel="Task description"
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Context, constraints, acceptance criteria…"
          placeholderTextColor={color.textFaint}
          multiline
        />

        <SectionHeader label="Type" />
        <View style={styles.chipWrap}>
          {TYPES.map((t) => (
            <Pressable
              key={t}
              accessibilityRole="button"
              accessibilityLabel={`Type ${t}`}
              onPress={() => setType(t)}
              style={[styles.chip, type === t && styles.chipActive]}
            >
              <Text style={[styles.chipText, type === t && styles.chipTextActive]}>{t}</Text>
            </Pressable>
          ))}
        </View>

        <SectionHeader label="Priority" />
        <View style={styles.chipWrap}>
          {PRIORITIES.map((p) => (
            <Pressable
              key={p}
              accessibilityRole="button"
              accessibilityLabel={`Priority ${p}`}
              onPress={() => setPriority(p)}
              style={[styles.chip, priority === p && styles.chipActive]}
            >
              <Text style={[styles.chipText, priority === p && styles.chipTextActive]}>P{p}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={startNow ? 'Agent will start now' : 'File without starting'}
          onPress={() => setStartNow((v) => !v)}
          style={styles.toggleRow}
        >
          <View style={[styles.checkbox, startNow && styles.checkboxOn]}>
            {startNow ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
          <Text style={styles.toggleLabel}>Start an agent on it right away</Text>
        </Pressable>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create task"
          disabled={!canCreate}
          onPress={() => void create()}
          style={[styles.createBtn, !canCreate && styles.createBtnDisabled]}
        >
          <Text style={styles.createText}>
            {busy ? 'Creating…' : startNow ? 'Create & start agent' : 'Create task'}
          </Text>
        </Pressable>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: space.xxl,
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
  multiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: color.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  checkmark: {
    color: color.accentText,
    fontSize: 13,
    fontWeight: '800',
  },
  toggleLabel: {
    color: color.text,
    fontSize: font.small,
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
