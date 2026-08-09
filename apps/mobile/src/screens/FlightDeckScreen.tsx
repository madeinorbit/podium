import { relativeTime } from '@podium/client-core/focus'
import { useSlice } from '@podium/client-core/react'
import {
  buildFlightDeckRows,
  deckIssueState,
  deckSessions,
  type FlightDeckMode,
  type FlightDeckRow,
  formatClock,
  issueNote,
  missionProgress,
  missionRootFor,
  motionPhase,
  presenceNote,
  sessionNeedsHuman,
  sessionRole,
  sessionTitle,
  treeGuides,
  worklistSlice,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronRight, ChevronsDownUp, MoreHorizontal } from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { type DimensionValue, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useBooting, useIssues, useMobileStore, useSessions } from '../client/hooks'
import { Icon } from '../components/Icon'
import { BootstrapCrossfade, DetailSkeleton } from '../components/LaunchPlaceholders'
import { PressableScale } from '../components/PressableScale'
import { HeaderButton, Screen } from '../components/Screen'
import { BAND_PAD, CollapsedPayload, RosterFold, SessionBand, TaskStrip } from '../components/spine'
import { TaskSheet } from '../components/TaskSheet'
import { EmptyState } from '../components/ui'
import { useTabBarInset } from '../hooks/useTabBarInset'
import { applyFolds, coveredByStrip } from '../lib/deck-rows'
import { sessionHref } from '../lib/session-route'
import { FLOW_SLATE, issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import {
  color,
  font,
  leading,
  mono,
  monoLabel,
  radius,
  sans,
  space,
  tracking,
} from '../theme/theme'

/**
 * The Flight Deck, on the phone [POD-592].
 *
 * Every row, state word, count and tree guide here comes from
 * `@podium/client-core/viewmodels`' mission module — the SAME 937 lines the
 * desktop's second column reads (promoted out of `apps/web/src/lib` by this
 * issue). The phone derives nothing of its own, for the same reason the
 * worklist stopped being re-derived per platform in POD-331: two derivations
 * disagree eventually, and the one place an operator decides what to run is the
 * worst place for them to disagree.
 *
 * Only the chrome below is native.
 */

const MODES: Array<{ id: FlightDeckMode; label: string }> = [
  { id: 'full', label: 'Full' },
  { id: 'active', label: 'Active' },
  { id: 'needs-you', label: 'Needs you' },
]

export function FlightDeckScreen() {
  const params = useLocalSearchParams<{ missionId: string | string[] }>()
  const raw = Array.isArray(params.missionId) ? params.missionId[0] : (params.missionId ?? '')
  const selectedId = decodeURIComponent(raw)
  const router = useRouter()
  const booting = useBooting()
  const issues = useIssues()
  const sessions = useSessions()
  const store = useMobileStore()
  const tabBarInset = useTabBarInset()
  // The worktree-path index the worklist already derives once per snapshot —
  // `sessionsForIssueNav` needs it to attribute a shell to its issue, and
  // deriving it a second time here is exactly the per-consumer cost the
  // published slice exists to remove.
  const { allWorktreePaths } = useSlice(worklistSlice)

  const [mode, setMode] = useState<FlightDeckMode>('full')
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const [rosterOpen, setRosterOpen] = useState(false)
  const [peek, setPeek] = useState<IssueWire | null>(null)

  // The mission is the whole subtree above and below the selected task, exactly
  // as the desktop resolves it — open a child from a notification and you land
  // on the same deck the sidebar would have given you.
  const root = useMemo(() => missionRootFor(issues, selectedId), [issues, selectedId])
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])

  const rows = useMemo(
    () => (root ? buildFlightDeckRows(issues, sessions, root.id, mode, allWorktreePaths) : []),
    [issues, sessions, root, mode, allWorktreePaths],
  )
  const progress = useMemo(
    () => missionProgress(issues, sessions, root?.id),
    [issues, sessions, root],
  )

  const shown = useMemo(() => applyFolds(rows, folded), [rows, folded])

  // The root is NOT a strip — the header is its row (POD-516 round 3), so it is
  // dropped from the spine and its agents are rendered directly under the head.
  const spineRows = useMemo(() => shown.filter((r) => r.issue.id !== root?.id), [shown, root])
  const guides = useMemo(() => treeGuides(spineRows), [spineRows])
  const rootRow = useMemo(() => rows.find((r) => r.issue.id === root?.id), [rows, root])

  const toggleFold = useCallback((id: string) => {
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Back from a transcript returns to THIS deck, not to Work — answering an
  // agent and coming back must not cost you your place in a twenty-row spine.
  const openSession = useCallback(
    (session: SessionMeta) => {
      router.push(sessionHref(session.sessionId, `/mission/${encodeURIComponent(selectedId)}`))
    },
    [router, selectedId],
  )

  const openTask = useCallback(
    (issue: IssueWire) => {
      void store.markIssueRead(issue.id)
      setPeek(issue)
    },
    [store.markIssueRead],
  )

  const resolved = root !== undefined || (!booting && issues.length > 0)

  return (
    <Screen
      title={root ? root.title : 'Mission'}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/work'))}
      accent={root ? (issueColorHex(root.color) ?? undefined) : undefined}
      right={
        <HeaderButton label="Mission actions" onPress={() => {}}>
          <Icon as={MoreHorizontal} size={18} color={color.text} />
        </HeaderButton>
      }
    >
      <BootstrapCrossfade resolved={resolved} placeholder={<DetailSkeleton />}>
        {root ? (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ paddingBottom: tabBarInset + space.xl }}
            stickyHeaderIndices={[1]}
          >
            <MissionHead
              root={root}
              progress={progress}
              live={rows.reduce((n, r) => n + r.sessions.filter((s) => !s.archived).length, 0)}
              attention={rootRow?.attentionCount ?? 0}
              onPress={() => openTask(root)}
            />

            <View style={styles.controls}>
              <ModeSegments
                mode={mode}
                onChange={setMode}
                attention={rootRow?.attentionCount ?? 0}
              />
              <PressableScale
                onPress={() =>
                  setFolded((prev) =>
                    prev.size > 0
                      ? new Set()
                      : new Set(
                          rows.filter((r) => r.descendantIds.length > 0).map((r) => r.issue.id),
                        ),
                  )
                }
                accessibilityLabel="Collapse all"
                style={styles.ctlBtn}
              >
                <Icon as={ChevronsDownUp} size={15} color={color.textFaint} />
              </PressableScale>
            </View>

            {/* The root's own agents hang straight off the header — the line
                that leaves the mission block IS their rail. */}
            {rootRow ? (
              <RootRoster
                row={rootRow}
                mode={mode}
                expanded={rosterOpen}
                onToggle={() => setRosterOpen((v) => !v)}
                onOpen={openSession}
              />
            ) : null}

            {spineRows.length === 0 && (rootRow?.sessions.length ?? 0) === 0 ? (
              <EmptyState
                title={mode === 'full' ? 'No subtasks yet.' : 'Nothing matches this view.'}
              />
            ) : null}

            {spineRows.map((row, index) => (
              <SpineRow
                key={row.issue.id}
                row={row}
                carries={guides[index] ?? []}
                stops={!(guides[index + 1] ?? [])[row.depth - 1]}
                mode={mode}
                byId={byId}
                folded={folded.has(row.issue.id)}
                focused={peek?.id === row.issue.id}
                onToggleFold={() => toggleFold(row.issue.id)}
                onOpenTask={openTask}
                onOpenSession={openSession}
              />
            ))}
          </ScrollView>
        ) : (
          <EmptyState title="Mission not found." />
        )}
      </BootstrapCrossfade>

      <TaskSheet
        issue={peek}
        sessions={sessions}
        issues={issues}
        onClose={() => setPeek(null)}
        onOpenSession={(s) => {
          setPeek(null)
          openSession(s)
        }}
      />
    </Screen>
  )
}

