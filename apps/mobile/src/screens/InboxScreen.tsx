import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { pendingAskFromState, sessionCardModel } from '@podium/client-core/values'

import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useMobilePool } from '../client/mobile-pool'
import { issuePages } from '@podium/client-graph/issue-page'
import { LOADING } from '@podium/client-graph/loading'
import { issueObserver } from '../client/issue-observer'
import { useMemo } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useStoreActions, useTrpc } from '../client/hooks'
import { useInboxData } from '../client/use-inbox-data'
import { AskQuestionCard } from '../components/AskQuestionCard'
import { Icon } from '../components/Icon'
import { Inbox as InboxIcon, Settings } from '../components/icons'
import { BootstrapCrossfade, WorkSkeleton } from '../components/LaunchPlaceholders'
import { NewWorkButton } from '../components/NewWorkButton'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { RefreshOffer } from '../components/RefreshOffer'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { CountPill } from '../components/StatusGlyphs'
import { StorageNoticeAlert } from '../components/StorageNoticeAlert'
import { EmptyState } from '../components/ui'
import { useContentBottomInset } from '../hooks/useContentBottomInset'
import { usePendingQuestion } from '../hooks/usePendingQuestion'
import { useRefreshableList } from '../hooks/useRefreshableTab'
import { sessionHref } from '../lib/session-route'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

/**
 * A needs-you card that can be answered without leaving the Inbox: when the
 * agent is blocked on an AskUserQuestion, the options render inline.
 */
