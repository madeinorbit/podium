import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Screen } from '../../../src/components/Screen'
import { TerminalPane } from '../../../src/terminal/TerminalPane'
import { color } from '../../../src/theme/theme'

export default function TerminalRoute() {
  const router = useRouter()
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  const id = Array.isArray(sessionId) ? sessionId[0] : sessionId
  const [active, setActive] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setActive(true)
      return () => setActive(false)
    }, []),
  )
  return (
    <Screen title="Session" onBack={() => router.back()} backLabel="Chat">
      <View style={styles.pane}>
        <TerminalPane sessionId={id} active={active} />
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
