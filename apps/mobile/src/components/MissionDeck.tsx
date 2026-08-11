import { relativeTime } from '@podium/client-core/focus'
import {
  buildFlightDeckRows,
  deckIssueState,
  deckSessions,
  type FlightDeckMode,
  type FlightDeckRow,
  formatClock,
  issueNote,
  motionPhase,
  presenceNote,
  sessionNeedsHuman,
  sessionRole,
  sessionTitle,
  treeGuides,
} from '@podium/client-core/viewmodels'
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { ChevronsDownUp, Plus } from 'lucide-react-native'
import { useCallback, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { applyFolds, coveredByStrip } from '../lib/deck-rows'
import { issueColorHex } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { BAND_PAD, CollapsedPayload, RosterFold, SessionBand, TaskStrip } from './spine'
import { EmptyState } from './ui'

/**
 * THE FLIGHT DECK, as the mission screen's pull-down panel [POD-592, POD-724].
 *
 * Every row, state word, count and tree guide comes from the mission module in
 * `@podium/client-core/viewmodels` — the same lines the desktop's second column
 * reads. The phone derives nothing of its own, for the reason the worklist
 * stopped being re-derived per platform in POD-331: two derivations disagree
 * eventually, and the one place an operator decides what to run is the worst
 * place for them to disagree. Only the chrome here is native.
 *
 * What POD-724 changed is where it LIVES. It used to be the whole screen you
 * landed on from Work, with the transcript a push behind it — so the ordinary
 * act of answering an agent cost two navigations, and the deck's real power
 * (seeing the subtree while you talk to one of its agents) was never available
 * at the same time as the talking. Now the deck is a panel over the
 * conversation and its session bands SWITCH the transcript in place, which is
 * the thing a phone can do that a desktop column cannot.
 */

const MODES: Array<{ id: FlightDeckMode; label: string }> = [
  { id: 'full', label: 'Full' },
  { id: 'active', label: 'Active' },
  { id: 'needs-you', label: 'Needs you' },
]

export function MissionDeck({
  root,
  issues,
  sessions,
  allWorktreePaths,
  currentSessionId,
  onOpenSession,
  onOpenTask,
  onLaunchAgent,
}: {
  root: IssueWire
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  allWorktreePaths: string[]
  /** The session the conversation underneath is showing — the deck marks it so
   *  the panel answers "where am I" as well as "what else is there". */
  currentSessionId: SessionId | undefined
  onOpenSession: (session: SessionMeta) => void
  onOpenTask: (issue: IssueWire) => void
  onLaunchAgent: () => void
}) {
  const [mode, setMode] = useState<FlightDeckMode>('full')
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const [rosterOpen, setRosterOpen] = useState(false)

  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  const rows = useMemo(
    () => buildFlightDeckRows([...issues], [...sessions], root.id, mode, allWorktreePaths),
    [issues, sessions, root.id, mode, allWorktreePaths],
  )
  const shown = useMemo(() => applyFolds(rows, folded), [rows, folded])
  // The root is NOT a strip — the mission bar above is its row, so it is dropped
  // from the spine and its agents hang directly off the head.
  const spineRows = useMemo(() => shown.filter((r) => r.issue.id !== root.id), [shown, root.id])
  const guides = useMemo(() => treeGuides(spineRows), [spineRows])
  const rootRow = useMemo(() => rows.find((r) => r.issue.id === root.id), [rows, root.id])

  const toggleFold = useCallback((id: string) => {
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <View style={styles.panel}>
      <View style={styles.controls}>
        <View style={styles.seg}>
          {MODES.map((m) => {
            const on = m.id === mode
            return (
              <PressableScale
                key={m.id}
                onPress={() => setMode(m.id)}
                scaleTo={0.99}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={m.label}
                style={[styles.segBtn, on ? styles.segBtnOn : null]}
              >
                <Text style={[styles.segLabel, on ? styles.segLabelOn : null]} numberOfLines={1}>
                  {m.label}
                </Text>
                {m.id === 'needs-you' && (rootRow?.attentionCount ?? 0) > 0 ? (
                  <Text style={styles.segCount}>{rootRow?.attentionCount}</Text>
                ) : null}
              </PressableScale>
            )
          })}
        </View>
        <PressableScale
          onPress={() =>
            setFolded((prev) =>
              prev.size > 0
                ? new Set()
                : new Set(rows.filter((r) => r.descendantIds.length > 0).map((r) => r.issue.id)),
            )
          }
          accessibilityRole="button"
          accessibilityLabel="Collapse all"
          style={styles.ctlBtn}
        >
          <Icon as={ChevronsDownUp} size={15} color={color.textFaint} />
        </PressableScale>
        {/* ICON ONLY, and the label is the reason. "+ Agent" cost about 50pt of
            a 390pt row, which is exactly what "Needs you" needed to stay on one
            line — and a segmented control whose third tab wraps to two lines
            makes the whole row taller than the controls beside it. The amber
            fill already says "this is the primary action here", and it is the
            only amber on the panel. */}
        <PressableScale
          onPress={onLaunchAgent}
          accessibilityRole="button"
          accessibilityLabel="Launch an agent on this mission"
          hitSlop={8}
          style={({ pressed }) => [styles.launch, pressed && styles.launchPressed]}
        >
          <Icon as={Plus} size={17} color={color.onAccent} />
        </PressableScale>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* The root's own agents hang straight off the mission bar — the line
            that leaves the bar IS their rail. */}
        {rootRow ? (
          <RootRoster
            row={rootRow}
            mode={mode}
            expanded={rosterOpen}
            currentSessionId={currentSessionId}
            onToggle={() => setRosterOpen((v) => !v)}
            onOpen={onOpenSession}
          />
        ) : null}

        {spineRows.length === 0 && (rootRow?.sessions.length ?? 0) === 0 ? (
          <EmptyState title={mode === 'full' ? 'No subtasks yet.' : 'Nothing matches this view.'} />
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
            currentSessionId={currentSessionId}
            onToggleFold={() => toggleFold(row.issue.id)}
            onOpenTask={onOpenTask}
            onOpenSession={onOpenSession}
          />
        ))}
      </ScrollView>
    </View>
  )
}

