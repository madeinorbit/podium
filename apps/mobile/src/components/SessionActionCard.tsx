import type { IssueViewModel } from '@podium/client-core/replica'
import { segmentOfferText } from '@podium/client-core/values'
import type { SessionOffer } from '@podium/model'
import { useState } from 'react'
import { AccessibilityInfo, StyleSheet, Text, TextInput, View } from 'react-native'
import { followPodiumLink } from '../lib/podium-link'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { decisionTile } from './decision-tile'
import { Icon } from './Icon'
import { X } from './icons'
import { OfferArtifactStrip } from './OfferArtifactStrip'
import { PressableScale } from './PressableScale'

/** Compose an input action's prompt with the feedback collected in context. */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

function errorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim()
  return (message || fallback).replace(/[.!?]+$/, '')
}

/** A session offer uses the approved ChatAsk tile, with evidence above its actions. */
export function SessionActionCard({
  offer,
  issue,
  lastInputAt,
  onAction,
  onDismiss,
  onOpenEvidence,
}: {
  offer: SessionOffer
  /** The session's issue — what the offer's artifact paths resolve against. */
  issue?: IssueViewModel
  /** SessionMeta.lastInputAt, the freshness anchor for an offer naming no paths. */
  lastInputAt?: string
  onAction: (prompt: string) => Promise<void>
  /** Take the offer off every surface without answering it. Absent on a host
   *  that cannot write (the card then keeps its two original exits). */
  onDismiss?: (offerCreatedAt: string) => Promise<void>
  /** Open the task's full artifact list — reached from the strip's "+N" only. */
  onOpenEvidence?: () => void
}) {
  const [inputAction, setInputAction] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [sending, setSending] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [dismissFailed, setDismissFailed] = useState<string | null>(null)
  const [headline, ...rest] = offer.message.split('\n')
  const body = rest.join('\n').trim()
  const pending = inputAction === null ? undefined : offer.actions[inputAction]

  const send = async (prompt: string) => {
    setSending(true)
    setFailed(null)
    try {
      await onAction(prompt)
    } catch (error) {
      const detail = errorText(error, 'The action did not reach the agent')
      setFailed(detail)
      AccessibilityInfo.announceForAccessibility(`Not sent: ${detail}. Try again.`)
    } finally {
      setSending(false)
    }
  }

  const dismiss = async () => {
    if (!onDismiss || dismissing || sending) return
    setDismissing(true)
    setDismissFailed(null)
    try {
      await onDismiss(offer.createdAt)
    } catch (error) {
      // Only on the failure path does the flag come back down: a dismissal that
      // WORKED unmounts this card with the cleared session, and releasing it on
      // the way out would flash the control live again first.
      const detail = errorText(error, 'The offer is still active')
      setDismissFailed(detail)
      AccessibilityInfo.announceForAccessibility(`Not dismissed: ${detail}. Try again.`)
      setDismissing(false)
    }
  }

  return (
    <View style={styles.block} testID="session-action-card">
      {/* THE TILE (boards Chat/ChatAsk, POD-2380): the headline is the title,
          on the card colour, no eyebrow. Sending and the decline share its row:
          the decline is the control that says the question needs no answer,
          so it sits apart from the answers, faint and without the accent. */}
      <View style={styles.titleRow}>
        <Text style={styles.headline}>{headline}</Text>
        {sending ? <Text style={styles.meta}>sending…</Text> : null}
        {onDismiss ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Dismiss offer"
            accessibilityHint="Takes this offer off every surface without answering it"
            testID="offer-dismiss"
            disabled={dismissing || sending}
            hitSlop={10}
            onPress={() => void dismiss()}
            style={[styles.dismiss, (dismissing || sending) && styles.muted]}
          >
            <Icon as={X} size={14} color={color.textFaint} />
          </PressableScale>
        ) : null}
      </View>
      {body ? (
        <Text style={styles.body} numberOfLines={2}>
          {/* The URLs an agent wrote are the same links the desktop bar makes
              clickable. One that names this phone's own Podium opens the screen
              it names (POD-1606); everything else goes to the browser. Nested
              <Text> is how React Native puts a tappable run inside a paragraph —
              an overlaid Pressable would not follow the wrap. */}
          {segmentOfferText(body).map((segment, index) =>
            segment.kind === 'link' ? (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                key={index}
                accessibilityRole="link"
                style={styles.link}
                onPress={() => followPodiumLink(segment.href)}
              >
                {segment.text}
              </Text>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
              <Text key={index}>{segment.text}</Text>
            ),
          )}
        </Text>
      ) : null}
      {issue ? (
        <OfferArtifactStrip
          presentation="tile"
          offer={offer}
          issue={issue}
          {...(lastInputAt ? { lastInputAt } : {})}
          {...(onOpenEvidence ? { onShowAll: onOpenEvidence } : {})}
        />
      ) : null}
      {/* Failures get their own line rather than a slot in the eyebrow: at 390pt
          "not dismissed — try again" beside the label wrapped the eyebrow onto
          two lines, and an error is not a thing to truncate. */}
      {failed ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>
          Not sent: {failed}. Try again.
        </Text>
      ) : null}
      {dismissFailed ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>
          Not dismissed: {dismissFailed}. Try again.
        </Text>
      ) : null}
      {pending ? (
        <View style={styles.inputBlock}>
          <TextInput
            accessibilityLabel={`${pending.label} feedback`}
            value={feedback}
            onChangeText={setFeedback}
            placeholder="Add your feedback…"
            placeholderTextColor={color.textFaint}
            style={styles.input}
            multiline
            autoFocus
          />
          <View style={styles.actions}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={pending.label}
              disabled={sending || !feedback.trim()}
              style={[styles.button, styles.primary, (!feedback.trim() || sending) && styles.muted]}
              onPress={() => void send(composeOfferPrompt(pending.prompt, feedback))}
            >
              <Text style={styles.primaryText}>{pending.label}</Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Cancel feedback"
              disabled={sending}
              onPress={() => {
                setInputAction(null)
                setFeedback('')
                setFailed(null)
              }}
              style={styles.linkButton}
            >
              <Text style={styles.linkText}>Cancel</Text>
            </PressableScale>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          {offer.actions.map((action, index) => (
            <PressableScale
              key={`${action.label}:${action.prompt}`}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              disabled={sending}
              hitSlop={6}
              style={[
                [styles.button, index === 0 ? styles.primary : styles.secondary],
                sending && styles.muted,
              ]}
              onPress={() => {
                if (action.input) {
                  setInputAction(index)
                  setFailed(null)
                } else {
                  void send(action.prompt)
                }
              }}
            >
              <Text style={index === 0 ? styles.primaryText : styles.secondaryText}>
                {action.label}
              </Text>
              {/* This one opens a field rather than sending — say so before the
                  press, not after it. */}
              {action.input ? <Text style={styles.inputMark}>✎</Text> : null}
            </PressableScale>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  // Card colour, card radius 8, 12pt inset: the board's .tile.
  block: decisionTile.card,
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  meta: {
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: 20,
  },
  error: {
    color: color.dangerText,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  dismiss: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: {
    ...sans(600),
    flex: 1,
    color: color.text,
    fontSize: font.small,
    lineHeight: 20,
  },
  body: {
    color: color.textDim,
    fontSize: 14,
    lineHeight: 20,
  },
  link: {
    color: color.info,
    textDecorationLine: 'underline',
  },
  actions: decisionTile.actions,
  button: { ...decisionTile.button, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  primary: {
    backgroundColor: color.accent,
  },
  secondary: {
    backgroundColor: color.fill,
  },
  primaryText: {
    ...sans(500),
    color: color.onAccent,
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1,
  },
  secondaryText: {
    ...sans(500),
    color: color.text,
    fontSize: 14,
    lineHeight: 20,
    flexShrink: 1,
  },
  inputMark: {
    color: color.textDim,
    fontSize: font.micro,
  },
  muted: {
    opacity: 0.5,
  },
  linkButton: {
    minHeight: 44,
    justifyContent: 'center',
  },
  linkText: {
    ...sans(500),
    // Neutral, not accentTint: the accent is spent on the eyebrow and the
    // primary button, and a third one would argue with both. textDim, not
    // textFaint — this is a control, and faint lands under 4.5:1 on `bg`.
    color: color.textDim,
    fontSize: font.tiny,
  },
  inputBlock: {
    gap: space.sm,
  },
  input: {
    minHeight: 58,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.sm,
    // A fill on the tile, not the tile's own colour, or the field disappears.
    backgroundColor: color.quaternaryFill,
    color: color.text,
    fontSize: font.small,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    textAlignVertical: 'top',
  },
})
