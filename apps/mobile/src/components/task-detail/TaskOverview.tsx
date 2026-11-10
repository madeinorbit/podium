import { modelLabel } from '@podium/client-core/agent-models'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { artifactKind, motionPhase, sessionTitle } from '@podium/client-core/values'
import type { IssuePanelArtifact, SessionId, SessionOffer } from '@podium/model'
import { isFinished } from '@podium/model/browser'
import { type ReactNode, useState } from 'react'
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native'
import { authenticatedImageSource } from '../../client/authenticated-assets'
import { useHttpOrigin } from '../../client/hooks'
import { issueObserver as observer } from '../../client/issue-observer'
import { useServerProfile } from '../../client/ServerProfileGate'
import { useOptionalServerProfile } from '../../client/server-profile-context'
import { issueArtifactHref, issueArtifactLabel } from '../../lib/issue-artifacts'
import { adaptiveColor, color, font, leading, sans, space } from '../../theme/theme'
import { ArtifactViewer } from '../ArtifactViewer'
import { Icon } from '../Icon'
import { ChevronDown, ChevronRight, FileText, MessagesSquare, Play } from '../icons'
import { PressableScale } from '../PressableScale'
import { composeOfferPrompt } from '../SessionActionCard'
import { Disclosure } from './chrome'
import { PromptSheet } from './PromptSheet'

/**
 * THE TOP OF THE TASK PAGE, in the board's order: what the task is waiting on
 * (the summary and the lead session's own offer buttons), what it produced
 * (the artifact strip), and who is on it (the session rows). Activity and the
 * reference sections follow below, in `IssueScreen`.
 *
 * Nothing here is a new fact: the summary is `issue.activityNotes` (what
 * `podium issue state` writes), the buttons are the lead session's existing
 * `SessionOffer` — accepting one is the same chat send the transcript makes —
 * and the artifacts are `issue.panel.artifacts`.
 */

/** The session that leads the page: the one asking (an open offer), then the
 *  coordinator, then the first agent session. */
export function leadSession(
  issue: Pick<IssueViewModel, 'coordinatorSessionId'>,
  sessions: readonly SessionView[],
): SessionView | undefined {
  return (
    sessions.find((s) => s.offer) ??
    sessions.find((s) => s.sessionId === issue.coordinatorSessionId) ??
    sessions[0]
  )
}

/**
 * A reference section below Activity: a chevron header, folded until opened.
 * The fold is the page visit's own; the task page leads with what moves.
 */
export function FoldedSection({
  label,
  count,
  children,
  testID,
}: {
  label: string
  count?: string
  children: ReactNode
  testID?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Disclosure
      label={label}
      count={count}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      {...(testID ? { testID } : {})}
    >
      {children}
    </Disclosure>
  )
}

/** A group heading on the card's axis, with an optional count and trailing control. */
export function GroupHeading({
  label,
  count,
  trailing,
}: {
  label: string
  count?: number
  trailing?: ReactNode
}) {
  return (
    <View style={styles.heading} accessibilityRole="header">
      <View style={styles.headingGutter}>
        <Icon as={ChevronDown} size={14} color={color.textFaint} />
      </View>
      <Text style={styles.headingLabel}>{label}</Text>
      {count !== undefined ? <Text style={styles.headingCount}>{count}</Text> : null}
      <View style={styles.spacer} />
      {trailing}
    </View>
  )
}

/**
 * The summary card: the task's state paragraph, then the lead session's offer
 * buttons (primary first) and a chat button that opens that session. Hidden
 * when there is neither a paragraph nor a session to talk to.
 */
