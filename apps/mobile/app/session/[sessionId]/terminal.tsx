import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { Icon } from '../../../src/components/Icon'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { TerminalPane } from '../../../src/terminal/TerminalPane'

export default function TerminalRoute() {
  const router = useRouter()
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>()
  const id = Array.isArray(sessionId) ? sessionId[0] : sessionId
  return (
    <View style={styles.screen}>
      <Pressable style={styles.back} onPress={() => router.back()} accessibilityRole="button">
        <Icon as={ChevronLeft} size={20} color="#e5e7eb" />
        <Text style={styles.backText}>Session</Text>
      </Pressable>
      <TerminalPane sessionId={id} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#050608', paddingTop: 48 },
  back: { height: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
})
