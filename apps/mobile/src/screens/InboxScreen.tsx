import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Inbox as InboxIcon, Plus, Settings } from 'lucide-react-native'
import { useMemo } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { AskQuestionCard } from '../components/AskQuestionCard'
import { Icon } from '../components/Icon'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { CountPill } from '../components/StatusGlyphs'
import { EmptyState } from '../components/ui'
import { usePendingQuestion } from '../hooks/usePendingQuestion'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

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
  const base = sessionCardModel(session, issue, now)
  // The inline question card repeats the summary verbatim — drop the quote then.
  const model = pending ? { ...base, summary: null } : base

  return (
    <SessionCard
      model={model}
      issue={issue}
      agentColor={session.agentColor}
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
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Continue after error"
          onPress={() => void continueSession(session.sessionId)}
          style={styles.continueBtn}
        >
          <Text style={styles.continueText}>Continue</Text>
        </PressableScale>
      ) : null}
    </SessionCard>
  )
}

function inboxSubtitle(needsYou: number, working: number, connected: boolean): string {
  if (!connected) return 'reconnecting…'
  if (needsYou > 0) return `${needsYou} waiting on you · ${working} working`
  if (working > 0) return `all clear · ${working} agent${working > 1 ? 's' : ''} working`
  return 'all clear'
}

export function InboxScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const now = Date.now()

  const groups = useMemo(() => groupSessions(withoutShells(client.sessions)), [client.sessions])
  const sections = useMemo(
    () =>
      [
        { key: 'needsYou' as const, title: 'Needs you', data: groups.needsYou },
        { key: 'idle' as const, title: 'Idle', data: groups.idle },
        { key: 'working' as const, title: 'Working', data: groups.working },
      ].filter((s) => s.data.length > 0),
    [groups],
  )

  const issueFor = (session: SessionMeta): IssueWire | undefined =>
    session.issueId ? client.issueById(session.issueId) : undefined

  return (
    <Screen
      large
      title="Inbox"
      subtitle={inboxSubtitle(groups.needsYou.length, groups.working.length, client.connected)}
      right={
        <>
          {client.outboxSize > 0 ? (
            <Text style={styles.queued}>{client.outboxSize} queued</Text>
          ) : null}
          <HeaderButton label="New session" onPress={() => router.push('/new-session')}>
            <Icon as={Plus} size={19} color={color.text} />
          </HeaderButton>
          <HeaderButton label="Settings" onPress={() => router.push('/settings')}>
            <Icon as={Settings} size={17} color={color.textDim} />
          </HeaderButton>
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
            {section.key === 'needsYou' ? (
              <CountPill count={section.data.length} />
            ) : (
              <Text style={styles.sectionCountText}>{section.data.length}</Text>
            )}
            <View style={styles.sectionRule} />
          </View>
        )}
        renderItem={({ item: session, section }) =>
          section.key === 'needsYou' ? (
            <NeedsYouCard session={session} issue={issueFor(session)} now={now} />
          ) : (
            <SessionCard
              model={sessionCardModel(session, issueFor(session), now)}
              issue={issueFor(session)}
              agentColor={session.agentColor}
              onPress={() => router.push(`/session/${session.sessionId}`)}
            />
          )
        }
        ListEmptyComponent={
          <EmptyState
            icon={<Icon as={InboxIcon} size={26} color={color.textFaint} />}
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
    paddingBottom: 120,
    flexGrow: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingTop: space.lg,
    paddingBottom: 5,
  },
  sectionLabel: {
    ...monoLabel(9),
    color: color.label,
  },
  needsYouLabel: {
    color: color.needsYou,
  },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  sectionCountText: {
    ...mono(600),
    color: color.textFaint,
    fontSize: font.micro,
  },
  queued: {
    ...mono(600),
    color: color.needsYou,
    fontSize: font.tiny,
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.xl,
    paddingBottom: space.sm,
  },
  inlineQuestion: {
    marginTop: space.xs,
  },
  continueBtn: {
    marginTop: space.xs,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    paddingVertical: space.sm + 3,
  },
  continueText: {
    ...sans(700),
    color: color.onAccent,
    fontSize: font.small,
  },
})
