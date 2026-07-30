import { boardIssues } from '@podium/client-core/viewmodels'
import type { IssueStage, IssueWire } from '@podium/model'
import { useRouter } from 'expo-router'
import { ChevronRight, Layers, Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { HeaderButton, Screen } from '../components/Screen'
import { EmptyState, Pill } from '../components/ui'
import { buildScreeningQueue } from '../lib/screening'
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

  // The board's population is the desktop board's population (POD-338): no
  // archived or tombstoned rows, no DRAFT vessels (the placeholder issue every
  // bare session lives in until it is titled — a session container, not work),
  // and no agent-audience decomposition at top level.
  const board = useMemo(() => boardIssues(client.issues), [client.issues])

  const sections = useMemo(() => {
    const byStage = new Map<IssueStage, IssueWire[]>()
    for (const issue of board) {
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
  }, [board, showDone])

  const repoName = (issue: IssueWire) => issue.repoPath.split('/').filter(Boolean).pop() ?? ''

  // Proposals are inert until the operator decides [spec:SP-6144] — the deck
  // flow is the fast way through them, so the board leads with it whenever any
  // are waiting (POD-277).
  const proposals = useMemo(() => buildScreeningQueue(client.issues), [client.issues])

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
        stickySectionHeadersEnabled
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          proposals.length === 0 ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Screen proposed"
              accessibilityHint={`Decide on ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} one at a time`}
              onPress={() => router.push('/screen-proposed')}
              style={({ pressed }) => [styles.screenRow, pressed && styles.screenRowPressed]}
            >
              <View style={styles.screenIcon}>
                <Icon as={Layers} size={16} color={color.accent} />
              </View>
              <View style={styles.screenText}>
                <Text style={styles.screenTitle}>Screen proposed</Text>
                <Text style={styles.screenSub}>
                  {`${proposals.length} proposal${proposals.length === 1 ? '' : 's'} waiting on your call`}
                </Text>
              </View>
              <Icon as={ChevronRight} size={16} color={color.textFaint} />
            </Pressable>
          )
        }
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
  screenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    marginHorizontal: space.sm + 2,
    marginTop: space.sm,
    paddingHorizontal: 9,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
    backgroundColor: color.accentSoft,
  },
  screenRowPressed: {
    backgroundColor: 'rgba(245, 197, 24, 0.2)',
  },
  screenIcon: {
    width: 26,
    height: 26,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bgSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentBorder,
  },
  screenText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  screenTitle: {
    ...sans(600),
    color: color.text,
    fontSize: font.small + 1,
  },
  screenSub: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingTop: space.md,
    paddingBottom: 7,
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
