import { LOADING } from '@podium/client-graph/loading'
import { observer } from 'mobx-react-lite'
import { StyleSheet, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import { color, font, sans, space } from '../theme/theme'

/** An unanswered body is neither empty nor editable. Cached answers stay visible. */
export const BodyPending = observer(function BodyPending({ label }: { label: string }) {
  const pool = useMobilePool()
  const offline = pool?.collections.reading(LOADING) === 'offline'
  const message = offline ? 'Not available offline' : 'Loading…'
  return (
    <View
      testID="body-pending"
      accessibilityLabel={`${label}: ${message}`}
      accessibilityState={{ busy: !offline }}
      aria-busy={!offline}
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
