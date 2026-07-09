import type { IssueStage, IssueWire } from '@podium/protocol'
import { useRouter } from 'expo-router'
import { Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { HeaderButton, Screen } from '../components/Screen'
import { EmptyState, Pill } from '../components/ui'
import { color, font, radius, space } from '../theme/theme'

const STAGE_ORDER: IssueStage[] = [
  'in_progress',
  'review',
  'planning',
  'backlog',
  'done',
]

const STAGE_LABEL: Record<IssueStage, string> = {
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
      title="Issues"
      right={
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showDone ? 'Hide done issues' : 'Show done issues'}
            onPress={() => setShowDone((v) => !v)}
            hitSlop={8}
          >
            <Text style={styles.toggle}>{showDone ? 'Hide done' : 'Show done'}</Text>
          </Pressable>
          <HeaderButton label="New issue" onPress={() => router.push('/new-issue')}>
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
          </View>
        )}
        renderItem={({ item: issue }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Issue ${issue.seq}: ${issue.title}`}
            onPress={() => router.push(`/issue/${encodeURIComponent(issue.id)}`)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          >
            <View style={styles.topRow}>
              <Text style={styles.seq}>#{issue.seq}</Text>
              <Text style={styles.title} numberOfLines={2}>
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
        )}
        ListEmptyComponent={
          <EmptyState title="No issues" body="Issues filed in your repos show up here." />
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
    color: color.accent,
    fontSize: font.small,
    fontWeight: '600',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  sectionLabel: {
    color: color.textFaint,
    fontSize: font.tiny,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  sectionCount: {
    color: color.textFaint,
    fontSize: font.tiny,
  },
  card: {
    backgroundColor: color.surface,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.lg,
    gap: space.sm,
  },
  cardPressed: {
    backgroundColor: color.surfacePressed,
  },
  topRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  seq: {
    color: color.textFaint,
    fontSize: font.body,
    fontVariant: ['tabular-nums'],
  },
  title: {
    flex: 1,
    color: color.text,
    fontSize: font.body,
    fontWeight: '600',
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  repo: {
    color: color.textFaint,
    fontSize: font.tiny,
    marginLeft: 'auto',
  },
})
