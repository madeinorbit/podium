import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { pendingAskFromState, sessionCardModel } from '@podium/client-core/values'
import { readPageIssue } from '@podium/client-graph/issue-page'
import { LOADING } from '@podium/client-graph/loading'
import { useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import { issueObserver } from '../client/issue-observer'
import { useStoreActions, useTrpc } from '../client/hooks'
import { usePendingQuestion } from '../hooks/usePendingQuestion'
import { sessionHref } from '../lib/session-route'
import { color, font, radius, sans, space } from '../theme/theme'
import { AskQuestionCard } from './AskQuestionCard'
import { PressableScale } from './PressableScale'
import { SessionCard } from './SessionCard'

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
  const issue = session.issueId ? readPageIssue(pool, session.issueId) : undefined
  if (issue === LOADING) throw LOADING
  if (needsYou) return <NeedsYouCard session={session} issue={issue} now={0} />
  return (
    <ObservedSessionCard
      model={sessionCardModel(session, issue)}
      issue={issue}
      session={session}
      agentColor={session.agentColor}
      onPress={() => router.push(sessionHref(session.sessionId, '/work'))}
      onLongPress={issue && onLongPress ? () => onLongPress(issue.id) : undefined}
    />
  )
})
const ObservedSessionCard = issueObserver(SessionCard)

const styles = StyleSheet.create({
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