/**
 * THE HEADER IS THE ROOT'S ROW. It carries the mission's identity, its subtree
 * progress and the rail every row below hangs from — so the root is never also
 * printed as a strip. Tapping it opens the root task's own inspector, which is
 * the only way in once it has no strip of its own.
 */
function MissionHead({
  root,
  progress,
  live,
  attention,
  onPress,
}: {
  root: IssueWire
  progress: { total: number; done: number; run: number; block: number; wait: number }
  live: number
  attention: number
  onPress: () => void
}) {
  const [open, setOpen] = useState(false)
  const hex = issueColorHex(root.color) ?? FLOW_SLATE
  const total = Math.max(1, progress.total)
  // A numeric template literal, not `.toFixed()`: RN's DimensionValue is
  // `${number}%`, and a string-typed percentage does not satisfy it.
  const seg = (n: number): DimensionValue => `${Math.round((n / total) * 10000) / 100}%`
  return (
    <PressableScale onPress={onPress} scaleTo={0.995} style={styles.head}>
      <View style={styles.ident}>
        <Text style={[styles.chip, styles.chipRef]}>{issueDisplayRef(root)}</Text>
        <Text
          style={[
            styles.chip,
            {
              borderColor: alpha(hex, 0.45),
              color: alpha(hex, 0.95),
              backgroundColor: alpha(hex, 0.12),
            },
          ]}
        >
          {root.stage.replace('_', ' ')}
        </Text>
        <Text style={styles.chip}>P{root.priority}</Text>
        {attention > 0 ? (
          <Text style={[styles.chip, styles.chipAmber]}>{attention} need you</Text>
        ) : null}
        <View style={styles.flex} />
        <Icon as={ChevronRight} size={15} color={color.textMicro} />
      </View>

      {root.description.trim() ? (
        <Text
          numberOfLines={open ? undefined : 3}
          onPress={() => setOpen((v) => !v)}
          style={styles.desc}
        >
          {root.description}
        </Text>
      ) : null}

      {/* Four exclusive segments, from `missionProgress` — done / run / block /
          wait. Never computed from the filtered spine: the filter is a display
          preference, the mission's shape is not. */}
      <View style={styles.bar}>
        <View
          style={[styles.barSeg, { width: seg(progress.done), backgroundColor: color.working }]}
        />
        <View
          style={[
            styles.barSeg,
            { width: seg(progress.run), backgroundColor: alpha(color.working, 0.42) },
          ]}
        />
        <View
          style={[styles.barSeg, { width: seg(progress.block), backgroundColor: color.danger }]}
        />
        <View
          style={[
            styles.barSeg,
            { width: seg(progress.wait), backgroundColor: alpha(color.idle, 0.35) },
          ]}
        />
      </View>
      <Text numberOfLines={1} style={styles.meta}>
        {progress.done}/{progress.total} done
        {progress.run > 0 ? ` · ${progress.run} run` : ''}
        {progress.block > 0 ? ` · ${progress.block} blocked` : ''}
        {live > 0 ? ` · ${live} live` : ''}
      </Text>
    </PressableScale>
  )
}

