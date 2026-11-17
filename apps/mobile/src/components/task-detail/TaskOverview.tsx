import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { artifactKind } from '@podium/client-core/values'
import type { IssuePanelArtifact, SessionId, SessionOffer } from '@podium/model'
import { type ReactNode, useState } from 'react'
import { Image, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { authenticatedImageSource } from '../../client/authenticated-assets'
import { useHttpOrigin } from '../../client/hooks'
import { issueObserver as observer } from '../../client/issue-observer'
import { useServerProfile } from '../../client/ServerProfileGate'
import { useOptionalServerProfile } from '../../client/server-profile-context'
import { issueArtifactHref, issueArtifactLabel } from '../../lib/issue-artifacts'
import { adaptiveColor, color, font, leading, sans, space } from '../../theme/theme'
import { ArtifactViewer, type ArtifactViewerItem } from '../ArtifactViewer'
import { Icon } from '../Icon'
import { FileText, MessagesSquare, Play } from '../icons'
import { PressableScale } from '../PressableScale'
import { composeOfferPrompt } from '../SessionActionCard'
import { Disclosure } from './chrome'
import { DetailText as Text } from './DetailText'
import { useDetailSize } from './detail-type'
import { PromptSheet } from './PromptSheet'

/** Reference content stays in native grouped disclosures. The visible sections
 * read the existing issue panel and shared session models.
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
  offer,
  onOpenSession,
  onComment,
}: {
  issue: IssueViewModel
  lead: SessionView | undefined
  /** Send the chosen action's prompt to the session that offered it. */
  onAccept: (sessionId: SessionId, prompt: string, offerCreatedAt: string) => Promise<void>
  /** The shared conversation owns offer dismissal and failure restoration. */
  offer: SessionOffer | null
  onOpenSession: (sessionId: SessionId) => void
  /** With no session to open, the chat button posts on the task instead (the
   *  send path the page's old composer used, @mentions included). */
  onComment: (text: string) => void
}) {
  const { fontScale } = useWindowDimensions()
  const size = useDetailSize()
  const [failed, setFailed] = useState<string | null>(null)
  const [asking, setAsking] = useState<{
    sessionId: SessionId
    createdAt: string
    action: SessionOffer['actions'][number]
  } | null>(null)
  const [commenting, setCommenting] = useState(false)
  const [notesExpanded, setNotesExpanded] = useState(false)
  const notes = issue.activityNotes?.trim()
  const headline = offer?.message.split('\n')[0]?.trim()
  // Session rows already open chat. An empty task gets the launch action;
  // comments remain in Activity.
  if (!notes && !headline && !asking && !failed) return null

  const send = async (sessionId: SessionId, createdAt: string, prompt: string) => {
    setFailed(null)
    if (lead?.sessionId !== sessionId || offer?.createdAt !== createdAt) {
      setFailed('This offer has changed. Open the current offer to answer it.')
      return
    }
    try {
      await onAccept(sessionId, prompt, createdAt)
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <View testID="task-summary">
      <GroupHeading label={offer ? 'Next step' : 'Update'} />
      <View style={styles.card}>
        {offer?.message ? (
          <Text style={[styles.summary, styles.offerMessage]} selectable>
            {offer.message}
          </Text>
        ) : null}
        {notes && notes !== offer?.message ? (
          <Text
            numberOfLines={notesExpanded ? undefined : 4}
            style={[styles.summary, offer?.message && styles.summaryAfterHeadline]}
            selectable
          >
            {notes}
          </Text>
        ) : null}
        {notes && notes !== offer?.message && !notesExpanded ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="More update"
            onPress={() => setNotesExpanded(true)}
            style={styles.more}
          >
            <Text style={styles.headingActionText}>More</Text>
          </PressableScale>
        ) : null}
        {
          <View
            style={[
              styles.buttons,
              fontScale > 1.3 && styles.buttonsStacked,
              !offer?.actions.length && styles.buttonsTrailing,
              !(notes || headline) && styles.buttonsAlone,
            ]}
          >
            {/* Alone in the card (no session, nothing said): a quiet line names
              the act beside the same compact button, as on the board. */}
            {notes || headline ? null : (
              <Text style={styles.aloneText}>
                No agent yet. Add a comment or @mention an agent.
              </Text>
            )}
            {offer?.actions.map((action, index) => (
              <PressableScale
                // Offer actions carry no id, and the list is fixed per offer.
                // biome-ignore lint/suspicious/noArrayIndexKey: positional by contract
                key={`${index}:${action.label}`}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityHint={action.input ? 'Asks for your feedback first' : undefined}
                onPress={() => {
                  if (!lead) return
                  if (action.input)
                    setAsking({ sessionId: lead.sessionId, createdAt: offer.createdAt, action })
                  else void send(lead.sessionId, offer.createdAt, action.prompt)
                }}
                style={({ pressed }) => [
                  styles.button,
                  styles.buttonGrow,
                  fontScale > 1.3 && styles.buttonStacked,
                  index === 0 && styles.buttonPrimary,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text style={[styles.buttonText, index === 0 && styles.buttonPrimaryText]}>
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
                  styles.buttonSquare,
                  { width: Math.max(44, size(16) + 24), minHeight: Math.max(44, size(16) + 24) },
                  pressed && styles.buttonPressed,
                ]}
              >
                <Icon as={MessagesSquare} size={size(16)} color={color.text} />
              </PressableScale>
            }
          </View>
        }
        {failed ? (
          <Text style={styles.failed} accessibilityLiveRegion="polite">
            Not sent: {failed}
          </Text>
        ) : null}
      </View>
      <PromptSheet
        visible={asking !== null}
        title={asking?.action.label ?? ''}
        hint="Your feedback is sent with this answer."
        placeholder="Add your feedback…"
        confirmLabel="Send"
        onConfirm={(feedback) => {
          if (asking)
            void send(
              asking.sessionId,
              asking.createdAt,
              composeOfferPrompt(asking.action.prompt, feedback),
            )
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
 * The artifact strip: previews with wrapping labels, the count, and
 * "See all", which opens the existing full list.
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
  const [openKey, setOpenKey] = useState<string | null>(null)
  const artifacts = issue.panel?.artifacts ?? []
  if (artifacts.length === 0) return null
  // The viewer pages through every openable artifact ("2 of 3"), not just the
  // five the strip draws, so a swipe reaches the rest.
  const items: ArtifactViewerItem[] = artifacts
    .map((artifact) => ({
      key: `${artifact.path}@${artifact.addedAt}`,
      artifact,
      url: issueArtifactHref(issue, artifact, httpOrigin, workspace),
    }))
    .filter((item) => item.url !== null)
  const openIndex = items.findIndex((item) => item.key === openKey)
  return (
    <View testID="task-artifacts">
      <GroupHeading
        label="Artifacts"
        count={artifacts.length}
        trailing={
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={all ? 'Show fewer artifacts' : 'See all artifacts'}
            onPress={() => setAll((open) => !open)}
            hitSlop={8}
            style={styles.headingAction}
          >
            <Text style={styles.headingActionText}>{all ? 'Show less' : 'See all'}</Text>
          </PressableScale>
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
          {artifacts.slice(0, STRIP).map((artifact) => {
            const key = `${artifact.path}@${artifact.addedAt}`
            return (
              <Thumbnail
                key={key}
                artifact={artifact}
                url={issueArtifactHref(issue, artifact, httpOrigin, workspace)}
                onOpen={() => setOpenKey(key)}
              />
            )
          })}
        </ScrollView>
      )}
      {openIndex >= 0 ? (
        <ArtifactViewer items={items} index={openIndex} onClose={() => setOpenKey(null)} />
      ) : null}
    </View>
  )
})

const Thumbnail = observer(function Thumbnail({
  artifact,
  url,
  onOpen,
}: {
  artifact: IssuePanelArtifact
  url: string | null
  onOpen: () => void
}) {
  const { bearer } = useServerProfile()
  const size = useDetailSize()
  const { fontScale } = useWindowDimensions()
  const [broken, setBroken] = useState(false)
  const kind = artifactKind(artifact.entry ?? artifact.path)
  const label = issueArtifactLabel(artifact)
  const image = url !== null && !broken && kind === 'image'
  return (
    <PressableScale
      accessibilityRole={url ? 'button' : undefined}
      accessibilityLabel={url ? `Open ${label}` : label}
      disabled={!url}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.thumb,
        { width: 96 * Math.max(1, fontScale) },
        pressed && styles.buttonPressed,
      ]}
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
          <Icon as={kind === 'video' ? Play : FileText} size={size(16)} color={color.textDim} />
        </View>
      )}
      <Text numberOfLines={2} ellipsizeMode="tail" style={styles.thumbLabel}>
        {label}
      </Text>
    </PressableScale>
  )
})

