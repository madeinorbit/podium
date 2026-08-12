import type { SessionOffer } from '@podium/model'
import { X } from 'lucide-react-native'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/** Compose an input action's prompt with the feedback collected in context. */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

/**
 * A session-owned offer, kept in the transcript flow. This is deliberately a
 * compact action block rather than a Tray card or persistent bottom accessory:
 * the session is both the source of the decision and where its answer goes.
 *
 * `onDismiss` is the THIRD answer, matching the web bar's x [POD-771]: none of
 * these. Without it the phone could only answer an offer or wait for the
 * conversation to move past it, so a question already decided against sat at the
 * end of the transcript — and on a session that can no longer take a turn, it sat
 * there with no reachable exit at all.
 */
export function SessionActionCard({
  offer,
  evidenceCount = 0,
  onAction,
  onDismiss,
  onOpenEvidence,
}: {
  offer: SessionOffer
  evidenceCount?: number
  onAction: (prompt: string) => Promise<void>
  /** Take the offer off every surface without answering it. Absent on a host
   *  that cannot write (the card then keeps its two original exits). */
  onDismiss?: (offerCreatedAt: string) => Promise<void>
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
    <View style={styles.card} testID="session-action-card">
      <View style={styles.headingRow}>
        <Text style={styles.label}>ACTION</Text>
        {/* An explicit spacer rather than `marginLeft: 'auto'` on each status
            text: the x below needs the far end unconditionally, and two auto
            margins in one row split the slack between them instead. */}
        <View style={styles.headingSpacer} />
        {sending ? <Text style={styles.meta}>sending…</Text> : null}
        {failed ? <Text style={styles.error}>not sent — try again</Text> : null}
        {dismissFailed ? <Text style={styles.error}>not dismissed — try again</Text> : null}
        {/* THE DECLINE, AT THE LABEL ROW'S FAR END — same place the web bar puts
            it. It sits with the eyebrow and not among the buttons because the
            buttons are answers to the question and this is the control that says
            the question needs none. Faint, and it takes no accent: the card
            spends its one attention colour on the action meant to be pressed.
            NOT gated on `sending`'s disabled treatment the way the buttons are —
            an offer on a session that cannot take a turn is exactly the one that
            needs its way out. 10pt of ink, 30pt of thumb once hitSlop counts. */}
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
          {body}
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
                styles.button,
                index === 0 ? styles.primary : styles.secondary,
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
            </PressableScale>
          ))}
          {evidenceCount > 0 && onOpenEvidence ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={`Open ${evidenceCount} offer artifact${evidenceCount === 1 ? '' : 's'}`}
              onPress={onOpenEvidence}
              style={styles.linkButton}
            >
              <Text
                style={styles.linkText}
              >{`${evidenceCount} artifact${evidenceCount === 1 ? '' : 's'} →`}</Text>
            </PressableScale>
          ) : null}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderLeftWidth: 3,
    borderLeftColor: color.needsYou,
    borderRadius: radius.md,
    backgroundColor: color.needsYouSoft,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: 6,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  label: {
    ...monoLabel(),
    color: color.needsYou,
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
  },
  dismiss: {
    // Negative vertical margin keeps the 10pt glyph from growing the eyebrow row.
    marginVertical: -space.xs,
    padding: space.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  body: {
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  button: {
    minHeight: 36,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: color.accent,
  },
  secondary: {
    backgroundColor: color.elevated,
    borderWidth: 1,
    borderColor: color.borderStrong,
  },
  primaryText: {
    ...sans(600),
    color: color.onAccent,
    fontSize: font.small,
  },
  secondaryText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
  muted: {
    opacity: 0.5,
  },
  linkButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: space.xs,
  },
  linkText: {
    ...sans(500),
    color: color.accentTint,
    fontSize: font.tiny,
  },
  inputBlock: {
    gap: space.sm,
  },
  input: {
    minHeight: 58,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    backgroundColor: color.bg,
    color: color.text,
    fontSize: font.small,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    textAlignVertical: 'top',
  },
})
