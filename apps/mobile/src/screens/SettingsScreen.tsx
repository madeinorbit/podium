import { useRouter } from 'expo-router'
import { ChevronLeft, Monitor } from 'lucide-react-native'
import { Icon } from '../components/Icon'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'

function openDesktop() {
  if (typeof document !== 'undefined') {
    document.cookie = 'podium_desktop=1; Path=/; SameSite=Lax; Max-Age=2592000'
  }
  if (typeof window !== 'undefined') {
    window.location.assign('/desktop')
  }
}

export function SettingsScreen() {
  const router = useRouter()
  const { connected, conversations, cursor, issues, outboxSize, serverConfig, sessions } = useMobileClient()

  return (
    <View style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable style={styles.back} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Icon as={ChevronLeft} size={20} color="#e5e7eb" />
          <Text style={styles.backText}>Focus</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {Platform.OS === 'web' ? (
          <Pressable style={styles.action} onPress={openDesktop} accessibilityRole="button" accessibilityLabel="Open desktop">
            <Icon as={Monitor} size={18} color="#111827" />
            <Text style={styles.actionText}>Open desktop</Text>
          </Pressable>
        ) : null}
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Diagnostics</Text>
          <Text style={styles.row}>Platform: {Platform.OS}</Text>
          <Text style={styles.row}>Connection: {connected ? 'live' : 'reconnecting'}</Text>
          <Text style={styles.row}>Server: {serverConfig.httpOrigin}</Text>
          <Text style={styles.row}>Sessions: {sessions.length}</Text>
          <Text style={styles.row}>Issues: {issues.length}</Text>
          <Text style={styles.row}>Conversations: {conversations.length}</Text>
          <Text style={styles.row}>Outbox: {outboxSize}</Text>
          <Text style={styles.row}>Cursor: {cursor ?? 'none'}</Text>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114', paddingTop: 48 },
  topbar: { height: 52, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 14 },
  back: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4 },
  backText: { color: '#e5e7eb', fontSize: 15, fontWeight: '600' },
  title: { color: '#f8fafc', fontSize: 22, fontWeight: '800' },
  content: { padding: 18, gap: 14 },
  action: { minHeight: 44, borderRadius: 8, backgroundColor: '#f8fafc', flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  actionText: { color: '#111827', fontWeight: '800', fontSize: 15 },
  panel: { borderRadius: 8, borderWidth: 1, borderColor: '#2f333a', backgroundColor: '#181a20', padding: 14, gap: 8 },
  panelTitle: { color: '#f8fafc', fontSize: 17, fontWeight: '800', marginBottom: 4 },
  row: { color: '#cbd5e1', fontSize: 14, lineHeight: 20 },
})
