import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/model'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useConnected, useIssues, useSessions } from '../client/hooks'
import { NewWorkButton } from '../components/NewWorkButton'
import { Screen } from '../components/Screen'
import { SessionCard } from '../components/SessionCard'
import { CountPill } from '../components/StatusGlyphs'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { EmptyState } from '../components/ui'
import { sessionHref } from '../lib/session-route'
import { color, font, mono, monoLabel, space } from '../theme/theme'

/**
 * Agents — the roster [POD-131]. Sessions grouped by attention (needs you /
 * working / idle), each row naming its attached task via the ID square.
 * Long-press peeks the task (TaskPeekSheet) without leaving the roster.
 */
export function SessionsScreen() {
  const router = useRouter()
  const sessions = useSessions()
  const issues = useIssues()
  const connected = useConnected()
  const now = Date.now()
  const [peek, setPeek] = useState<{ issue: IssueWire; session: SessionMeta } | null>(null)

  const groups = useMemo(() => groupSessions(withoutShells(sessions)), [sessions])
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
    session.issueId ? issues.find((issue) => issue.id === session.issueId) : undefined

  return (
    <Screen
      large
      title="Agents"
      subtitle={
        connected
          ? `${groups.working.length} working · ${groups.idle.length} idle`
          : 'reconnecting…'
      }
      right={<NewWorkButton />}
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
              onPress={() => router.push(sessionHref(session.sessionId, '/work'))}
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
        sessions={sessions}
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
