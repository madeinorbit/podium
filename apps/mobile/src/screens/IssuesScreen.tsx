import type { IssueStage, IssueWire } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { HeaderButton, Screen } from '../components/Screen'
import { EmptyState, Pill } from '../components/ui'
import { flow, issueColorHex } from '../theme/issueColors'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

const STAGE_ORDER: IssueStage[] = [
  'in_progress',
  'review',
  'planning',
  'backlog',
  'proposed',
  'done',
]

const STAGE_LABEL: Record<IssueStage, string> = {
  proposed: 'Proposed',
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

export function IssuesScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const [showDone, setShowDone] = useState(false)

  const sections = useMemo(() => {
    const byStage = new Map<IssueStage, IssueWire[]>()
    for (const issue of client.issues) {
      const list = byStage.get(issue.stage) ?? []
      list.push(issue)
      byStage.set(issue.stage, list)
    }
    return STAGE_ORDER.filter((stage) => showDone || stage !== 'done')
      .map((stage) => ({
        key: stage,
        title: STAGE_LABEL[stage],
        data: (byStage.get(stage) ?? []).sort((a, b) => a.priority - b.priority || b.seq - a.seq),
      }))
      .filter((s) => s.data.length > 0)
  }, [client.issues, showDone])

  const repoName = (issue: IssueWire) => issue.repoPath.split('/').filter(Boolean).pop() ?? ''

  return (
    <Screen
      large
      title="Tasks"
      right={
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showDone ? 'Hide done tasks' : 'Show done tasks'}
            onPress={() => setShowDone((v) => !v)}
            hitSlop={8}
          >
            <Text style={styles.toggle}>{showDone ? 'Hide done' : 'Show done'}</Text>
          </Pressable>
          <HeaderButton label="New task" onPress={() => router.push('/new-issue')}>
            <Icon as={Plus} size={19} color={color.text} />
          </HeaderButton>
        </>
      }
    >
      <SectionList
        sections={sections}
        keyExtractor={(issue) => issue.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.listContent}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>{section.title.toUpperCase()}</Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
            <View style={styles.sectionRule} />
          </View>
        )}
        renderItem={({ item: issue }) => {
          const hex = issueColorHex(issue.color)
          const resting = issue.stage === 'backlog' || issue.stage === 'proposed'
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Issue ${issue.seq}: ${issue.title}`}
              onPress={() => router.push(`/issue/${encodeURIComponent(issue.id)}`)}
              style={({ pressed }) => [
                styles.card,
                hex ? { backgroundColor: flow.rowBg(hex) } : null,
                pressed && styles.cardPressed,
              ]}
            >
              <View style={styles.topRow}>
                <IdSquare
                  issue={issue}
                  state={
                    issue.stage === 'done'
                      ? 'done'
                      : issue.needsHuman
                        ? 'waiting'
                        : resting
                          ? 'queued'
                          : 'working'
                  }
                  ringColor={hex ? flow.rowBg(hex) : color.surface}
                />
                <Text
                  style={[styles.title, hex ? { color: flow.text(hex) } : null]}
                  numberOfLines={2}
                >
                  {issue.title}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Pill label={issue.type} />
                <Pill label={`P${issue.priority}`} />
                {issue.needsHuman ? <Pill label="needs human" toneKey="needsYou" /> : null}
                {issue.blockedBy.length > 0 ? (
                  <Pill label={`blocked by ${issue.blockedBy.length}`} toneKey="danger" />
                ) : null}
                <Text style={styles.repo} numberOfLines={1}>
                  {repoName(issue)}
                </Text>
              </View>
            </Pressable>
          )
        }}
        ListEmptyComponent={
          <EmptyState title="No tasks" body="Tasks filed in your repos show up here." />
        }
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: 120,
    flexGrow: 1,
  },
  toggle: {
    ...sans(600),
    color: color.accent,
    fontSize: font.tiny + 1,
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
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    marginHorizontal: space.sm + 2,
    marginBottom: 3,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 6,
  },
  cardPressed: {
    backgroundColor: color.surfacePressed,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  title: {
    ...sans(500),
    flex: 1,
    color: color.text,
    fontSize: font.small,
    lineHeight: 16,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  repo: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    marginLeft: 'auto',
  },
})
