import { segmentOfferText } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionOffer } from '@podium/model'
import { Lightbulb, X } from 'lucide-react-native'
import { useState } from 'react'
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { OfferArtifactStrip } from './OfferArtifactStrip'
import { PressableScale } from './PressableScale'

/** Compose an input action's prompt with the feedback collected in context. */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

/**
 * A session-owned offer, kept in the transcript flow. This is deliberately a
 * compact action block rather than a Tray card or persistent bottom accessory:
 * the session is both the source of the decision and where its answer goes.
 *
 * A BLOCK IN THE DOCUMENT, NOT A CARD — the same move the desktop bar made
 * [POD-725], arrived at here for the same reason. This was an accent-rimmed,
 * accent-washed, rounded panel: a 3pt accent edge, an accent wash and an accent
 * button, three signals for one request, in an app whose whole palette spends
 * the accent exactly once. The block now earns its weight typographically — a
 * rule marking where the answer ended and the question began, a bisque eyebrow,
 * and a headline set larger than the transcript prose above it — and the single
 * accented object left on screen is the button the operator is meant to press.
 *
 * `onDismiss` is the THIRD answer, matching the web bar's x [POD-771]: none of
 * these. Without it the phone could only answer an offer or wait for the
 * conversation to move past it, so a question already decided against sat at the
 * end of the transcript — and on a session that can no longer take a turn, it sat
 * there with no reachable exit at all.
 *
 * THE EVIDENCE IS IN THE BLOCK, not behind a link [POD-120]. The offered
 * artifacts used to be a "2 artifacts →" control that opened the task peek —
 * the whole issue, to look at two files the agent had already named. The
 * desktop answers this with {@link OfferArtifactStrip} inside the offer itself,
 * and so does this now; `onOpenEvidence` survives as the strip's overflow
 * target, which is the one case where the full list still beats the strip.
 */
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
  issue?: IssueWire
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
  const [failed, setFailed] = useState(false)
  const [dismissFailed, setDismissFailed] = useState(false)
  const [headline, ...rest] = offer.message.split('\n')
  const body = rest.join('\n').trim()
  const pending = inputAction === null ? undefined : offer.actions[inputAction]

  const send = async (prompt: string) => {
    setSending(true)
    setFailed(false)
    try {
      await onAction(prompt)
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }

  const dismiss = async () => {
    if (!onDismiss || dismissing || sending) return
    setDismissing(true)
    setDismissFailed(false)
    try {
      await onDismiss(offer.createdAt)
    } catch {
      // Only on the failure path does the flag come back down: a dismissal that
      // WORKED unmounts this card with the cleared session, and releasing it on
      // the way out would flash the control live again first.
      setDismissFailed(true)
      setDismissing(false)
    }
  }

  return (
    <View style={styles.block} testID="session-action-card">
      <View style={styles.headingRow}>
        <Icon as={Lightbulb} size={11} color={color.needsYouText} />
        <Text style={styles.label}>Offer · needs you</Text>
        {/* An explicit spacer rather than `marginLeft: 'auto'` on each status
            text: the x below needs the far end unconditionally, and two auto
            margins in one row split the slack between them instead. */}
        <View style={styles.headingSpacer} />
        {sending ? <Text style={styles.meta}>sending…</Text> : null}
        {/* THE DECLINE, AT THE LABEL ROW'S FAR END — same place the web bar puts
            it. It sits with the eyebrow and not among the buttons because the
            buttons are answers to the question and this is the control that says
            the question needs none. Faint, and it takes no accent: the block
            spends its one attention colour on the action meant to be pressed.
            NOT gated on `sending`'s disabled treatment the way the buttons are —
            an offer on a session that cannot take a turn is exactly the one that
            needs its way out. 13pt of ink, 33pt of thumb once hitSlop counts. */}
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
            <Icon as={X} size={13} color={color.textFaint} />
          </PressableScale>
        ) : null}
      </View>
      <Text style={styles.headline}>{headline}</Text>
      {body ? (
        <Text style={styles.body} numberOfLines={2}>
          {/* The URLs an agent wrote are the same links the desktop bar makes
              clickable; here they open the phone's browser. Nested <Text> is
              how React Native puts a tappable run inside a paragraph — an
              overlaid Pressable would not follow the wrap. */}
          {segmentOfferText(body).map((segment, index) =>
            segment.kind === 'link' ? (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                key={index}
                accessibilityRole="link"
                style={styles.link}
                onPress={() => void Linking.openURL(segment.href).catch(() => {})}
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
          offer={offer}
          issue={issue}
          {...(lastInputAt ? { lastInputAt } : {})}
          {...(onOpenEvidence ? { onShowAll: onOpenEvidence } : {})}
        />
      ) : null}
      {/* Failures get their own line rather than a slot in the eyebrow: at 390pt
          "not dismissed — try again" beside the label wrapped the eyebrow onto
          two lines, and an error is not a thing to truncate. */}
      {failed ? <Text style={styles.error}>Not sent — try again.</Text> : null}
      {dismissFailed ? <Text style={styles.error}>Not dismissed — try again.</Text> : null}
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
                setFailed(false)
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
              style={[
                index === 0 ? [styles.button, styles.primary] : styles.textAction,
                sending && styles.muted,
              ]}
              onPress={() => {
                if (action.input) {
                  setInputAction(index)
                  setFailed(false)
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
  block: {
    // The rule IS the container. It marks where the answer ended and the
    // question began; no fill, no radius, and no horizontal padding, so the
    // offer keeps the transcript's own column instead of floating above it.
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    paddingTop: space.md,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    ...monoLabel(),
    color: color.needsYouText,
  },
  headingSpacer: {
    flex: 1,
  },
  meta: {
    color: color.textDim,
    fontSize: font.tiny,
  },
  error: {
    color: color.danger,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
    marginTop: 6,
  },
  dismiss: {
    // Negative vertical margin keeps the 13pt glyph from growing the eyebrow row.
    marginVertical: -space.xs,
    padding: space.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: {
    ...sans(600),
    color: color.text,
    // Set ABOVE the transcript prose it follows: with the accent wash gone, the
    // question's weight is what marks it as the thing that needs you.
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
    marginTop: space.sm + 2,
  },
  body: {
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
    marginTop: 5,
  },
  link: {
    color: color.info,
    textDecorationLine: 'underline',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    // Keep enough air between the filled recommendation and its quieter
    // alternatives that the controls remain easy to scan as separate choices.
    columnGap: space.sm,
    rowGap: space.xs,
    marginTop: space.md,
  },
  button: {
    // 44pt is the platform floor, and this is the one control meant to be hit
    // without looking.
    minHeight: 44,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  primary: {
    backgroundColor: color.accent,
  },
  /** ONE STRONG BUTTON, THEN QUIET BUTTONS. A low-contrast surface gives the
   *  alternatives a visible tap shape without challenging the filled accent
   *  recommendation for priority. */
  textAction: {
    minHeight: 44,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    backgroundColor: color.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  primaryText: {
    ...sans(600),
    color: color.onAccent,
    fontSize: font.small,
  },
  secondaryText: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.small,
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
    marginTop: space.md,
  },
  input: {
    minHeight: 58,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.sm,
    // A raised fill, not the page colour: with the block's own surface gone,
    // `bg` would leave the field indistinguishable from the transcript behind it.
    backgroundColor: color.surface,
    color: color.text,
    fontSize: font.small,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    textAlignVertical: 'top',
  },
})