const NeedsYouCard = issueObserver(function NeedsYouCard({
  session,
  issue,
  now,
}: {
  session: SessionView
  issue: IssueViewModel | undefined
  now: number
}) {
  const router = useRouter()
  const trpc = useTrpc()
  const continueSession = useStoreActions().continueSession
  const needsQuestion = session.agentState?.phase === 'needs_user'
  const fromTranscript = usePendingQuestion(
    session.sessionId,
    needsQuestion,
    session.agentState?.since,
  )
  // Claude Code writes an AskUserQuestion into its transcript only once the call
  // RESOLVES, so for the whole time the agent is actually waiting the fetch above
  // finds nothing — and this card, the one surface built for answering from the
  // phone, had nothing to draw (POD-1273). The hook channel announced the whole
  // interview when the dialog opened; take it from state whenever the transcript
  // is still silent. A daemon too old to carry `need.interview` yields nothing
  // here and the fetch stays the only source, exactly as before.
  const fromState = pendingAskFromState(
    session.agentState?.need,
    session.status,
    session.agentState?.phase,
    fromTranscript !== null,
  )
  const pending = fromTranscript ?? fromState?.item ?? null
  const retryable = session.agentState?.phase === 'errored' && session.agentState.error?.retryable
  const base = sessionCardModel(session, issue, now)
  // The inline question card repeats the summary verbatim — drop the quote then.
  const model = pending ? { ...base, summary: null } : base

  return (
    <ObservedSessionCard
      model={model}
      issue={issue}
      session={session}
      agentColor={session.agentColor}
      onPress={() => router.push(sessionHref(session.sessionId, '/work'))}
    >
      {pending ? (
        <View style={styles.inlineQuestion}>
          <AskQuestionCard
            item={pending}
            live
            onAnswer={async (answer) => {
              const sent = await trpc.sessions.answerAskUserQuestion.mutate({
                sessionId: session.sessionId,
                ...answer,
              })
              if (sent?.ok === false) throw new Error(sent.reason ?? 'answer not delivered')
            }}
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
    </ObservedSessionCard>
  )
})

export const InboxSessionRow = issueObserver(function InboxSessionRow({
  id,
  needsYou = false,
  onLongPress,
}: {
  id: string
  needsYou?: boolean
  onLongPress?: (issueId: string) => void
}) {
  const pool = useMobilePool()
  const router = useRouter()
  if (!pool) return null
  const session = pool.sessionObject(id) as unknown as SessionView
  const issue = session.issueId ? issuePages(pool).issue(session.issueId) : undefined
  if (issue === LOADING) throw LOADING
  if (needsYou) return <NeedsYouCard session={session} issue={issue} now={Date.now()} />
  return (
    <ObservedSessionCard
      model={sessionCardModel(session, issue, Date.now())}
      issue={issue}
      session={session}
      agentColor={session.agentColor}
      onPress={() => router.push(sessionHref(session.sessionId, '/work'))}
      onLongPress={issue && onLongPress ? () => onLongPress(issue.id) : undefined}
    />
  )
})
const ObservedSessionCard = issueObserver(SessionCard)

function inboxSubtitle(needsYou: number, working: number, connected: boolean): string {
  if (!connected) return 'reconnecting…'
  if (needsYou > 0) return `${needsYou} waiting on you · ${working} working`
  if (working > 0) return `all clear · ${working} agent${working > 1 ? 's' : ''} working`
  return 'all clear'
}

export const InboxScreen = observer(function InboxScreen() {
  const router = useRouter()
  const { groups, booting, outboxSize } = useInboxData()
  const { connected, onRefresh, refreshing, refreshControl, refreshAccessibilityProps } =
    useRefreshableList()
  const bottomInset = useContentBottomInset()

  const sections = useMemo(
    () =>
      [
        { key: 'needsYou' as const, title: 'Needs you', data: groups.needsYou },
        { key: 'idle' as const, title: 'Idle', data: groups.idle },
        { key: 'working' as const, title: 'Working', data: groups.working },
      ].filter((s) => s.data.length > 0),
    [groups],
  )

  return (
    <Screen
      large
      title="Inbox"
      subtitle={inboxSubtitle(groups.needsYou.length, groups.working.length, connected)}
      right={
        <>
          {outboxSize > 0 ? <Text style={styles.queued}>{outboxSize} queued</Text> : null}
          <NewWorkButton />
          <HeaderButton label="Settings" onPress={() => router.push('/settings')}>
            <Icon as={Settings} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      {/* Never silent (ADR 6 D4.4): queued work a storage migration could not
          attribute to this account, and storage degradation, are both things the
          user is owed rather than log lines. */}
      <StorageNoticeAlert />
      {/* The phone's own interface is replaced whenever an update lands, by
          someone who was not holding this phone (spec §8c decision 11). */}
      <RefreshOffer />
      <BootstrapCrossfade resolved={!booting} placeholder={<WorkSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <SectionList
            sections={sections}
            keyExtractor={(id) => id}
            stickySectionHeadersEnabled={false}
            refreshControl={refreshControl}
            {...refreshAccessibilityProps}
            renderSectionHeader={({ section }) => (
              <View style={styles.sectionHeader}>
                <Text
                  style={[styles.sectionLabel, section.key === 'needsYou' && styles.needsYouLabel]}
                >
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
            renderItem={({ item: id, section }) => (
              <InboxSessionRow id={id} needsYou={section.key === 'needsYou'} />
            )}
            ListEmptyComponent={
              // Guarded on `booting` even though the crossfade covers this
              // screen: ListEmptyComponent is rendered by the list whenever its
              // data is empty, with no notion of whether loading has finished, so
              // without this the empty state is CONSTRUCTED during bootstrap and
              // sits in the tree — and in the accessibility tree — underneath an
              // opaque placeholder. The crossfade stops it being SEEN; this stops
              // it being built. Related conditions, not the same one.
              booting ? null : (
                <EmptyState
                  icon={<Icon as={InboxIcon} size={26} color={color.textFaint} />}
                  title="Inbox zero"
                  body="No agents are waiting on you. Start a session or hand something to the superagent."
                />
              )
            }
            contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + space.lg }]}
          />
        </PullToRefreshBoundary>
      </BootstrapCrossfade>
    </Screen>
  )
})

const styles = StyleSheet.create({
  // Bottom padding is paid inline from useContentBottomInset: the last card has
  // to scroll clear of the tab bar, whose height is a runtime measurement, not
  // a constant.
  listContent: {
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
    ...monoLabel(),
    color: color.label,
  },
  needsYouLabel: {
    color: color.needsYouText,
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
    color: color.needsYouText,
    fontSize: font.tiny,
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
