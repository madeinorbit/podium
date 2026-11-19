import { StyleSheet, View } from 'react-native'
import { color } from '../theme/theme'

/** A fixed header slot, shared by every phone screen; no row or loading treatment. */
export function ScreenRefreshMark({ refreshing }: { refreshing: boolean }) {
  return (
    <View
      style={styles.slot}
      accessible={refreshing}
      accessibilityRole={refreshing ? 'text' : undefined}
      accessibilityLabel={refreshing ? 'Refreshing' : undefined}
      testID="screen-refresh-mark"
    >
      <View style={[styles.dot, { opacity: refreshing ? 0.7 : 0 }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  slot: { width: 12, height: 12, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.textDim },
})
