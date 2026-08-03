import { groupSessions, relativeTime, withoutShells } from '@podium/client-core/focus'
import { artifactKind, deriveTrayItems } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact, IssueWire, SessionMeta } from '@podium/model'
import { useRouter } from 'expo-router'
import { Settings } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useConnected, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { useMobileShell } from '../client/shell'
import { AskQuestionCard } from '../components/AskQuestionCard'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { NewWorkButton } from '../components/NewWorkButton'
import { HeaderButton, Screen } from '../components/Screen'
import { BrailleSpinner, CountPill } from '../components/StatusGlyphs'
import { TrayCard, type TrayCardActions } from '../components/TrayCard'
import { usePendingQuestion } from '../hooks/usePendingQuestion'
import { sessionHref } from '../lib/session-route'
import { effectiveIssueColorHex, FLOW_SLATE, flow } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, radius, sans, space } from '../theme/theme'

/**
 * The Tray — home [POD-131]. The phone IS the engraved column: a GLOBAL
 * decision queue (never filtered, never re-sorted on selection — POD-129's
 * Scope Law), deriving from the SAME model as the desktop column. Newest
 * first; nothing that isn't an open ask ever appears.
 * Super Agent chat lives in its own tab.
 */

/** A session blocked on an AskUserQuestion — the options render inline so it
 *  can be answered without leaving the queue. */