/** The root's agents, with the finished ones folded behind a count. */
function RootRoster({
  row,
  mode,
  expanded,
  currentSessionId,
  onToggle,
  onOpen,
}: {
  row: FlightDeckRow
  mode: FlightDeckMode
  expanded: boolean
  currentSessionId: SessionId | undefined
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
          current={session.sessionId === currentSessionId}
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
  currentSessionId,
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
  currentSessionId: SessionId | undefined
  onToggleFold: () => void
  onOpenTask: (i: IssueWire) => void
  onOpenSession: (s: SessionMeta) => void
}) {
  const state = deckIssueState(row.issue, row.sessions, byId)
  const note = issueNote(row.issue, byId)
  const bands = folded ? [] : deckSessions(row, mode)
  /**
   * The presence line explains an ABSENCE the strip cannot already account for.
   * It sits directly under a strip that has just said the state word, so
   * `blocked` and `waiting` would print "Blocked by 2 tasks" immediately under
   * "Blocked · 2 tasks". Saying it twice in adjacent lines reads as two facts,
   * not one — worse than not saying it at all.
   */
  const raw = presenceNote(row.issue, row.sessions, byId)
  const presence = raw && !coveredByStrip(raw, state.label) ? raw : null
  const focused = bands.some((s) => s.sessionId === currentSessionId)
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
          current={session.sessionId === currentSessionId}
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
  current,
  onPress,
}: {
  row: FlightDeckRow
  session: SessionMeta
  depth: number
  carries: readonly boolean[]
  stops: boolean
  current: boolean
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
    <View style={current ? styles.currentBand : null}>
      <SessionBand
        depth={depth}
        carries={carries}
        stops={stops}
        name={sessionTitle(session)}
        role={role}
        kind={session.agentKind}
        asking={asking}
        working={working}
        right={current ? 'reading' : stamp(session, phase, working, asking)}
        onPress={onPress}
      />
    </View>
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
  panel: {
    flex: 1,
    minHeight: 0,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
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
  segLabel: { ...sans(600), fontSize: font.tiny, color: color.textFaint, flexShrink: 1 },
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
  // The deck's ONE primary action, and the only amber on the panel: launching an
  // agent is what the operator came here to be able to do without leaving the
  // conversation.
  launch: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: color.accent,
  },
  launchPressed: {
    opacity: 0.82,
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: space.xl },
  // The band whose transcript is showing underneath. A wash, not a rule: the
  // spine already draws real tree guides at fixed x, and a left border here
  // would shift the marked band's rail out of line with every other one — the
  // "you are here" mark must not move the map.
  currentBand: {
    backgroundColor: alpha(color.working, 0.12),
  },
  presence: {
    ...mono(400),
    fontSize: font.micro,
    color: color.textMicro,
    paddingBottom: space.sm,
    paddingRight: space.md,
  },
})
