import { attentionGroup } from '@podium/client-core/focus'
import { sessionCardModel } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/protocol'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useRouter } from 'expo-router'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  X,
} from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native'
import { useMobileClient } from '../client/MobileClientProvider'
import { Icon } from '../components/Icon'
import { IdSquare, type IdSquareState } from '../components/IdSquare'
import { HeaderButton, Screen } from '../components/Screen'
import { BrailleSpinner } from '../components/StatusGlyphs'
import { TaskPeekSheet } from '../components/TaskPeekSheet'
import { EmptyState, Pill, StatusDot } from '../components/ui'
import { buildWorkSections, type WorkIssue } from '../lib/work-sections'
import { FLOW_SLATE, flow, issueColorHex } from '../theme/issueColors'
import { color, font, mono, monoLabel, radius, sans, space } from '../theme/theme'

/** Same key prefix as desktop sidebar tuck (POD-293) so state can align later. */
const tuckKey = (id: string) => `podium:sidebar:tucked:${id}`

function squareState(issue: IssueWire, sessions: SessionMeta[]): IdSquareState {
  if (issue.needsHuman || sessions.some((session) => attentionGroup(session) === 'needsYou')) {
    return 'waiting'
  }
  if (sessions.some((session) => attentionGroup(session) === 'working')) return 'working'
  if (sessions.length > 0) return 'idle'
  if (issue.stage === 'done' || issue.closedReason != null) return 'queued'
  return 'queued'
}

/**
 * Mobile work sidebar / taskbar: issue-first navigation with nested agent
 * sessions, pinned band, sortKey order, and tuck-away for finished work —
 * the phone counterpart of the desktop Work sections.
 */