export const TaskSummary = observer(function TaskSummary({
  issue,
  lead,
  onAccept,
  onOpenSession,
  onComment,
}: {
  issue: IssueViewModel
  lead: SessionView | undefined
  /** Send the chosen action's prompt to the session that offered it. */
  onAccept: (sessionId: SessionId, prompt: string) => Promise<void>
  onOpenSession: (sessionId: SessionId) => void
  /** With no session to open, the chat button posts on the task instead (the
   *  send path the page's old composer used, @mentions included). */
  onComment: (text: string) => void
}) {
  // An accept hides the buttons on the press, keyed by the offer it answered,
  // so a replacement offer that arrives meanwhile still shows.
  const [answered, setAnswered] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [asking, setAsking] = useState<SessionOffer['actions'][number] | null>(null)
  const [commenting, setCommenting] = useState(false)
  const notes = issue.activityNotes?.trim()
  const offer = lead?.offer && lead.offer.createdAt !== answered ? lead.offer : null
  const headline = offer?.message.split('\n')[0]?.trim()
  // Nothing to say and nothing asked: the session row below already opens the
  // chat, so the card is left out. With no session it stays as the way to post.
  if (!notes && !headline && lead) return null

  const send = async (prompt: string) => {
    if (!lead || !offer) return
    setFailed(null)
    setAnswered(offer.createdAt)
    try {
      await onAccept(lead.sessionId, prompt)
    } catch (error) {
      setAnswered(null)
      setFailed(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <View style={styles.card} testID="task-summary">
      {notes || headline ? (
        <Text style={styles.summary} selectable>
          {notes || headline}
        </Text>
      ) : null}
      {
        <View
          style={[
            styles.buttons,
            !offer?.actions.length && styles.buttonsTrailing,
            !(notes || headline) && styles.buttonsAlone,
          ]}
        >
          {offer?.actions.map((action, index) => (
            <PressableScale
              // Offer actions carry no id, and the list is fixed per offer.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional by contract
              key={`${index}:${action.label}`}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityHint={action.input ? 'Asks for your feedback first' : undefined}
              onPress={() => (action.input ? setAsking(action) : void send(action.prompt))}
              style={({ pressed }) => [
                styles.button,
                styles.buttonGrow,
                index === 0 && styles.buttonPrimary,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text
                style={[styles.buttonText, index === 0 && styles.buttonPrimaryText]}
                numberOfLines={1}
              >
                {action.label}
              </Text>
            </PressableScale>
          ))}
          {
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={lead ? 'Open chat' : 'Comment'}
              accessibilityHint={lead ? undefined : 'Post on this task, or @mention an agent'}
              onPress={() => (lead ? onOpenSession(lead.sessionId) : setCommenting(true))}
              hitSlop={6}
              style={({ pressed }) => [
                styles.button,
                notes || headline ? styles.buttonSquare : styles.buttonGrow,
                pressed && styles.buttonPressed,
              ]}
            >
              <Icon as={MessagesSquare} size={16} color={color.text} />
              {/* Alone in the card (no session, nothing said): name the act. */}
              {notes || headline ? null : (
                <Text style={styles.buttonText}>Comment on this task</Text>
              )}
            </PressableScale>
          }
        </View>
      }
      {failed ? (
        <Text style={styles.failed} accessibilityLiveRegion="polite">
          Not sent: {failed}
        </Text>
      ) : null}
      <PromptSheet
        visible={asking !== null}
        title={asking?.label ?? ''}
        hint="Your feedback is sent with this answer."
        placeholder="Add your feedback…"
        confirmLabel="Send"
        onConfirm={(feedback) => {
          if (asking) void send(composeOfferPrompt(asking.prompt, feedback))
        }}
        onClose={() => setAsking(null)}
      />
      <PromptSheet
        visible={commenting}
        title="Comment"
        hint="Posted on this task. @mention an agent to reach it."
        placeholder="Comment, or @mention an agent…"
        confirmLabel="Post"
        onConfirm={(text) => {
          if (text.trim()) onComment(text)
        }}
        onClose={() => setCommenting(false)}
      />
    </View>
  )
})

/** How many thumbnails the strip draws before "See all" carries the rest. */
const STRIP = 5

/**
 * The artifact strip: the first five as 72×90 thumbnails, the count, and
 * "See all", which opens the full list (`children`, the existing panel).
 */
export const ArtifactStrip = observer(function ArtifactStrip({
  issue,
  children,
}: {
  issue: IssueViewModel
  /** The full artifact list, shown under the strip after "See all". */
  children: ReactNode
}) {
  const httpOrigin = useHttpOrigin()
  const profile = useOptionalServerProfile()
  const workspace = profile?.config.workspaceId ?? profile?.config.workspaceSlug
  const [all, setAll] = useState(false)
  const artifacts = issue.panel?.artifacts ?? []
  if (artifacts.length === 0) return null
  return (
    <View testID="task-artifacts">
      <GroupHeading
        label="Artifacts"
        count={artifacts.length}
        trailing={
          artifacts.length > STRIP || all ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={all ? 'Show fewer artifacts' : 'See all artifacts'}
              onPress={() => setAll((open) => !open)}
              hitSlop={8}
              style={styles.headingAction}
            >
              <Text style={styles.headingActionText}>{all ? 'Show less' : 'See all'}</Text>
            </PressableScale>
          ) : null
        }
      />
      {all ? (
        children
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.card}
          contentContainerStyle={styles.strip}
        >
          {artifacts.slice(0, STRIP).map((artifact) => (
            <Thumbnail
              key={`${artifact.addedAt}:${artifact.path}`}
              artifact={artifact}
              url={issueArtifactHref(issue, artifact, httpOrigin, workspace)}
            />
          ))}
        </ScrollView>
      )}
    </View>
  )
})

const Thumbnail = observer(function Thumbnail({
  artifact,
  url,
}: {
  artifact: IssuePanelArtifact
  url: string | null
}) {
  const { bearer } = useServerProfile()
  const [broken, setBroken] = useState(false)
  const [open, setOpen] = useState(false)
  const kind = artifactKind(artifact.entry ?? artifact.path)
  const label = issueArtifactLabel(artifact)
  const image = url !== null && !broken && kind === 'image'
  return (
    <>
      <PressableScale
        accessibilityRole={url ? 'button' : undefined}
        accessibilityLabel={url ? `Open ${label}` : label}
        disabled={!url}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.thumb, pressed && styles.buttonPressed]}
      >
        {image ? (
          <Image
            source={authenticatedImageSource(url, bearer)}
            style={styles.thumbImage}
            resizeMode="cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <View style={styles.thumbFile}>
            <Icon as={kind === 'video' ? Play : FileText} size={16} color={color.textDim} />
            <Text style={styles.thumbLabel} numberOfLines={3}>
              {label}
            </Text>
          </View>
        )}
      </PressableScale>
      {open ? (
        <ArtifactViewer artifact={artifact} url={url} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
})

const PHASE_WORD: Record<string, string> = {
  working: 'working',
  waiting: 'needs you',
  queued: 'idle',
  done: 'done',
}
const PHASE_RANK: Record<string, number> = { working: 0, waiting: 1, queued: 2, done: 3 }
/** Session rows drawn before the Details roster carries the rest. */
const SHOWN_SESSIONS = 3

/** The session rows: name, then model and state ("Opus 5.5 · idle"), lead first. */
export const TaskSessions = observer(function TaskSessions({
  issue,
  sessions,
  lead,
  onOpenSession,
}: {
  issue: IssueViewModel
  sessions: readonly SessionView[]
  lead: SessionView | undefined
  onOpenSession: (sessionId: SessionId) => void
}) {
  if (sessions.length === 0) return null
  const finished = isFinished(issue)
  const ranked = sessions
    .map((session) => ({
      session,
      phase: finished ? 'done' : motionPhase(session, issue),
    }))
    .sort(
      (a, b) =>
        Number(b.session === lead) - Number(a.session === lead) ||
        (PHASE_RANK[a.phase] ?? 9) - (PHASE_RANK[b.phase] ?? 9),
    )
  const shown = ranked.slice(0, SHOWN_SESSIONS)
  const rest = ranked.length - shown.length
  return (
    <View testID="task-sessions">
      <GroupHeading
        label={sessions.length === 1 ? 'Session' : 'Sessions'}
        count={sessions.length > 1 ? sessions.length : undefined}
      />
      <View style={styles.card}>
        {shown.map(({ session, phase }, index) => {
          const name = sessionTitle(session)
          const meta = `${modelLabel(session.agentKind, session.model)} · ${PHASE_WORD[phase] ?? phase}`
          return (
            <PressableScale
              key={session.sessionId}
              accessibilityRole="button"
              accessibilityLabel={`${name}, ${meta}`}
              accessibilityHint="Opens the session"
              onPress={() => onOpenSession(session.sessionId)}
              scaleTo={1}
              style={({ pressed }) => [styles.sessionRow, pressed && styles.rowPressed]}
            >
              {index > 0 ? <View style={styles.separator} /> : null}
              <View style={styles.gutter}>
                <View
                  style={[
                    styles.phaseDot,
                    phase === 'working' && { backgroundColor: color.workingText },
                    phase === 'waiting' && { backgroundColor: color.needsYouText },
                  ]}
                />
              </View>
              <Text style={styles.sessionName} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.sessionMeta} numberOfLines={1}>
                {meta}
              </Text>
              <Icon as={ChevronRight} size={14} color={color.textFaint} />
            </PressableScale>
          )
        })}
        {rest > 0 ? (
          <View style={styles.sessionRow}>
            <View style={styles.separator} />
            <View style={styles.gutter} />
            <Text style={styles.sessionMeta}>{rest} more in Details</Text>
          </View>
        ) : null}
      </View>
    </View>
  )
})

/** Text on the accent fill: white on light bronze, ink on dark bisque. */
const ON_ACCENT = adaptiveColor('#ffffff', '#16171a', '#ffffff', '#16171a')

const styles = StyleSheet.create({
  heading: {
    minHeight: 28,
    marginTop: space.lg,
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  headingGutter: { width: 14, alignItems: 'center' },
  headingLabel: { ...sans(600), color: color.textDim, fontSize: font.tiny },
  headingCount: { ...sans(400), color: color.textFaint, fontSize: 12 },
  headingAction: { minHeight: 28, justifyContent: 'center' },
  headingActionText: { ...sans(400), color: color.textFaint, fontSize: font.tiny },
  spacer: { flex: 1 },
  card: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: color.surface,
  },
  summary: {
    ...sans(400),
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  buttons: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.xs,
    paddingBottom: space.md,
  },
  button: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: 6,
    backgroundColor: color.surfacePressed,
  },
  buttonsTrailing: { justifyContent: 'flex-end' },
  buttonsAlone: { paddingTop: space.md },
  buttonGrow: { flex: 1 },
  buttonSquare: { width: 44, paddingHorizontal: 0 },
  buttonPrimary: { backgroundColor: color.accentTint },
  buttonPressed: { opacity: 0.7 },
  buttonText: { ...sans(500), color: color.text, fontSize: 14 },
  buttonPrimaryText: { color: ON_ACCENT },
  failed: {
    ...sans(400),
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    color: color.dangerText,
    fontSize: font.tiny,
  },
  strip: {
    flexDirection: 'row',
    gap: 6,
    padding: space.md,
  },
  thumb: {
    width: 72,
    height: 90,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: color.surfacePressed,
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbFile: { flex: 1, padding: space.sm, gap: space.xs },
  thumbLabel: { ...sans(400), color: color.textDim, fontSize: 10, lineHeight: 13 },
  sessionRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
  },
  rowPressed: { backgroundColor: color.surfacePressed },
  separator: {
    position: 'absolute',
    top: 0,
    left: 34,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  gutter: { width: 14, alignItems: 'center' },
  phaseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.textFaint },
  sessionName: { ...sans(400), flex: 1, minWidth: 0, color: color.text, fontSize: font.small },
  sessionMeta: { ...sans(400), color: color.textFaint, fontSize: 12 },
})