export { TaskSessions } from './TaskSessions'

/** Text on the accent fill: white on light bronze, ink on dark bisque. */
const ON_ACCENT = adaptiveColor('#ffffff', '#16171a', '#ffffff', '#16171a')

const styles = StyleSheet.create({
  more: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  heading: {
    minHeight: 20,
    marginBottom: space.sm,
    paddingLeft: 16,
    paddingRight: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  headingLabel: { ...sans(600), color: color.textDim, fontSize: font.tiny, flexShrink: 1 },
  headingCount: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    fontVariant: ['tabular-nums'],
  },
  headingAction: { minHeight: 44, justifyContent: 'center', marginVertical: -space.sm },
  headingActionText: { ...sans(400), color: color.accentTint, fontSize: font.small, flexShrink: 1 },
  spacer: { flex: 1 },
  card: {
    borderRadius: 8,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: color.groupedCard,
  },
  summary: {
    ...sans(400),
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: color.body,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  offerMessage: { ...sans(600), paddingBottom: space.xs },
  summaryAfterHeadline: { paddingTop: 0 },
  buttons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
  buttonsStacked: { flexDirection: 'column', alignItems: 'stretch' },
  button: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 6,
    backgroundColor: color.tertiaryFill,
  },
  buttonsTrailing: { justifyContent: 'flex-end' },
  buttonsAlone: { paddingTop: space.md, alignItems: 'center' },
  aloneText: { ...sans(400), flex: 1, color: color.textDim, fontSize: font.small },
  buttonGrow: { flexGrow: 1, flexShrink: 1, flexBasis: '32%' },
  buttonStacked: { flexGrow: 0, flexBasis: 'auto' },
  buttonSquare: { width: 44, paddingHorizontal: 0, alignSelf: 'flex-end' },
  buttonPrimary: { backgroundColor: color.accentTint },
  buttonPressed: { opacity: 0.7 },
  buttonText: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
    textAlign: 'center',
    flexShrink: 1,
  },
  buttonPrimaryText: { color: ON_ACCENT },
  failed: {
    ...sans(400),
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    color: color.dangerText,
    fontSize: font.small,
  },
  strip: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, padding: space.md },
  thumb: { gap: space.sm },
  thumbImage: { width: '100%', height: 88, borderRadius: 4, backgroundColor: color.tertiaryFill },
  thumbFile: {
    height: 88,
    padding: space.md,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: color.tertiaryFill,
    borderRadius: 4,
  },
  thumbLabel: { ...sans(400), color: color.body, fontSize: font.tiny },
  rowPressed: { backgroundColor: color.surfacePressed },
})