export function WorkScreen() {
  const router = useRouter()
  const client = useMobileClient()
  const [peek, setPeek] = useState<{ issue: IssueWire; session?: SessionMeta } | null>(null)
  const [tuckedIds, setTuckedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [closedOpen, setClosedOpen] = useState<ReadonlySet<string>>(() => new Set())

  // Hydrate tucked ids from AsyncStorage (mirrors desktop ui-state keys).
  // Reopened work drops a stale tuck so the next close offers Tuck away again.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const next = new Set<string>()
      for (const issue of client.issues) {
        const finished = issue.closedReason != null || issue.stage === 'done'
        try {
          if (!finished) {
            if ((await AsyncStorage.getItem(tuckKey(issue.id))) === 'true') {
              await AsyncStorage.removeItem(tuckKey(issue.id))
            }
            continue
          }
          const v = await AsyncStorage.getItem(tuckKey(issue.id))
          if (v === 'true') next.add(issue.id)
        } catch {
          // Offline storage glitch — skip this id.
        }
      }
      if (!cancelled) setTuckedIds(next)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [client.issues])

  const tuck = useCallback(async (id: string) => {
    try {
      await AsyncStorage.setItem(tuckKey(id), 'true')
    } catch {
      // Still fold optimistically.
    }
    setTuckedIds((prev) => new Set(prev).add(id))
  }, [])

  const togglePin = useCallback(
    async (issue: IssueWire) => {
      try {
        await client.trpc.issues.update.mutate({
          id: issue.id,
          patch: { pinned: !issue.pinned },
        })
      } catch {
        // Store / network will surface via connection banner.
      }
    },
    [client.trpc],
  )

  const sections = useMemo(
    () =>
      buildWorkSections(client.issues, client.sessions, {
        now: Date.now(),
        tuckedIds,
      }),
    [client.issues, client.sessions, tuckedIds],
  )

  const listSections = useMemo(
    () =>
      sections.map((section) => ({
        ...section,
        // Flatten open rows; closed fold is rendered via section footer.
        data: section.data,
      })),
    [sections],
  )

  const issueCount = sections.reduce((total, section) => total + section.data.length, 0)
  const sessionCount = sections.reduce(
    (total, section) =>
      total + section.data.reduce((sectionTotal, row) => sectionTotal + row.sessions.length, 0),
    0,
  )

  const toggleClosed = (key: string) => {
    setClosedOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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
        sections={listSections}
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
        renderSectionFooter={({ section }) => {
          if (section.closed.length === 0) return null
          const open = closedOpen.has(section.key)
          return (
            <View style={styles.closedBlock}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${open ? 'Hide' : 'Show'} closed in ${section.title}`}
                onPress={() => toggleClosed(section.key)}
                style={({ pressed }) => [styles.closedToggle, pressed && styles.pressed]}
              >
                <Icon
                  as={open ? ChevronDown : ChevronRight}
                  size={14}
                  color={color.textFaint}
                />
                <Text style={styles.closedToggleText}>
                  Closed · {section.closed.length}
                </Text>
              </Pressable>
              {open
                ? section.closed.map((row) => (
                    <FoldedRow
                      key={row.issue.id}
                      row={row}
                      onPress={() =>
                        router.push(`/issue/${encodeURIComponent(row.issue.id)}`)
                      }
                    />
                  ))
                : null}
            </View>
          )
        }}
        renderItem={({ item }) => (
          <WorkspaceRow
            row={item}
            onOpenIssue={() => router.push(`/issue/${encodeURIComponent(item.issue.id)}`)}
            onPeek={() => setPeek({ issue: item.issue })}
            onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
            onTuck={item.awaitsTuck ? () => void tuck(item.issue.id) : undefined}
            onTogglePin={() => void togglePin(item.issue)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            title="No active work"
            body="Planning, in-progress, and review tasks appear here with their agents — same list as the desktop sidebar."
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

function FoldedRow({ row, onPress }: { row: WorkIssue; onPress: () => void }) {
  const reason = row.issue.closedReason?.replace(/_/g, ' ') ?? row.issue.stage
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open closed issue ${row.issue.seq}: ${row.issue.title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.foldedRow, pressed && styles.pressed]}
    >
      <Text style={styles.foldedSeq}>#{row.issue.seq}</Text>
      <Text style={styles.foldedTitle} numberOfLines={1}>
        {row.issue.title}
      </Text>
      <Text style={styles.foldedReason}>{reason}</Text>
    </Pressable>
  )
}

function WorkspaceRow({
  row,
  onOpenIssue,
  onPeek,
  onOpenSession,
  onTuck,
  onTogglePin,
}: {
  row: WorkIssue
  onOpenIssue: () => void
  onPeek: () => void
  onOpenSession: (sessionId: string) => void
  onTuck?: () => void
  onTogglePin: () => void
}) {
  const { issue, sessions } = row
  const hex = issueColorHex(issue.color) ?? FLOW_SLATE
  const now = Date.now()

  return (
    <View style={[styles.workspace, { backgroundColor: flow.rowBg(hex) }]}>
      <View style={styles.issueRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open issue ${issue.seq}: ${issue.title}`}
          onPress={onOpenIssue}
          onLongPress={onTogglePin}
          delayLongPress={350}
          style={({ pressed }) => [styles.issueMain, pressed && styles.pressed]}
        >
          <IdSquare issue={issue} state={squareState(issue, sessions)} ringColor={flow.rowBg(hex)} />
          <View style={styles.issueTitles}>
            <Text style={[styles.issueTitle, { color: flow.text(hex) }]} numberOfLines={2}>
              {issue.title}
            </Text>
            <View style={styles.issueMeta}>
              <Pill label={issue.stage.replace('_', ' ')} />
              {issue.needsHuman ? <Pill label="needs human" toneKey="needsYou" /> : null}
              {sessions.length > 0 ? (
                <Text style={[styles.agentCount, { color: flow.muted(hex) }]}>
                  {sessions.length} agent{sessions.length === 1 ? '' : 's'}
                </Text>
              ) : null}
            </View>
          </View>
          <Icon as={ChevronRight} size={16} color={flow.muted(hex)} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={issue.pinned ? `Unpin task ${issue.seq}` : `Pin task ${issue.seq}`}
          onPress={onTogglePin}
          hitSlop={6}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        >
          <Icon
            as={issue.pinned ? PinOff : Pin}
            size={14}
            color={issue.pinned ? color.accent : color.textDim}
          />
        </Pressable>
        {onTuck ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Tuck away finished task ${issue.seq}`}
            onPress={onTuck}
            hitSlop={6}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <Icon as={X} size={15} color={color.textDim} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Peek task ${issue.seq}`}
            onPress={onPeek}
            hitSlop={6}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          >
            <Icon as={Eye} size={15} color={color.textDim} />
          </Pressable>
        )}
      </View>
      {sessions.map((session) => {
        const model = sessionCardModel(session, issue, now)
        return (
          <Pressable
            key={session.sessionId}
            accessibilityRole="button"
            accessibilityLabel={`Open session ${model.title}`}
            onPress={() => onOpenSession(session.sessionId)}
            style={({ pressed }) => [styles.sessionRow, pressed && styles.pressed]}
          >
            <View style={styles.treeStem} />
            <Icon as={MessageSquare} size={13} color={color.textFaint} />
            <View style={styles.sessionTitles}>
              <Text style={styles.sessionTitle} numberOfLines={1}>
                {model.title}
              </Text>
              <Text style={styles.sessionSub} numberOfLines={1}>
                {model.summary ?? model.subtitle}
              </Text>
            </View>
            {model.dotTone === 'working' ? (
              <BrailleSpinner size={10} />
            ) : (
              <StatusDot
                toneKey={
                  model.dotTone === 'attention'
                    ? 'needsYou'
                    : model.dotTone === 'error'
                      ? 'danger'
                      : 'idle'
                }
              />
            )}
          </Pressable>
        )
      })}
    </View>
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
  workspace: {
    marginHorizontal: space.sm + 2,
    marginBottom: 4,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  issueRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
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
    flexWrap: 'wrap',
  },
  agentCount: {
    ...mono(400),
    fontSize: font.micro,
  },
  iconBtn: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: color.border,
  },
  sessionRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 21,
    paddingRight: 11,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  treeStem: {
    width: 8,
    height: 14,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.borderStrong,
    borderBottomLeftRadius: 3,
  },
  sessionTitles: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  sessionTitle: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
  sessionSub: {
    ...sans(400),
    color: color.textFaint,
    fontSize: font.tiny,
  },
  closedBlock: {
    marginHorizontal: space.sm + 2,
    marginBottom: space.sm,
  },
  closedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  closedToggleText: {
    ...monoLabel(9),
    color: color.textFaint,
  },
  foldedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  foldedSeq: {
    ...mono(500),
    color: color.textFaint,
    fontSize: font.micro,
  },
  foldedTitle: {
    ...sans(400),
    flex: 1,
    color: color.textDim,
    fontSize: font.small,
  },
  foldedReason: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
    textTransform: 'uppercase',
  },
  pressed: {
    opacity: 0.65,
  },
})
