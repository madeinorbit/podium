import { compareRecency, withoutShells } from '@podium/client-core/focus'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { EmptyState } from '../components/ui'
import { color, font, radius, sans, space } from '../theme/theme'

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
      large
      title="Sessions"
      right={
        <HeaderButton label="New session" onPress={() => router.push('/new-session')}>
          <Icon as={Plus} size={19} color={color.text} />
        </HeaderButton>
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
            issue={issueFor(session)}
            agentColor={session.agentColor}
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
    gap: 6,
    paddingHorizontal: space.md + 2,
    paddingBottom: space.sm + 2,
  },
  filter: {
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    backgroundColor: color.surface,
    borderColor: color.hairlineBar,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterActive: {
    backgroundColor: color.accentSoft,
    borderColor: color.accentBorder,
  },
  filterText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny + 1,
  },
  filterTextActive: {
    color: color.accent,
  },
  listContent: {
    paddingBottom: 120,
    flexGrow: 1,
  },
})
