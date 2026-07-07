import { withoutShells } from '@podium/client-core/focus'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { EmptyState, Pill, SectionHeader } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'
import { sessionCardModel } from '../viewModels/sessionCard'

export function IssueScreen() {
  const params = useLocalSearchParams<{ issueId: string | string[] }>()
  const issueId = decodeURIComponent(
    Array.isArray(params.issueId) ? params.issueId[0] : (params.issueId ?? ''),
  )
  const router = useRouter()
  const client = useMobileClient()
  const issue = client.issueById(issueId)
  const now = Date.now()

  const sessions = useMemo(
    () => withoutShells(client.sessions).filter((s) => s.issueId === issueId && !s.archived),
    [client.sessions, issueId],
  )

  if (!issue) {
    return (
      <Screen title="Issue" onBack={() => router.back()}>
        <EmptyState title="Issue not found." />
      </Screen>
    )
  }

  return (
    <Screen title={`#${issue.seq} ${issue.title}`} onBack={() => router.back()}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.metaRow}>
          <Pill
            label={issue.stage.replace('_', ' ')}
            toneKey={issue.stage === 'in_progress' ? 'working' : undefined}
          />
          <Pill label={issue.type} />
          <Pill label={`P${issue.priority}`} />
          {issue.needsHuman ? <Pill label="needs human" toneKey="needsYou" /> : null}
          {issue.assignee ? <Pill label={issue.assignee} /> : null}
        </View>
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
          <Text style={styles.noSessions}>No active sessions on this issue.</Text>
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
          accessibilityLabel="Start a session on this issue"
          onPress={() =>
            router.push(
              `/new-session?issueId=${encodeURIComponent(issue.id)}&cwd=${encodeURIComponent(issue.worktreePath ?? issue.repoPath)}`,
            )
          }
          style={({ pressed }) => [styles.startBtn, pressed && styles.startBtnPressed]}
        >
          <Text style={styles.startText}>Start a session on this issue</Text>
        </Pressable>
      </ScrollView>
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
  startBtn: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
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
})
