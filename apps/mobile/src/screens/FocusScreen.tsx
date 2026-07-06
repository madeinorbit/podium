import { useRouter } from 'expo-router'
import { ChevronRight, RefreshCcw, Settings } from 'lucide-react-native'
import { Icon } from '../components/Icon'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { buildFocusCards } from '../viewModels/focusCards'
import { styles } from './focusStyles'

export function FocusScreen() {
  const router = useRouter()
  const { sessions, issues, connected, error, outboxSize } = useMobileClient()
  const cards = buildFocusCards({ sessions, issues })

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Focus</Text>
        <View style={styles.headerActions}>
          <View style={styles.statusRow}>
            <View style={[styles.dot, connected ? styles.dotOk : styles.dotDown]} />
            <Text style={styles.statusText}>{connected ? 'Live' : 'Reconnecting'}</Text>
          </View>
          <Pressable style={styles.iconButton} onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Settings">
            <Icon as={Settings} size={18} color="#cbd5e1" />
          </Pressable>
        </View>
      </View>
      {error ? (
        <View style={styles.notice}>
          <Icon as={RefreshCcw} size={16} color="#f4c430" />
          <Text style={styles.noticeText}>{error}</Text>
        </View>
      ) : null}
      {outboxSize > 0 ? (
        <View style={styles.notice}>
          <Icon as={RefreshCcw} size={16} color="#f4c430" />
          <Text style={styles.noticeText}>{outboxSize} queued send{outboxSize === 1 ? '' : 's'}</Text>
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.list}>
        {cards.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No active sessions</Text>
            <Text style={styles.emptyText}>Start an agent on desktop and it will appear here.</Text>
          </View>
        ) : (
          cards.map((card) => (
            <Pressable
              key={card.sessionId}
              accessibilityRole="button"
              accessibilityLabel={'Open session ' + card.title}
              style={[styles.card, card.group === 'needsYou' ? styles.cardNeedsYou : null]}
              onPress={() => router.push('/session/' + card.sessionId)}
            >
              <View style={styles.cardMain}>
                <Text numberOfLines={1} style={styles.cardTitle}>
                  {card.title}
                </Text>
                <Text numberOfLines={1} style={styles.cardMeta}>
                  {card.subtitle}
                </Text>
                {card.issueLabel ? (
                  <Text numberOfLines={1} style={styles.issue}>
                    {card.issueLabel}
                  </Text>
                ) : null}
                {card.summary ? <Text style={styles.summary}>{card.summary}</Text> : null}
              </View>
              <Icon as={ChevronRight} size={20} color="#9ca3af" />
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  )
}
