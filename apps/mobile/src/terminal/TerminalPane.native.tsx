import { StyleSheet, Text, View } from 'react-native'

export function TerminalPane({ sessionId }: { sessionId: string }) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Terminal</Text>
      <Text style={styles.text}>
        Native terminal control for {sessionId} is not enabled in this build. Use the transcript and
        composer, or open the Expo web route for terminal control.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    margin: 16,
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#374151',
  },
  title: { color: '#f9fafb', fontSize: 18, marginBottom: 8 },
  text: { color: '#cbd5e1', fontSize: 14, lineHeight: 20 },
})
