import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { HeaderButton, Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { CountPill } from '../components/StatusGlyphs'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { EmptyState } from '../components/ui'
import { color, font, mono, monoLabel, space } from '../theme/theme'

/**
 * Agents — the roster [POD-131]. Sessions grouped by attention (needs you /
 * working / idle), each row naming its attached task via the ID square.
 * Long-press peeks the task (TaskPeekSheet) without leaving the roster.
 */
export function SessionsScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const now = Date.now()
  const [peek, setPeek] = useState<{ issue: IssueWire; session: SessionMeta } | null>(null)

  const groups = useMemo(() => groupSessions(withoutShells(client.sessions)), [client.sessions])
  const sections = useMemo(
    () =>
      [
        { key: 'needsYou' as const, title: 'Needs you', data: groups.needsYou },
        { key: 'working' as const, title: 'Working', data: groups.working },
        { key: 'idle' as const, title: 'Idle', data: groups.idle },
      ].filter((s) => s.data.length > 0),
    [groups],
  )

  const issueFor = (session: SessionMeta): IssueWire | undefined =>
    session.issueId ? client.issueById(session.issueId) : undefined

  return (
    <Screen
      large
      title="Agents"
      subtitle={
        client.connected
          ? `${groups.working.length} working · ${groups.idle.length} idle`
          : 'reconnecting…'
      }
      right={
        <HeaderButton label="New session" onPress={() => router.push('/new-session')}>
          <Icon as={Plus} size={19} color={color.text} />
        </HeaderButton>
      }
    >
      <SectionList
        sections={sections}
        keyExtractor={(session) => session.sessionId}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text
              style={[
                styles.sectionLabel,
                section.key === 'needsYou' && styles.needsYouLabel,
                section.key === 'working' && styles.workingLabel,
              ]}
            >
              {section.title.toUpperCase()}
            </Text>
            {section.key === 'needsYou' ? (
              <CountPill count={section.data.length} />
            ) : (
              <Text style={styles.sectionCount}>{section.data.length}</Text>
            )}
            <View style={styles.sectionRule} />
          </View>
        )}
        renderItem={({ item: session }) => {
          const issue = issueFor(session)
          return (
            <SessionCard
              model={sessionCardModel(session, issue, now)}
              issue={issue}
              agentColor={session.agentColor}
              onPress={() => router.push(`/session/${session.sessionId}`)}
              onLongPress={issue ? () => setPeek({ issue, session }) : undefined}
            />
          )
        }}
        ListEmptyComponent={
          <EmptyState
            title="No agents running"
            body="Start a session with the + button, or fire off a task from the board."
          />
        }
      />
      <TaskPeekSheet
        issue={peek?.issue ?? null}
        session={peek?.session}
        onClose={() => setPeek(null)}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: space.xl,
    flexGrow: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingTop: space.lg,
    paddingBottom: 5,
  },
  sectionLabel: {
    ...monoLabel(9),
    color: color.label,
  },
  needsYouLabel: {
    color: color.needsYou,
  },
  workingLabel: {
    color: color.working,
  },
  sectionCount: {
    ...mono(600),
    color: color.textFaint,
    fontSize: font.micro,
  },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
})
