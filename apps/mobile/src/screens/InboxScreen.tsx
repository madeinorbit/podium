import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus, Settings } from 'lucide-react-native'
import { useMemo } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { AskQuestionCard } from '../components/AskQuestionCard'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { EmptyState } from '../components/ui'
import { usePendingQuestion } from '../hooks/usePendingQuestion'
import { color, font, radius, space } from '../theme/theme'
import { sessionCardModel } from '../viewModels/sessionCard'

/**
 * A needs-you card that can be answered without leaving the Inbox: when the
 * agent is blocked on an AskUserQuestion, the options render inline.
 */
function NeedsYouCard({
  session,
  issue,
  now,
}: {
  session: SessionMeta
  issue: IssueWire | undefined
  now: number
}) {
  const router = useRouter()
  const { answerQuestion, continueSession } = useMobileClient()
  const needsQuestion = session.agentState?.phase === 'needs_user'
  const pending = usePendingQuestion(session.sessionId, needsQuestion, session.agentState?.since)
  const retryable = session.agentState?.phase === 'errored' && session.agentState.error?.retryable

  return (
    <SessionCard
      model={sessionCardModel(session, issue, now)}
      onPress={() => router.push(`/session/${session.sessionId}`)}
    >
      {pending ? (
        <View style={styles.inlineQuestion}>
          <AskQuestionCard
            item={pending}
            live
            onAnswer={(choices) => answerQuestion(session.sessionId, choices)}
          />
        </View>
      ) : null}
      {retryable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue after error"
          onPress={() => void continueSession(session.sessionId)}
          style={styles.continueBtn}
        >
          <Text style={styles.continueText}>Continue</Text>
        </Pressable>
      ) : null}
    </SessionCard>
  )
}

export function InboxScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const now = Date.now()

  const sections = useMemo(() => {
    const groups = groupSessions(withoutShells(client.sessions))
    return [
      { key: 'needsYou' as const, title: 'Needs you', data: groups.needsYou },
      { key: 'idle' as const, title: 'Idle', data: groups.idle },
      { key: 'working' as const, title: 'Working', data: groups.working },
    ].filter((s) => s.data.length > 0)
  }, [client.sessions])

  const issueFor = (session: SessionMeta): IssueWire | undefined =>
    session.issueId ? client.issueById(session.issueId) : undefined

  return (
    <Screen
      title="Inbox"
      subtitle={client.connected ? undefined : 'reconnecting…'}
      right={
        <>
          {client.outboxSize > 0 ? (
            <Text style={styles.queued}>{client.outboxSize} queued</Text>
          ) : null}
          <View
            style={[
              styles.connDot,
              { backgroundColor: client.connected ? color.working : color.danger },
            ]}
            accessibilityLabel={client.connected ? 'Connected' : 'Disconnected'}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New session"
            onPress={() => router.push('/new-session')}
            hitSlop={8}
          >
            <Icon as={Plus} size={22} color={color.text} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => router.push('/settings')}
            hitSlop={8}
          >
            <Icon as={Settings} size={20} color={color.textDim} />
          </Pressable>
        </>
      }
    >
      {client.error ? <Text style={styles.error}>{client.error}</Text> : null}
      <SectionList
        sections={sections}
        keyExtractor={(session) => session.sessionId}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionLabel, section.key === 'needsYou' && styles.needsYouLabel]}>
              {section.title.toUpperCase()}
            </Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item: session, section }) =>
          section.key === 'needsYou' ? (
            <NeedsYouCard session={session} issue={issueFor(session)} now={now} />
          ) : (
            <SessionCard
              model={sessionCardModel(session, issueFor(session), now)}
              onPress={() => router.push(`/session/${session.sessionId}`)}
            />
          )
        }
        ListEmptyComponent={
          <EmptyState
            title="Inbox zero"
            body="No agents are waiting on you. Start a session or hand something to the superagent."
          />
        }
        contentContainerStyle={styles.listContent}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: space.xxl,
    flexGrow: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  sectionLabel: {
    color: color.textFaint,
    fontSize: font.tiny,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  needsYouLabel: {
    color: color.needsYou,
  },
  sectionCount: {
    color: color.textFaint,
    fontSize: font.tiny,
  },
  connDot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
  },
  queued: {
    color: color.needsYou,
    fontSize: font.tiny,
    fontWeight: '600',
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  inlineQuestion: {
    marginTop: space.sm,
  },
  continueBtn: {
    marginTop: space.sm,
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    alignItems: 'center',
    paddingVertical: space.sm + 2,
  },
  continueText: {
    color: color.accentText,
    fontSize: font.small,
    fontWeight: '700',
  },
})
