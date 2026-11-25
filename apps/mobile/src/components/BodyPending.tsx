import { LOADING } from '@podium/client-graph/loading'
import { observer } from 'mobx-react-lite'
import { StyleSheet, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import { color, font, sans, space } from '../theme/theme'

/**
 * An unanswered body is neither empty nor editable. Cached answers stay
 * visible. One the server refused (`unavailable`, POD-7595) will not load by
 * itself: it says so, never "Loading…", an empty state or a count.
 */
export const BodyPending = observer(function BodyPending({
  label,
  unavailable = false,
}: {
  label: string
  unavailable?: boolean
}) {
  const pool = useMobilePool()
  const offline = !unavailable && pool?.collections.reading(LOADING) === 'offline'
  const message = unavailable ? 'Not available' : offline ? 'Not available offline' : 'Loading…'
  const busy = !unavailable && !offline
  return (
    <View
      testID={unavailable ? 'body-unavailable' : 'body-pending'}
      accessibilityLabel={`${label}: ${message}`}
      accessibilityState={{ busy }}
      aria-busy={busy}
      style={styles.pending}
    >
      <Text style={styles.text}>{message}</Text>
    </View>
  )
})

const styles = StyleSheet.create({
  pending: { paddingVertical: space.md },
  text: { ...sans(400), fontSize: font.small, color: color.textDim },
})
