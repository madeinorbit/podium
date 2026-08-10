import { boardIssues } from '@podium/client-core/viewmodels'
import type { IssueStage, IssueWire } from '@podium/model'
import { useRouter } from 'expo-router'
import { ChevronRight, Layers, Plus } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { SectionList, StyleSheet, Text, View } from 'react-native'
import { useBooting, useIssues } from '../client/hooks'
import { useMobileShell } from '../client/shell'
import { Icon } from '../components/Icon'
import { IdSquare } from '../components/IdSquare'
import { BootstrapCrossfade, TasksSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { PullToRefreshBoundary } from '../components/PullToRefreshBoundary'
import { HeaderButton, Screen } from '../components/Screen'
import { EmptyState, Pill } from '../components/ui'
import { useMinimizeTabBarOnScroll } from '../hooks/useMinimizeTabBarOnScroll'
import { useRefreshableTab } from '../hooks/useRefreshableTab'
import { useTabBarInset } from '../hooks/useTabBarInset'
import { buildScreeningQueue } from '../lib/screening'
import { flow, issueColorHex } from '../theme/issueColors'
import { color, font, leading, mono, monoLabel, radius, sans, space } from '../theme/theme'

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
  const issues = useIssues()
  const [showDone, setShowDone] = useState(false)
  const booting = useBooting()
  const { notice } = useMobileShell()
  const { listRef, refreshControl, refreshAccessibilityProps, refreshing, onRefresh, connected } =
    useRefreshableTab('issues')
  const tabBarInset = useTabBarInset()
  const minimizeOnScroll = useMinimizeTabBarOnScroll()

  // The board's population is the desktop board's population (POD-338): no
  // archived or tombstoned rows, no DRAFT vessels (the placeholder issue every
  // bare session lives in until it is titled — a session container, not work),
  // and no agent-audience decomposition at top level.
  const board = useMemo(() => boardIssues(issues), [issues])

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
  const proposals = useMemo(() => buildScreeningQueue(issues), [issues])

  return (
    <Screen
      large
      title="Tasks"
      right={
        <>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={showDone ? 'Hide done tasks' : 'Show done tasks'}
            onPress={() => setShowDone((v) => !v)}
            hitSlop={8}
          >
            <Text style={styles.toggle}>{showDone ? 'Hide done' : 'Show done'}</Text>
          </PressableScale>
          <HeaderButton label="New task" onPress={() => router.push('/new-issue')}>
            <Icon as={Plus} size={19} color={color.text} />
          </HeaderButton>
        </>
      }
    >
      {/* Never silent (ADR 6 D4.4): storage degradation is owed to the user, not
          a log line. Outside the crossfade so the skeleton cannot hide it. */}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <BootstrapCrossfade resolved={!booting} placeholder={<TasksSkeleton />}>
        <PullToRefreshBoundary connected={connected} refreshing={refreshing} onRefresh={onRefresh}>
          <SectionList
            ref={listRef as never}
            sections={sections}
            keyExtractor={(issue) => issue.id}
            stickySectionHeadersEnabled
            refreshControl={refreshControl}
            contentContainerStyle={[styles.listContent, { paddingBottom: tabBarInset + space.lg }]}
            {...refreshAccessibilityProps}
            {...minimizeOnScroll}
            ListHeaderComponent={
              proposals.length === 0 ? null : (
                <PressableScale
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
                </PressableScale>
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
                <PressableScale
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
                    {issue.blockedByNotes.length > 0 ? (
                      <Pill label={`blocked by ${issue.blockedByNotes.length}`} toneKey="danger" />
                    ) : null}
                    <Text style={styles.repo} numberOfLines={1}>
                      {repoName(issue)}
                    </Text>
                  </View>
                </PressableScale>
              )
            }}
            ListEmptyComponent={
              // Guarded on `booting` even though the crossfade covers this
              // screen: ListEmptyComponent is rendered by the list whenever its
              // data is empty, with no notion of whether loading has finished, so
              // without this the empty state is CONSTRUCTED during bootstrap and
              // sits in the tree — and in the accessibility tree — underneath an
              // opaque placeholder. The crossfade stops it being SEEN; this stops
              // it being built. Related conditions, not the same one.
              booting ? null : (
                <EmptyState title="No tasks" body="Tasks filed in your repos show up here." />
              )
            }
          />
        </PullToRefreshBoundary>
      </BootstrapCrossfade>
    </Screen>
  )
}

const styles = StyleSheet.create({
  notice: {
    color: color.textDim,
    fontSize: font.small,
    paddingHorizontal: space.xl,
    paddingBottom: space.sm,
  },
  listContent: {
    flexGrow: 1,
  },
  toggle: {
    ...sans(600),
    // A view filter is not the primary action; it stopped competing with the
    // needs-you yellow and the New Task button [POD-366].
    color: color.textDim,
    fontSize: font.small,
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
    fontSize: font.small,
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
    ...monoLabel(),
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
    lineHeight: leading(font.body),
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
