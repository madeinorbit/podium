import { relativeTime, withoutShells } from '@podium/client-core/focus'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import { ISSUE_STAGES } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useIssue, useMobileStore, useSessions } from '../client/hooks'
import { ActionSheet } from '../components/ActionSheet'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { EmptyState, Pill, SectionHeader } from '../components/ui'
import { sessionHref } from '../lib/session-route'
import { color, font, leading, radius, sans, space } from '../theme/theme'

export function IssueScreen() {
  const params = useLocalSearchParams<{ issueId: string | string[] }>()
  const issueId = decodeURIComponent(
    Array.isArray(params.issueId) ? params.issueId[0] : (params.issueId ?? ''),
  )
  const router = useRouter()
  const trpc = useMobileStore().trpc
  const allSessions = useSessions()
  const issue = useIssue(issueId)
  const now = Date.now()
  const [stageMenuOpen, setStageMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  /**
   * Back, with somewhere to go [POD-402, the trap in POD-358].
   *
   * A bare `router.back()` is fine when you arrived by tapping a row and empty
   * when you did not — reload the app on a task URL, or open one from a
   * notification, and there is no history behind this screen. The chevron then
   * did nothing at all, which on a standalone PWA (no browser back, no browser
   * chrome) leaves the task view with no exit. SessionScreen already resolved
   * this the same way; this is the other half.
   */
  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/work')
  }, [router])

  const sessions = useMemo(
    () => withoutShells(allSessions).filter((s) => s.issueId === issueId && !s.archived),
    [allSessions, issueId],
  )

  if (!issue) {
    return (
      <Screen title="Task" onBack={goBack}>
        <EmptyState title="Task not found." />
      </Screen>
    )
  }

  const setStage = async (stage: (typeof ISSUE_STAGES)[number]) => {
    setError(null)
    try {
      await trpc.issues.update.mutate({ id: issue.id, patch: { stage } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // The recovery path for a task with nobody on it (POD-346): filed without
  // "start now", or started once and since finished. Without it the phone can
  // create work it cannot then get an agent onto.
  const startAgent = async () => {
    setError(null)
    setStarting(true)
    try {
      await trpc.issues.start.mutate({ id: issue.id })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const addComment = async (body: string) => {
    setError(null)
    try {
      await trpc.issues.addComment.mutate({ id: issue.id, author: 'mobile', body })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const addAgent = () => {
    const cwd = issue.worktreePath ?? issue.repoPath
    router.push(
      `/new-session?issueId=${encodeURIComponent(issue.id)}&cwd=${encodeURIComponent(cwd)}&backTo=${encodeURIComponent(`/issue/${encodeURIComponent(issue.id)}`)}`,
    )
  }

  return (
    <Screen
      title={`${issueDisplayRef(issue)} ${issue.title}`}
      onBack={goBack}
      right={
        <HeaderButton label="Add agent" onPress={addAgent}>
          <Icon as={Plus} size={17} color={color.text} />
        </HeaderButton>
      }
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.metaRow}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Stage ${issue.stage} — change`}
            onPress={() => setStageMenuOpen(true)}
          >
            <Pill
              label={`${issue.stage.replace('_', ' ')} ▾`}
              toneKey={issue.stage === 'in_progress' ? 'working' : undefined}
            />
          </PressableScale>
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
        {issue.blockedByNotes.length > 0 ? (
          <Text style={styles.blocked}>
            Blocked by {issue.blockedByNotes.length} issue
            {issue.blockedByNotes.length > 1 ? 's' : ''}
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
          <>
            <Text style={styles.noSessions}>No agent is on this task.</Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Start an agent on this task"
              disabled={starting}
              onPress={() => void startAgent()}
              style={({ pressed }) => [
                styles.startBtn,
                (starting || pressed) && styles.startBtnMuted,
              ]}
            >
              <Text style={styles.startText}>{starting ? 'Starting…' : 'Start an agent'}</Text>
            </PressableScale>
          </>
        ) : (
          sessions.map((session) => (
            <SessionCard
              key={session.sessionId}
              model={sessionCardModel(session, undefined, now)}
              onPress={() =>
                router.push(
                  sessionHref(session.sessionId, `/issue/${encodeURIComponent(issue.id)}`),
                )
              }
            />
          ))
        )}

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
    lineHeight: leading(font.body, 'prose'),
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
    lineHeight: leading(font.small, 'prose'),
    paddingHorizontal: space.lg,
  },
  noSessions: {
    color: color.textFaint,
    fontSize: font.small,
    paddingHorizontal: space.lg,
  },
  startBtn: {
    alignSelf: 'flex-start',
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: radius.sm,
    backgroundColor: color.accent,
  },
  startBtnMuted: {
    opacity: 0.55,
  },
  startText: {
    color: color.accentText,
    fontSize: font.small,
    ...sans(700),
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
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
    ...sans(700),
  },
  commentTime: {
    color: color.textFaint,
    fontSize: font.tiny,
  },
  commentBody: {
    color: color.text,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
})