function ModeSegments({
  mode,
  onChange,
  attention,
}: {
  mode: FlightDeckMode
  onChange: (m: FlightDeckMode) => void
  attention: number
}) {
  return (
    <View style={styles.seg}>
      {MODES.map((m) => {
        const on = m.id === mode
        return (
          <PressableScale
            key={m.id}
            onPress={() => onChange(m.id)}
            scaleTo={0.99}
            accessibilityLabel={m.label}
            style={[styles.segBtn, on ? styles.segBtnOn : null]}
          >
            <Text style={[styles.segLabel, on ? styles.segLabelOn : null]}>{m.label}</Text>
            {m.id === 'needs-you' && attention > 0 ? (
              <Text style={styles.segCount}>{attention}</Text>
            ) : null}
          </PressableScale>
        )
      })}
    </View>
  )
}

/** The root's agents, with the finished ones folded behind a count. */
function RootRoster({
  row,
  mode,
  expanded,
  onToggle,
  onOpen,
}: {
  row: FlightDeckRow
  mode: FlightDeckMode
  expanded: boolean
  onToggle: () => void
  onOpen: (s: SessionMeta) => void
}) {
  const all = deckSessions(row, mode)
  const live = all.filter((s) => !s.archived && s.status !== 'exited')
  const finished = all.filter((s) => s.archived || s.status === 'exited')
  const list = expanded ? [...live, ...finished] : live
  return (
    <View>
      {list.map((session, i) => (
        <Band
          key={session.sessionId}
          row={row}
          session={session}
          depth={0}
          carries={[]}
          stops={i === list.length - 1 && finished.length === 0}
          onPress={() => onOpen(session)}
        />
      ))}
      <RosterFold count={finished.length} expanded={expanded} depth={0} onPress={onToggle} />
    </View>
  )
}

