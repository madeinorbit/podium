import { Pressable, StyleSheet, Text, View } from 'react-native'
import { color, sans } from '../theme/theme'
import { pendingFailure } from './pending-delivery'
import type { PendingTurn } from './TranscriptList'

/** Presentation only: retries retain the conversation controller's distinction
 * between a local retry and restoring a server notice to the composer. */
export function PendingDeliveryFailure({
  turn,
  onRetry,
  onSendAgain,
  onDiscard,
}: {
  turn: PendingTurn
  onRetry?: (turn: PendingTurn) => void
  onSendAgain?: (turn: PendingTurn) => void
  onDiscard?: (turn: PendingTurn) => void
}) {
  const unknown = turn.delivery === 'unknown'
  const action =
    turn.notice !== undefined ? onSendAgain : turn.retryable !== false ? onRetry : undefined
  const label = unknown
    ? 'Not Confirmed'
    : action
      ? 'Not Delivered — Tap to retry'
      : 'Not Delivered'
  return (
    <View style={styles.failure}>
      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            unknown ? 'Not Confirmed — Tap to review before sending again' : label
          }
          accessibilityHint={
            turn.notice !== undefined
              ? 'Opens this message in the composer. Review it before sending.'
              : 'Retries this unsent message.'
          }
          onPress={() => action(turn)}
          style={styles.action}
        >
          <Text style={styles.label}>{label}</Text>
        </Pressable>
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
      {!unknown ? <Text style={styles.reason}>{pendingFailure(turn)}</Text> : null}
      {unknown ? (
        <Text style={styles.reason}>
          {action
            ? 'It may already have arrived. Tap to review before sending again.'
            : 'It may already have arrived.'}
        </Text>
      ) : null}
      {onDiscard ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={turn.notice !== undefined ? 'Dismiss' : 'Discard this unsent message'}
          onPress={() => onDiscard(turn)}
          style={styles.action}
        >
          <Text style={styles.reason}>{turn.notice !== undefined ? 'Dismiss' : 'Discard'}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  failure: { alignItems: 'flex-end', gap: 4, maxWidth: '88%' },
  action: { minHeight: 44, justifyContent: 'center' },
  label: { ...sans(400), color: color.dangerText, fontSize: 13, textAlign: 'right' },
  reason: { ...sans(400), color: color.textDim, fontSize: 12, textAlign: 'right' },
})
