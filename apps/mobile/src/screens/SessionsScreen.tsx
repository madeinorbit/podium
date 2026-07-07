import { compareRecency, withoutShells } from '@podium/client-core/focus'
import type { SessionMeta } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { EmptyState } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'
import { sessionCardModel } from '../viewModels/sessionCard'

type Filter = 'active' | 'all' | 'archived'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'all', label: 'All' },
  { key: 'archived', label: 'Archived' },
]

export function SessionsScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const [filter, setFilter] = useState<Filter>('active')
  const now = Date.now()

  const sessions = useMemo(() => {
    const base = withoutShells(client.sessions)
    const filtered =
      filter === 'archived'
        ? base.filter((s) => s.archived)
        : filter === 'active'
          ? base.filter((s) => !s.archived && s.status !== 'exited')
          : base.filter((s) => !s.archived)
    return [...filtered].sort((a, b) => compareRecency(a, b, now))
  }, [client.sessions, filter, now])

  const issueFor = (session: SessionMeta) =>
    session.issueId ? client.issueById(session.issueId) : undefined

  return (
    <Screen
      title="Sessions"
      right={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New session"
          onPress={() => router.push('/new-session')}
          hitSlop={8}
        >
          <Icon as={Plus} size={22} color={color.text} />
        </Pressable>
      }
    >
      <View style={styles.filters}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            accessibilityRole="button"
            accessibilityLabel={`Show ${f.label} sessions`}
            onPress={() => setFilter(f.key)}
            style={[styles.filter, filter === f.key && styles.filterActive]}
          >
            <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.sessionId}
        contentContainerStyle={styles.listContent}
        renderItem={({ item: session }) => (
          <SessionCard
            model={sessionCardModel(session, issueFor(session), now)}
            onPress={() => router.push(`/session/${session.sessionId}`)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            title="No sessions here"
            body={filter === 'archived' ? 'Nothing archived yet.' : 'Start one with the + button.'}
          />
        }
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  filters: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  filter: {
    borderRadius: radius.full,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    backgroundColor: color.card,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterActive: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  filterText: {
    color: color.textDim,
    fontSize: font.small,
    fontWeight: '600',
  },
  filterTextActive: {
    color: color.accentText,
  },
  listContent: {
    paddingBottom: space.xxl,
    flexGrow: 1,
  },
})