function AskCard({
  session,
  issue,
  issues,
  now,
  onAnswer,
  onOpenSession,
}: {
  session: SessionMeta
  issue: IssueWire | undefined
  issues: IssueWire[]
  now: number
  onAnswer: (choices: { optionIndices: number[] }[]) => Promise<void>
  onOpenSession: () => void
}) {
  const pending = usePendingQuestion(session.sessionId, true, session.agentState?.since)
  const flowHex = issue
    ? effectiveIssueColorHex(issue, (id) => issues.find((i) => i.id === id))
    : undefined
  const hex = flowHex ?? FLOW_SLATE
  return (
    <View
      style={[styles.askCard, { backgroundColor: flow.rowBg(hex), borderColor: alpha(hex, 0.4) }]}
    >
      <View style={styles.askTop}>
        {issue ? (
          <IdSquare issue={issue} state="waiting" size={18} ringColor={flow.rowBg(hex)} />
        ) : null}
        {issue ? <Text style={styles.askRef}>{`POD-${issue.seq}`}</Text> : null}
        <Text style={styles.askTitle} numberOfLines={1}>
          {session.name ?? session.title}
        </Text>
        <Text style={styles.askAgo}>
          {relativeTime(session.agentState?.since ?? session.lastActiveAt, now)}
        </Text>
      </View>
      {pending ? (
        <AskQuestionCard item={pending} live onAnswer={onAnswer} />
      ) : (
        <Text style={styles.askWaiting}>Waiting on you — open the session to answer.</Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open session"
        onPress={onOpenSession}
        hitSlop={8}
        style={styles.sessionLink}
      >
        <Text style={styles.sessionLinkText}>session →</Text>
      </Pressable>
    </View>
  )
}

export function TrayScreen() {
  const router = useRouter()
  const store = useMobileStore()
  const allSessions = useSessions()
  const issues = useIssues()
  const connected = useConnected()
  const { error } = useMobileShell()
  const now = Date.now()
  const [lightbox, setLightbox] = useState<{ uri: string; label: string } | null>(null)

  const sessions = useMemo(() => withoutShells(allSessions), [allSessions])
  const askSessions = useMemo(
    () => sessions.filter((s) => !s.archived && s.agentState?.phase === 'needs_user'),
    [sessions],
  )
  const erroredSessions = useMemo(
    () =>
      sessions.filter(
        (s) => !s.archived && s.agentState?.phase === 'errored' && s.agentState.error?.retryable,
      ),
    [sessions],
  )
  const workingCount = useMemo(() => groupSessions(sessions).working.length, [sessions])

  const askIssueIds = useMemo(
    () => new Set(askSessions.map((s) => s.issueId).filter(Boolean)),
    [askSessions],
  )
  // Exactly the desktop tray's contract (POD-338): the SAME derivation, global
  // scope, and no archive-cleanup cards — finished work is not attention
  // [POD-198], it is dismissed from the Work list's Closed fold.
  const decisions = useMemo(
    () =>
      deriveTrayItems(issues, sessions).filter(
        // A session's inline question card covers its issue's needsHuman card.
        (i) => !(i.kind === 'question' && askIssueIds.has(i.issue.id)),
      ),
    [issues, askIssueIds],
  )
  const needsYouCount = askSessions.length + erroredSessions.length + decisions.length

  const issueFor = (session: SessionMeta): IssueWire | undefined =>
    session.issueId ? issues.find((issue) => issue.id === session.issueId) : undefined

  const cardActions: TrayCardActions = {
    onOfferAction: (session, prompt) => void store.resumeAndSend(session.sessionId, prompt),
    onOpenSession: (session) => router.push(sessionHref(session.sessionId, '/')),
    onOpenIssue: (issue) => router.push(`/issue/${encodeURIComponent(issue.id)}`),
    onResolve: (issue) => void store.trpc.issues.clearNeedsHuman.mutate({ id: issue.id }),
    onOpenArtifact: (issue, artifact: IssuePanelArtifact) => {
      const kind = artifactKind(artifact.entry ?? artifact.path)
      if (artifact.artifactId && kind === 'image') {
        setLightbox({
          uri: `${store.httpOrigin}/files/artifact/${encodeURIComponent(issue.id)}/${encodeURIComponent(artifact.artifactId)}/${artifact.entry ?? ''}`,
          label: artifact.title ?? artifact.path,
        })
      } else {
        router.push(`/issue/${encodeURIComponent(issue.id)}`)
      }
    },
  }

  const empty = needsYouCount === 0

  return (
    <Screen
      large
      title="Tray"
      subtitle={connected ? 'all tasks · newest first' : 'reconnecting…'}
      right={
        <>
          {needsYouCount > 0 ? <CountPill count={needsYouCount} /> : null}
          {workingCount > 0 ? (
            <View style={styles.workingChip}>
              <BrailleSpinner size={10} />
              <Text style={styles.workingText}>{workingCount} working</Text>
            </View>
          ) : null}
          <NewWorkButton />
          <HeaderButton label="Settings" onPress={() => router.push('/settings')}>
            <Icon as={Settings} size={17} color={color.textDim} />
          </HeaderButton>
        </>
      }
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.queue}>
        <ScrollView contentContainerStyle={styles.queueContent}>
          {askSessions.map((session) => (
            <AskCard
              key={session.sessionId}
              session={session}
              issue={issueFor(session)}
              issues={issues}
              now={now}
              onAnswer={async (choices) => {
                await store.trpc.sessions.answerAskUserQuestion.mutate({
                  sessionId: session.sessionId,
                  choices,
                })
              }}
              onOpenSession={() => router.push(sessionHref(session.sessionId, '/'))}
            />
          ))}
          {erroredSessions.map((session) => (
            <View key={session.sessionId} style={styles.errorCard}>
              <Text style={styles.errorTitle} numberOfLines={1}>
                {session.name ?? session.title}
              </Text>
              <Text style={styles.errorBody} numberOfLines={2}>
                {session.agentState?.phase === 'errored' && session.agentState.error
                  ? `Agent error (${session.agentState.error.class}) — safe to continue.`
                  : 'Agent hit an error.'}
              </Text>
              <View style={styles.errorActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Continue after error"
                  style={styles.continueBtn}
                  onPress={() => void store.continueSession(session.sessionId)}
                >
                  <Text style={styles.continueText}>Continue</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open session"
                  onPress={() => router.push(sessionHref(session.sessionId, '/'))}
                  hitSlop={8}
                >
                  <Text style={styles.sessionLinkText}>session →</Text>
                </Pressable>
              </View>
            </View>
          ))}
          {decisions.map((item) => (
            <TrayCard
              key={`${item.kind}:${item.issue.id}:${item.since}`}
              item={item}
              issues={issues}
              sessions={sessions}
              httpOrigin={store.httpOrigin}
              actions={cardActions}
              now={now}
            />
          ))}
          {empty ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>✓ Nothing waiting on you — anywhere</Text>
              {workingCount > 0 ? (
                <View style={styles.workingChip}>
                  <BrailleSpinner size={11} />
                  <Text style={styles.workingText}>
                    {workingCount} agent{workingCount > 1 ? 's' : ''} working
                  </Text>
                </View>
              ) : (
                <Text style={styles.emptyBody}>Fire off a task or open Super Agent.</Text>
              )}
            </View>
          ) : null}
        </ScrollView>
      </View>
      <Modal
        transparent
        visible={lightbox !== null}
        animationType="fade"
        onRequestClose={() => setLightbox(null)}
      >
        <Pressable
          accessibilityLabel="Close preview"
          style={styles.lightbox}
          onPress={() => setLightbox(null)}
        >
          {lightbox ? (
            <>
              <Image
                source={{ uri: lightbox.uri }}
                style={styles.lightboxImg}
                resizeMode="contain"
              />
              <Text style={styles.lightboxLabel} numberOfLines={1}>
                {lightbox.label}
              </Text>
            </>
          ) : null}
        </Pressable>
      </Modal>
    </Screen>
  )
}

const styles = StyleSheet.create({
  queue: {
    flex: 1,
    backgroundColor: color.engraved,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineBar,
  },
  queueContent: {
    padding: 10,
    paddingBottom: 24,
    gap: 7,
    flexGrow: 1,
  },
  workingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  workingText: {
    ...mono(500),
    color: color.working,
    fontSize: font.micro,
  },
  error: {
    color: color.danger,
    fontSize: font.small,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  askCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 7,
  },
  askTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  askRef: {
    ...mono(500),
    color: color.textDim,
    fontSize: font.micro,
  },
  askTitle: {
    flex: 1,
    minWidth: 0,
    color: color.textDim,
    fontSize: font.tiny + 0.5,
  },
  askAgo: {
    ...mono(500),
    color: color.accent,
    fontSize: font.micro,
  },
  askWaiting: {
    color: color.textDim,
    fontSize: font.small,
  },
  sessionLink: {
    alignSelf: 'flex-end',
  },
  sessionLinkText: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  errorCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: alpha('#e5303f', 0.4),
    backgroundColor: color.dangerSoft,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 6,
  },
  errorTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  errorBody: {
    color: color.textDim,
    fontSize: font.small - 0.5,
  },
  errorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  continueBtn: {
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  continueText: {
    ...sans(600),
    color: color.onAccent,
    fontSize: font.small - 0.5,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingBottom: 40,
  },
  emptyTitle: {
    ...sans(500),
    color: color.body,
    fontSize: font.body,
  },
  emptyBody: {
    color: color.textFaint,
    fontSize: font.small,
  },
  lightbox: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  lightboxImg: {
    width: '94%',
    height: '80%',
  },
  lightboxLabel: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
})
