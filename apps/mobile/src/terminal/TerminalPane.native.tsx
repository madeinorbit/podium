import type { SessionId } from '@podium/model'
import { StyleSheet, Text, View } from 'react-native'
import type { TerminalControlState } from './terminal-control'

/**
 * Prop parity with the web pane on purpose: the route renders ONE
 * `<TerminalPane>` and metro picks the platform file, so a prop the native stub
 * did not accept would only fail on a device. Neither is honoured here — there
 * is no mount, so there is no control to take and no ref to underline.
 */
export function TerminalPane({
  sessionId,
}: {
  sessionId: SessionId
  active: boolean
  onOpenIssue?: (issueId: string) => void
  onControlState?: (state: TerminalControlState) => void
}) {
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
