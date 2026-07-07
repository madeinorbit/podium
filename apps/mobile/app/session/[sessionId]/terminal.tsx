import { useLocalSearchParams, useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { Screen } from '../../../src/components/Screen'
import { TerminalPane } from '../../../src/terminal/TerminalPane'
import { color } from '../../../src/theme/theme'

export default function TerminalRoute() {
  const router = useRouter()
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  const id = Array.isArray(sessionId) ? sessionId[0] : sessionId
  return (
    <Screen title="Session" onBack={() => router.back()} backLabel="Chat">
      <View style={styles.pane}>
        <TerminalPane sessionId={id} />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    backgroundColor: color.bgSunken,
  },
})
