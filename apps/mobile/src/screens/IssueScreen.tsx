import { relativeTime, withoutShells } from '@podium/client-core/focus'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import { ISSUE_STAGES } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { ActionSheet } from '../components/ActionSheet'
import { Composer } from '../components/Composer'
import { Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { EmptyState, Pill, SectionHeader } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'

export function IssueScreen() {
  const params = useLocalSearchParams<{ issueId: string | string[] }>()
  const issueId = decodeURIComponent(
    Array.isArray(params.issueId) ? params.issueId[0] : (params.issueId ?? ''),
  )
  const router = useRouter()
  const client = useMobileClient()
  const issue = client.issueById(issueId)
  const now = Date.now()
  const [stageMenuOpen, setStageMenuOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sessions = useMemo(
    () => withoutShells(client.sessions).filter((s) => s.issueId === issueId && !s.archived),
    [client.sessions, issueId],
  )

  if (!issue) {
    return (
      <Screen title="Task" onBack={() => router.back()}>
        <EmptyState title="Task not found." />
      </Screen>
    )
  }

  const setStage = async (stage: (typeof ISSUE_STAGES)[number]) => {
    setError(null)
    try {
      await client.trpc.issues.update.mutate({ id: issue.id, patch: { stage } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const startAgent = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      await client.trpc.issues.start.mutate({ id: issue.id })
      // The spawned session lands in metadata via the live stream; the attached
      // sessions list below picks it up. Stay here so the user sees it appear.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const addComment = async (body: string) => {
    setError(null)
    try {
      await client.trpc.issues.addComment.mutate({ id: issue.id, author: 'mobile', body })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Screen title={`#${issue.seq} ${issue.title}`} onBack={() => router.back()}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.metaRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stage ${issue.stage} — change`}
            onPress={() => setStageMenuOpen(true)}
          >
            <Pill
              label={`${issue.stage.replace('_', ' ')} ▾`}
              toneKey={issue.stage === 'in_progress' ? 'working' : undefined}
            />
          </Pressable>
          <Pill label={issue.type} />
          <Pill label={`P${issue.priority}`} />
          {issue.needsHuman ? <Pill label="needs human" toneKey="needsYou" /> : null}
          {issue.assignee ? <Pill label={issue.assignee} /> : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {issue.description.trim() ? (
          <Text style={styles.description} selectable>
            {issue.description.trim()}
          </Text>
        ) : null}
        {issue.blockedBy.length > 0 ? (
          <Text style={styles.blocked}>
            Blocked by {issue.blockedBy.length} issue{issue.blockedBy.length > 1 ? 's' : ''}
            {issue.dependencyNote ? ` — ${issue.dependencyNote}` : ''}
          </Text>
        ) : null}
        {issue.activityNotes?.trim() ? (
          <>
            <SectionHeader label="Notes" />
            <Text style={styles.notes} selectable>
              {issue.activityNotes.trim()}
            </Text>
          </>
        ) : null}

        <SectionHeader label={`Sessions (${sessions.length})`} />
        {sessions.length === 0 ? (
          <Text style={styles.noSessions}>No active sessions on this task.</Text>
        ) : (
          sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              model={sessionCardModel(session, undefined, now)}
              onPress={() => router.push(`/session/${session.sessionId}`)}
            />
          ))
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start agent on this task"
          disabled={starting}
          onPress={() => void startAgent()}
          style={({ pressed }) => [
            styles.startBtn,
            (pressed || starting) && styles.startBtnPressed,
          ]}
        >
          <Text style={styles.startText}>
            {starting ? 'Starting…' : 'Start agent on this task'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start a custom session on this task"
          onPress={() =>
            router.push(
              `/new-session?issueId=${encodeURIComponent(issue.id)}&cwd=${encodeURIComponent(issue.worktreePath ?? issue.repoPath)}`,
            )
          }
          style={styles.customLink}
        >
          <Text style={styles.customLinkText}>Custom session…</Text>
        </Pressable>

        <SectionHeader label={`Comments (${(issue.comments ?? []).length})`} />
        {(issue.comments ?? []).map((comment) => (
          <View key={comment.id} style={styles.comment}>
            <View style={styles.commentHead}>
              <Text style={styles.commentAuthor}>{comment.author}</Text>
              <Text style={styles.commentTime}>{relativeTime(comment.createdAt, now)}</Text>
            </View>
            <Text style={styles.commentBody} selectable>
              {comment.body}
            </Text>
          </View>
        ))}
      </ScrollView>
      <Composer placeholder="Comment on this task…" onSend={(text) => void addComment(text)} />
      <ActionSheet
        visible={stageMenuOpen}
        title="Stage"
        actions={ISSUE_STAGES.map((stage) => ({
          label: stage.replace('_', ' '),
          onPress: () => void setStage(stage),
        }))}
        onClose={() => setStageMenuOpen(false)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: space.md,
    paddingBottom: space.xxl,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  description: {
    color: color.textDim,
    fontSize: font.body,
    lineHeight: 21,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  blocked: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  notes: {
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 19,
    paddingHorizontal: space.lg,
  },
  noSessions: {
    color: color.textFaint,
    fontSize: font.small,
    paddingHorizontal: space.lg,
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  startBtn: {
    marginHorizontal: space.lg,
    marginTop: space.lg,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    alignItems: 'center',
    paddingVertical: space.md,
  },
  startBtnPressed: {
    opacity: 0.85,
  },
  startText: {
    color: color.accentText,
    fontSize: font.body,
    fontWeight: '700',
  },
  customLink: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  customLinkText: {
    color: color.accent,
    fontSize: font.small,
    fontWeight: '600',
  },
  comment: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    backgroundColor: color.card,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    padding: space.md,
    gap: 4,
  },
  commentHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  commentAuthor: {
    color: color.accent,
    fontSize: font.tiny,
    fontWeight: '700',
  },
  commentTime: {
    color: color.textFaint,
    fontSize: font.tiny,
  },
  commentBody: {
    color: color.text,
    fontSize: font.small,
    lineHeight: 19,
  },
})
