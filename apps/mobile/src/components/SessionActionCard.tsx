import type { SessionOffer } from '@podium/model'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

/** Compose an input action's prompt with the feedback collected in context. */
export const composeOfferPrompt = (prompt: string, feedback: string): string =>
  `${prompt}\n\n${feedback.trim()}`

/**
 * A session-owned offer, kept in the transcript flow. This is deliberately a
 * compact action block rather than a Tray card or persistent bottom accessory:
 * the session is both the source of the decision and where its answer goes.
 */
export function SessionActionCard({
  offer,
  evidenceCount = 0,
  onAction,
  onOpenEvidence,
}: {
  offer: SessionOffer
  evidenceCount?: number
  onAction: (prompt: string) => Promise<void>
  onOpenEvidence?: () => void
}) {
  const [inputAction, setInputAction] = useState<number | null>(null)
  const [feedback, setFeedback] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
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

  return (
    <View style={styles.card} testID="session-action-card">
      <View style={styles.headingRow}>
        <Text style={styles.label}>ACTION</Text>
        {sending ? <Text style={styles.meta}>sending…</Text> : null}
        {failed ? <Text style={styles.error}>not sent — try again</Text> : null}
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
  meta: {
    marginLeft: 'auto',
    color: color.textDim,
    fontSize: font.tiny,
  },
  error: {
    marginLeft: 'auto',
    color: color.danger,
    fontSize: font.tiny,
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
