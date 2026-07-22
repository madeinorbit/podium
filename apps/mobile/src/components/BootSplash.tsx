import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, monoLabel } from '../theme/theme'
import { AsciiWordmark } from './AsciiWordmark'

/**
 * Cold-start splash — the web AsciiLoader ported [POD-131]: the wordmark
 * reveals cell-by-cell with a sparkle then shimmers, over a mono LOADING
 * ticker. Shown while fonts load, the replica hydrates, and the auth probe
 * runs (the app previously showed a blank dark view in these gaps).
 */
export function BootSplash() {
  const [dots, setDots] = useState(1)
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d % 3) + 1), 500)
    return () => clearInterval(id)
  }, [])
  return (
    <View style={styles.root}>
      <AsciiWordmark color={color.text} fontSize={5.5} variant="reveal" />
      <Text style={styles.label}>{`LOADING${'.'.repeat(dots)}`}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  label: {
    ...monoLabel(9),
    letterSpacing: 2,
    color: color.label,
  },
})
