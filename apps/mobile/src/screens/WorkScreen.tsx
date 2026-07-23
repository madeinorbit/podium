import { attentionGroup } from '@podium/client-core/focus'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { ChevronRight, Eye, Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { IdSquare, type IdSquareState } from '../components/IdSquare'
import { HeaderButton, Screen } from '../components/Screen'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { EmptyState, Pill } from '../components/ui'
import { buildWorkSections } from '../lib/work-sections'
import { FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

function squareState(issue: IssueWire, sessions: SessionMeta[]): IdSquareState {
  if (issue.needsHuman || sessions.some((session) => attentionGroup(session) === 'needsYou')) {
    return 'waiting'
  }
  if (sessions.some((session) => attentionGroup(session) === 'working')) return 'working'
  if (sessions.length > 0) return 'idle'
  return 'queued'
}

export function WorkScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const [peek, setPeek] = useState<{ issue: IssueWire; session?: SessionMeta } | null>(null)
  const sections = useMemo(
    () => buildWorkSections(client.issues, client.sessions),
    [client.issues, client.sessions],
  )
  const issueCount = sections.reduce((total, section) => total + section.data.length, 0)
  const sessionCount = sections.reduce(
    (total, section) =>
      total + section.data.reduce((sectionTotal, row) => sectionTotal + row.sessions.length, 0),
    0,
  )
  return (
    <Screen
      large
      title="Work"
      subtitle={`${issueCount} active task${issueCount === 1 ? '' : 's'} · ${sessionCount} agent${sessionCount === 1 ? '' : 's'}`}
      right={
        <HeaderButton label="New session" onPress={() => router.push('/new-session')}>
          <Icon as={Plus} size={19} color={color.text} />
        </HeaderButton>
      }
    >
      <SectionList
        sections={sections}
        keyExtractor={({ issue }) => issue.id}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>{section.title}</Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
            <View style={styles.sectionRule} />
          </View>
        )}
        renderItem={({ item: { issue, sessions } }) => {
          const hex = issueColorHex(issue.color) ?? FLOW_SLATE
          return (
            <View style={styles.issueBlock}>
              <View style={[styles.issueRow, { backgroundColor: flow.rowBg(hex) }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open issue ${issue.seq}: ${issue.title}`}
                  onPress={() => router.push(`/issue/${encodeURIComponent(issue.id)}`)}
                  style={({ pressed }) => [styles.issueMain, pressed && styles.pressed]}
                >
                  <IdSquare
                    issue={issue}
                    state={squareState(issue, sessions)}
                    ringColor={flow.rowBg(hex)}
                  />
                  <View style={styles.issueTitles}>
                    <Text style={[styles.issueTitle, { color: flow.text(hex) }]} numberOfLines={2}>
                      {issue.title}
                    </Text>
                    <View style={styles.issueMeta}>
                      <Pill label={issue.stage.replace('_', ' ')} />
                      <Text style={[styles.agentCount, { color: flow.muted(hex) }]}>
                        {sessions.length} agent{sessions.length === 1 ? '' : 's'}
                      </Text>
                    </View>
                  </View>
                  <Icon as={ChevronRight} size={16} color={flow.muted(hex)} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Peek task ${issue.seq}`}
                  onPress={() => setPeek({ issue })}
                  hitSlop={6}
                  style={({ pressed }) => [styles.peek, pressed && styles.pressed]}
                >
                  <Icon as={Eye} size={15} color={color.textDim} />
                </Pressable>
              </View>
            </View>
          )
        }}
        ListEmptyComponent={
          <EmptyState
            title="No active work"
            body="Planning, in-progress, and review tasks appear here with their agents."
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
    flexGrow: 1,
    paddingBottom: 120,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm,
    backgroundColor: color.bg,
    zIndex: 1,
  },
  sectionLabel: {
    ...monoLabel(9),
    color: color.label,
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
  issueBlock: {
    marginBottom: space.sm,
  },
  issueRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginHorizontal: space.sm + 2,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  issueMain: {
    flex: 1,
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  issueTitles: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  issueTitle: {
    ...sans(600),
    fontSize: font.small,
    lineHeight: 16,
  },
  issueMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  agentCount: {
    ...mono(400),
    fontSize: font.micro,
  },
  peek: {
    width: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: color.border,
  },
  pressed: {
    opacity: 0.65,
  },
})