function SpineRow({
  row,
  carries,
  stops,
  mode,
  byId,
  folded,
  focused,
  onToggleFold,
  onOpenTask,
  onOpenSession,
}: {
  row: FlightDeckRow
  carries: readonly boolean[]
  stops: boolean
  mode: FlightDeckMode
  byId: ReadonlyMap<string, IssueWire>
  folded: boolean
  focused: boolean
  onToggleFold: () => void
  onOpenTask: (i: IssueWire) => void
  onOpenSession: (s: SessionMeta) => void
}) {
  const state = deckIssueState(row.issue, row.sessions, byId)
  const note = issueNote(row.issue, byId)
  const bands = folded ? [] : deckSessions(row, mode)
  /**
   * The presence line explains an ABSENCE the strip cannot already account for.
   *
   * On the desktop this note has a column of its own; here it sits directly
   * under a strip that has just said the state word and, when there is one, the
   * issue note. So `blocked` and `waiting` would print "Blocked by 2 tasks"
   * immediately under "Blocked · 2 tasks", and `proposed` would print
   * "Proposed · not started" under "Proposed". Saying it twice in adjacent
   * lines reads as two facts, not one — it is worse than not saying it at all.
   */
  const raw = presenceNote(row.issue, row.sessions, byId)
  const presence = raw && !coveredByStrip(raw, state.label) ? raw : null
  return (
    <View>
      <TaskStrip
        depth={row.depth}
        carries={carries}
        stops={stops && bands.length === 0}
        title={row.issue.title}
        displayRef={issueDisplayRef(row.issue)}
        state={state}
        note={note}
        colorHex={issueColorHex(row.issue.color) ?? undefined}
        focused={focused}
        foldable={row.descendantIds.length > 0}
        folded={folded}
        onPress={() => onOpenTask(row.issue)}
        onToggleFold={onToggleFold}
      />
      {folded ? <CollapsedPayload summary={row.collapsedSummary} depth={row.depth} /> : null}
      {/* A blank where an agent row would be is the one thing the deck must
          never do — "no session" is four situations and only one is a problem. */}
      {!folded && bands.length === 0 && presence ? (
        <Text style={[styles.presence, { marginLeft: BAND_PAD(row.depth) }]} numberOfLines={1}>
          {presence.text}
        </Text>
      ) : null}
      {bands.map((session, i) => (
        <Band
          key={session.sessionId}
          row={row}
          session={session}
          depth={row.depth}
          carries={carries}
          stops={i === bands.length - 1}
          onPress={() => onOpenSession(session)}
        />
      ))}
    </View>
  )
}

function Band({
  row,
  session,
  depth,
  carries,
  stops,
  onPress,
}: {
  row: FlightDeckRow
  session: SessionMeta
  depth: number
  carries: readonly boolean[]
  stops: boolean
  onPress: () => void
}) {
  const phase = motionPhase(session)
  const asking = sessionNeedsHuman(session)
  const working = phase === 'working'
  const role = sessionRole(row.issue, session, {
    rootId: row.depth === 0 ? row.issue.id : null,
    siblings: row.sessions,
    inMission: new Set(row.sessions.map((s) => s.sessionId)),
  })
  return (
    <SessionBand
      depth={depth}
      carries={carries}
      stops={stops}
      name={sessionTitle(session)}
      role={role}
      kind={session.agentKind}
      asking={asking}
      working={working}
      right={stamp(session, phase, working, asking)}
      onPress={onPress}
    />
  )
}

/**
 * The right-hand slot: a running clock only while an agent computes, the age of
 * a stop while it waits, and the compute total once it is done. Nothing while
 * queued — the dimmed row already says it.
 */
function stamp(
  session: SessionMeta,
  phase: ReturnType<typeof motionPhase>,
  working: boolean,
  asking: boolean,
): string | null {
  const state = session.agentState
  if (working) {
    const since = state?.since ? Date.parse(state.since) : Number.NaN
    if (!Number.isFinite(since)) return null
    return formatClock(Math.max(0, Date.now() - since) + (state?.workingMsTotal ?? 0))
  }
  if (asking) return null
  if (phase === 'done' && state?.workingMsTotal) return `∑ ${formatClock(state.workingMsTotal)}`
  return relativeTime(session.lastActiveAt, Date.now())
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  flex: { flex: 1 },

  head: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  ident: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 9 },
  chip: {
    ...mono(400),
    fontSize: font.micro,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    color: color.textDim,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  chipRef: { ...mono(600), color: color.body },
  chipAmber: {
    borderColor: color.accentBorder,
    color: color.accent,
    backgroundColor: color.accentSoft,
  },
  desc: {
    ...sans(400),
    fontSize: font.small,
    lineHeight: leading(15),
    letterSpacing: tracking[15],
    color: color.textDim,
  },
  bar: {
    flexDirection: 'row',
    height: 3,
    borderRadius: 2,
    marginTop: space.md,
    backgroundColor: alpha(color.border, 0.65),
    overflow: 'hidden',
  },
  barSeg: { height: '100%' },
  meta: { ...monoLabel(font.micro), textTransform: 'none', color: color.textMicro, marginTop: 7 },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    backgroundColor: color.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  seg: {
    flex: 1,
    flexDirection: 'row',
    height: 32,
    padding: 2,
    borderRadius: 9,
    backgroundColor: color.bgSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  segBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 7,
  },
  segBtnOn: {
    backgroundColor: color.surfaceHigh,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
  },
  segLabel: { ...sans(600), fontSize: font.tiny, color: color.textFaint },
  segLabelOn: { color: color.text },
  segCount: {
    ...mono(600),
    fontSize: 10,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: color.accent,
    color: color.onAccent,
  },
  ctlBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bgSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },

  presence: {
    ...mono(400),
    fontSize: font.micro,
    color: color.textMicro,
    paddingBottom: space.sm,
    paddingRight: space.md,
  },
})
