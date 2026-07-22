import { groupSessions, relativeTime, withoutShells } from '@podium/client-core/focus'
import { artifactKind } from '@podium/client-core/viewmodels'
import type { IssuePanelArtifact, IssueWire, SessionMeta } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus, Settings } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { AskQuestionCard } from '../components/AskQuestionCard'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { HeaderButton, Screen } from '../components/Screen'
import { BrailleSpinner, CountPill } from '../components/StatusGlyphs'
import { TrayCard, type TrayCardActions } from '../components/TrayCard'
import { usePendingQuestion } from '../hooks/usePendingQuestion'
import { deriveTrayItems } from '../lib/derive-tray'
import { effectiveIssueColorHex, FLOW_SLATE, flow } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

/**
 * The Tray — home [POD-131]. The phone IS the engraved column: a GLOBAL
 * decision queue (never filtered, never re-sorted on selection — POD-129's
 * Scope Law) over a standing composer that speaks to the superagent ("an
 * inbox with a command line"). Decisions first, finished last, newest first
 * within each group. Empty means empty everywhere.
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
  const client = useMobileClient()
  const now = Date.now()
  const [lightbox, setLightbox] = useState<{ uri: string; label: string } | null>(null)

  const sessions = useMemo(() => withoutShells(client.sessions), [client.sessions])
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
  const items = useMemo(
    () =>
      deriveTrayItems(client.issues, null, undefined, now).filter(
        // A session's inline question card covers its issue's needsHuman card.
        (i) => !(i.kind === 'question' && askIssueIds.has(i.issue.id)),
      ),
    [client.issues, askIssueIds, now],
  )
  const decisions = items.filter((i) => i.kind !== 'finished')
  const finished = items.filter((i) => i.kind === 'finished')
  const needsYouCount = askSessions.length + erroredSessions.length + decisions.length

  const issueFor = (session: SessionMeta): IssueWire | undefined =>
    session.issueId ? client.issueById(session.issueId) : undefined

  const cardActions: TrayCardActions = {
    onOfferAction: (session, prompt) => void client.sendMessage(session.sessionId, prompt),
    onOpenSession: (session) => router.push(`/session/${session.sessionId}`),
    onOpenIssue: (issue) => router.push(`/issue/${encodeURIComponent(issue.id)}`),
    onResolve: (issue) => void client.trpc.issues.clearNeedsHuman.mutate({ id: issue.id }),
    onArchive: (issue) => void client.trpc.issues.archive.mutate({ id: issue.id }),
    onOpenArtifact: (issue, artifact: IssuePanelArtifact) => {
      const kind = artifactKind(artifact.entry ?? artifact.path)
      if (artifact.artifactId && kind === 'image') {
        setLightbox({
          uri: `${client.serverConfig.httpOrigin}/files/artifact/${encodeURIComponent(issue.id)}/${encodeURIComponent(artifact.artifactId)}/${artifact.entry ?? ''}`,
          label: artifact.title ?? artifact.path,
        })
      } else {
        router.push(`/issue/${encodeURIComponent(issue.id)}`)
      }
    },
  }

  const sendToSuperagent = async (text: string) => {
    await client.trpc.superagent.sendTurn.mutate({ threadId: 'global', text })
    // Conversation posture: the feed takes over once a turn is in flight.
    router.push('/superagent')
  }

  const empty = needsYouCount === 0 && finished.length === 0

  return (
    <Screen
      large
      title="Tray"
      subtitle={client.connected ? 'all tasks · newest first' : 'reconnecting…'}
      right={
        <>
          {needsYouCount > 0 ? <CountPill count={needsYouCount} /> : null}
          {workingCount > 0 ? (
            <View style={styles.workingChip}>
              <BrailleSpinner size={10} />
              <Text style={styles.workingText}>{workingCount} working</Text>
            </View>
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
      <View style={styles.queue}>
        <ScrollView contentContainerStyle={styles.queueContent}>
          {askSessions.map((session) => (
            <AskCard
              key={session.sessionId}
              session={session}
              issue={issueFor(session)}
              issues={client.issues}
              now={now}
              onAnswer={(choices) => client.answerQuestion(session.sessionId, choices)}
              onOpenSession={() => router.push(`/session/${session.sessionId}`)}
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
                  onPress={() => void client.continueSession(session.sessionId)}
                >
                  <Text style={styles.continueText}>Continue</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open session"
                  onPress={() => router.push(`/session/${session.sessionId}`)}
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
              issues={client.issues}
              httpOrigin={client.serverConfig.httpOrigin}
              actions={cardActions}
              now={now}
            />
          ))}
          {finished.map((item) => (
            <TrayCard
              key={`${item.kind}:${item.issue.id}:${item.since}`}
              item={item}
              issues={client.issues}
              httpOrigin={client.serverConfig.httpOrigin}
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
                <Text style={styles.emptyBody}>Fire off a task or tell the agents below.</Text>
              )}
            </View>
          ) : null}
        </ScrollView>
      </View>
      <View style={styles.composerWrap}>
        <Composer placeholder="Tell the agents…" onSend={(text) => void sendToSuperagent(text)} />
        <Text style={styles.ctx}>· ALL-TASKS CONTEXT</Text>
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
  composerWrap: {
    backgroundColor: color.bar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairlineBar,
    paddingBottom: 2,
  },
  ctx: {
    ...monoLabel(7.5),
    color: color.textMicro,
    textAlign: 'right',
    paddingHorizontal: space.md,
    paddingBottom: 4,
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
