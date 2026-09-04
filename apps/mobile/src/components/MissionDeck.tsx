import { relativeTime } from '@podium/client-core/focus'
import { FLIGHT_DECK_FOLDS_KEY, FLIGHT_DECK_MODE_KEY } from '@podium/client-core/ui-state'
import {
  buildFlightDeckRows,
  continuationPresenceLine,
  deckIssueState,
  deckSessions,
  deckViewEmptyLine,
  type FlightDeckFoldMap,
  type FlightDeckFoldState,
  type FlightDeckMode,
  type FlightDeckRow,
  flightDeckRowHasPayload,
  flightDeckRowIsFolded,
  formatClock,
  type IssueContinuation,
  isCoordinatorSession,
  issueAbandoned,
  issueContinuation,
  issueNote,
  missionDepartures,
  motionPhase,
  presenceNote,
  readFlightDeckFolds,
  sessionAsksOnIssue,
  sessionRole,
  sessionSettled,
  sessionTitle,
  treeGuides,
  writeFlightDeckFolds,
} from '@podium/client-core/viewmodels'
import type { IssueId, IssueWire, SessionId, SessionMeta } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { memo, useCallback, useEffect, useMemo } from 'react'
import { ArrowDown, Check, ChevronsDownUp, ChevronsUpDown, Plus, X } from './icons'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { usePersistedUiState } from '../hooks/usePersistedUiState'
import { applyFolds, deckContentHeight } from '../lib/deck-rows'
import { stageColor } from '../theme/stage'
import { color, font, mono, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import {
  DeckSection,
  isLead,
  ProposalRow,
  type Rail,
  type RailTone,
  ROOT_RAIL,
  railFor,
  roleLabel,
  SessionBand,
  seatFor,
  TaskStrip,
} from './spine'
import { EmptyState } from './ui'

/** A {@link Rail} as the style a plain `View` draws it with. */
const toRailStyle = (rail: Rail) => ({ width: rail.width, backgroundColor: rail.color })

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
 *
 * POD-767 brings it onto the LEAD RAIL the web deck landed in POD-758, so the
 * same mission reads the same on both. Two fills and no more — grey for a task
 * in every state, fuchsia for a proposal — with selection and attention as
 * square ticks in the rail's gutter, a lead's branch drawn in the mission
 * accent, agent rows reduced to contents rather than objects, a census behind
 * every fold, and proposals sunk to a tail that names who filed them.
 */

const MODES: Array<{ id: FlightDeckMode; label: string }> = [
  { id: 'full', label: 'Full' },
  { id: 'working', label: 'Working' },
  { id: 'needs-you', label: 'Needs you' },
]

/** Whether a task has anything to fold at all. A payload-less strip draws no
 *  chevron, so "collapse all" must not claim to have folded it either. */
const hasPayload = flightDeckRowHasPayload

/** `active` is `working`'s old id (POD-1452), still read so an operator who had
 *  chosen that view does not silently land back on `Full`. */
const readMode = (raw: string | null): FlightDeckMode =>
  raw === 'active' ? 'working' : raw === 'working' || raw === 'needs-you' ? raw : 'full'
const writeMode = (mode: FlightDeckMode): string | null => (mode === 'full' ? null : mode)

export const MissionDeck = memo(function MissionDeck({
  root,
  issues,
  sessions,
  allWorktreePaths,
  accent,
  currentSessionId,
  onOpenSession,
  onOpenTask,
  onOpenTaskMenu,
  onLaunchAgent,
  onTuckRoot,
  onFileRoot,
  onOpenDeparture,
  onContentHeight,
}: {
  root: IssueWire
  issues: readonly IssueWire[]
  sessions: readonly SessionMeta[]
  allWorktreePaths: string[]
  /** The mission's own accent — what the lead rail and every tick are drawn in. */
  accent: string
  /** The session the conversation underneath is showing — the deck marks it so
   *  the panel answers "where am I" as well as "what else is there". */
  currentSessionId: SessionId | undefined
  onOpenSession: (session: SessionMeta) => void
  onOpenTask: (issue: IssueWire) => void
  onOpenTaskMenu?: (issue: IssueWire) => void
  onLaunchAgent: () => void
  onTuckRoot: () => void
  onFileRoot: () => void
  onOpenDeparture: (issueId: IssueId) => void
  /** The deck's natural height, re-reported whenever the rows it renders
   *  change — the mission screen sizes and animates the panel from it. */
  onContentHeight: (height: number) => void
}) {
  const [mode, setMode] = usePersistedUiState<FlightDeckMode>(
    FLIGHT_DECK_MODE_KEY,
    readMode,
    writeMode,
  )
  const [folds, setFolds] = usePersistedUiState<FlightDeckFoldMap>(
    FLIGHT_DECK_FOLDS_KEY,
    readFlightDeckFolds,
    writeFlightDeckFolds,
  )

  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])
  // UNSPREAD ON PURPOSE: the engine memoizes per (issues, sessions) ARRAY
  // IDENTITY — copying here would mint fresh identities and defeat that cache.
  const rows = useMemo(
    () => buildFlightDeckRows(issues, sessions, root.id, mode, allWorktreePaths),
    [issues, sessions, root.id, mode, allWorktreePaths],
  )
  const shown = useMemo(() => applyFolds(rows, folds), [rows, folds])
  /**
   * PROPOSALS SINK. A childless proposal leaves the sibling order and collects
   * in a tail at the bottom of the spine: work being offered to the operator is
   * not part of the mission's SHAPE, and interleaving it with the shape is what
   * made a proposal read as a task somebody had started. One with sub-tasks
   * stays in the tree, because by then it is holding structure up.
   */
  const proposalIds = useMemo(
    () =>
      new Set(
        rows
          .filter((r) => r.issue.stage === 'proposed' && r.descendantIds.length === 0)
          .map((r) => r.issue.id),
      ),
    [rows],
  )
  const proposals = useMemo(
    () => rows.filter((r) => proposalIds.has(r.issue.id)),
    [rows, proposalIds],
  )
  // The root is NOT a strip — the mission bar above is its row, so it is dropped
  // from the spine and its agents hang directly off the head.
  const spineRows = useMemo(
    () => shown.filter((r) => r.issue.id !== root.id && !proposalIds.has(r.issue.id)),
    [shown, root.id, proposalIds],
  )
  // Computed over the rows that ACTUALLY render: a fold or a filter changes which
  // strip is the last child of its branch, and a rail that outlives its last
  // child is the tell that the tree was drawn from data rather than from layout.
  const guides = useMemo(() => treeGuides(spineRows), [spineRows])
  const rootRow = useMemo(() => rows.find((r) => r.issue.id === root.id), [rows, root.id])

  /**
   * THE TASKS THAT HAVE A LEAD — the set the coloured rails are drawn from.
   *
   * A designated coordinator whose session has exited is not leading anything,
   * so the predicate is over LIVE sessions: a rail that stayed lit after its
   * lead went home would be the deck asserting somebody is driving when nobody
   * is, which is the one thing this device must never do.
   */
  const ledIssueIds = useMemo(() => {
    const led = new Set<string>()
    for (const row of rows) {
      const hasLead = row.sessions.some(
        (s) => !s.archived && s.status !== 'exited' && isCoordinatorSession(row.issue, s.sessionId),
      )
      if (hasLead) led.add(row.issue.id)
    }
    return led
  }, [rows])
  const leadTone = useCallback(
    (issueId: IssueId | undefined): RailTone =>
      issueId === undefined || !ledIssueIds.has(issueId)
        ? null
        : issueId === root.id
          ? 'mission'
          : 'task',
    [ledIssueIds, root.id],
  )
  /**
   * WHICH TASK OWNS THE RAIL AT EACH LEVEL of each rendered row.
   *
   * The rail at level L descends from the node at depth L-1 — level 1 from the
   * mission root, level 2 from the depth-1 ancestor — so colouring a lead's
   * branch means knowing each row's ancestry, which the flat row list does not
   * carry. Rebuilt here from depth alone, over the rows that actually render,
   * for the same reason `treeGuides` is: a filtered spine has a different tree.
   *
   * One entry longer than the row's depth: the last is the tone of the row's
   * OWN descent, which is the line its agents hang on.
   */
  const rails = useMemo(() => {
    const trail: (IssueId | undefined)[] = [root.id]
    return spineRows.map((row) => {
      trail.length = row.depth
      trail[row.depth] = row.issue.id
      const tones: RailTone[] = []
      for (let level = 1; level <= row.depth + 1; level += 1) tones.push(leadTone(trail[level - 1]))
      return tones
    })
  }, [spineRows, root.id, leadTone])

  /** A session's name, for the roles that are named by another session (a spawn
   *  edge) rather than by the issue. */
  const nameOf = useCallback(
    (sessionId: SessionId) => {
      const found = sessions.find((s) => s.sessionId === sessionId)
      return found ? sessionTitle(found) : undefined
    },
    [sessions],
  )
  /** A proposal names the session that filed it, because the ref is how you go
   *  and ask it why. Unresolvable (a human create, or an agent long gone) means
   *  no author line rather than a raw session id. */
  const authorOf = useCallback(
    (issue: IssueWire): string | null => {
      const id = issue.startedBySession
      if (!id) return null
      return sessions.find((s) => s.sessionId === id)?.displayRef?.trim() || null
    },
    [sessions],
  )

  const toggleFold = useCallback(
    (row: FlightDeckRow) => {
      const next = new Map(folds)
      next.set(row.issue.id, flightDeckRowIsFolded(row, folds) ? 'open' : 'closed')
      setFolds(next)
    },
    [folds, setFolds],
  )

  // THE HEADER'S AGENTS OBEY THE VIEW BAR (POD-1356), which they did not: the
  // roster was read with `matched` forced true, so every agent hanging off the
  // mission survived every view. On the one-task mission — which most missions
  // are — that made `Full`, `Active` and `Needs you` render the same screen, and
  // the bar read as broken because on that mission it WAS.
  //
  // The root's ROW is still unfilterable, and that is a different thing: the
  // header names which mission is on screen and says so in every view. What the
  // view narrows is the crew under it, which is content — the same rule POD-758
  // wrote down when it took the roster's own disclosure away and said the view
  // bar is what removes an agent from the deck.
  const rootSessions = rootRow ? deckSessions(rootRow, mode) : []
  const foldable = useMemo(
    () =>
      rows.filter(
        (row) => row.issue.id !== root.id && !proposalIds.has(row.issue.id) && hasPayload(row),
      ),
    [proposalIds, root.id, rows],
  )
  const allFolded =
    foldable.length > 0 && foldable.every((row) => flightDeckRowIsFolded(row, folds))
  const rootEmptyNote = rootRow
    ? presenceNote(rootRow.issue, rootRow.sessions, byId, sessions)
    : null
  const rootRetired = rootEmptyNote?.kind === 'done'
  const rootContinuation = issueContinuation(root, byId, sessions)
  const allDepartures = useMemo(
    () => missionDepartures(issues, sessions, root.id, allWorktreePaths),
    [allWorktreePaths, issues, root.id, sessions],
  )
  const continuationTargetId = rootContinuation?.target?.id
  const departures = useMemo(
    () => allDepartures.filter((departure) => departure.issue.id !== continuationTargetId),
    [allDepartures, continuationTargetId],
  )
  const continuationState =
    allDepartures.find((departure) => departure.issue.id === continuationTargetId)?.state ?? null
  const rootFinished = Boolean(root.closedReason || root.stage === 'done')

  // WHAT THE DECK IS ABOUT TO RENDER, COUNTED — the same predicates the JSX
  // below uses, so the height the panel animates to and the rows that appear
  // in it cannot disagree. Rows are fixed-height constants, which is what lets
  // this be arithmetic instead of an onLayout round trip.
  const emptyBlock = spineRows.length === 0 && rootSessions.length === 0 && proposals.length === 0
  const contentHeight = deckContentHeight({
    strips: spineRows.length,
    bands:
      rootSessions.length +
      spineRows.reduce(
        (n, row) => n + (flightDeckRowIsFolded(row, folds) ? 0 : deckSessions(row, mode).length),
        0,
      ),
    proposals: proposals.length,
    departures: departures.length,
    signposts:
      (rootContinuation ? 1 : 0) + (emptyBlock && !rootContinuation && rootRetired ? 1 : 0),
    sections: (proposals.length > 0 ? 1 : 0) + (rootContinuation || departures.length > 0 ? 1 : 0),
    empty: emptyBlock && !rootContinuation && !rootRetired,
  })
  useEffect(() => {
    onContentHeight(contentHeight)
  }, [contentHeight, onContentHeight])

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
                // `aria-pressed`, not `aria-selected`, and beside `accessibilityState` rather
                // than instead of it. react-native-web 0.21 reads only the `aria-*` spelling,
                // so the web build announced no state at all; and `aria-selected` is only
                // valid on a listbox/tab/grid role, so on a `button` it is ignored — the
                // browser-visible way to say a button is the chosen one is `aria-pressed`.
                // React Native still reads `accessibilityState` on device. [POD-1664]
                accessibilityState={{ selected: on }}
                aria-pressed={on}
                accessibilityLabel={m.label}
                style={[styles.segBtn, on ? styles.segBtnOn : null]}
              >
                <Text style={[styles.segLabel, on ? styles.segLabelOn : null]} numberOfLines={1}>
                  {m.label}
                </Text>
              </PressableScale>
            )
          })}
        </View>
        <PressableScale
          onPress={() =>
            setFolds(
              new Map(
                foldable.map((row): [string, FlightDeckFoldState] => [
                  row.issue.id,
                  allFolded ? 'open' : 'closed',
                ]),
              ),
            )
          }
          accessibilityRole="button"
          accessibilityLabel={allFolded ? 'Expand every branch' : 'Fold every branch'}
          disabled={foldable.length === 0}
          style={styles.ctlBtn}
        >
          <Icon
            as={allFolded ? ChevronsUpDown : ChevronsDownUp}
            size={15}
            color={color.textFaint}
          />
        </PressableScale>
        {/* ICON ONLY, and the label is the reason. "+ Agent" cost about 50pt of
            a 390pt row, which is exactly what "Needs you" needed to stay on one
            line — and a segmented control whose third tab wraps to two lines
            makes the whole row taller than the controls beside it. The bisque
            fill already says "this is the primary action here", and it is the
            only accent on the panel. */}
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
        {/* The rail crosses the list's own top padding, joining the first visible
            member without borrowing a line from the controls above the tree. */}
        <View style={styles.topRail}>
          <View
            style={[
              styles.topRailLine,
              { left: ROOT_RAIL, ...toRailStyle(railFor(leadTone(root.id), accent)) },
            ]}
          />
        </View>

        {/* THE MISSION'S OWN AGENTS, hanging off the mission bar — the line that
            leaves the bar IS their rail, and it carries on into the first child
            below.

            NOTHING IS HIDDEN HERE (POD-758/POD-767). This block used to fold its
            finished agents away behind an "N finished" line, because every
            session the mission ever had hangs off the header and on a long
            mission that was a screen of retired rows before the first task. The
            phone answers the same problem the way the desktop does instead:
            settled agents stay, one tier dimmer, and what removes them is the
            view bar above. A second, in-view disclosure that hid what the
            chosen view had just promised to show was the duplication — and a
            phone-only one would have put the two decks back out of step, which
            is the whole reason this work exists. */}
        {rootRow
          ? rootSessions.map((session, i) => (
              <Band
                key={session.sessionId}
                row={rootRow}
                session={session}
                depth={0}
                carries={[]}
                rails={[leadTone(root.id)]}
                accent={accent}
                nameOf={nameOf}
                // The root's rail carries on into the spine below it, so the
                // last agent's elbow must not close the line.
                stops={i === rootSessions.length - 1 && spineRows.length === 0}
                current={session.sessionId === currentSessionId}
                onPress={() => onOpenSession(session)}
              />
            ))
          : null}

        {spineRows.length === 0 && rootSessions.length === 0 && proposals.length === 0 ? (
          rootContinuation ? null : rootRetired ? (
            <RetiredSignpost abandoned={issueAbandoned(root)} onTuck={onTuckRoot} />
          ) : (
            <EmptyState
              title={
                deckViewEmptyLine(mode, rootRow?.waitingAgentCount ?? 0) ??
                rootEmptyNote?.text ??
                'No sessions or sub-tasks are attached.'
              }
            />
          )
        ) : null}

        {spineRows.map((row, index) => (
          <SpineRow
            key={row.issue.id}
            row={row}
            carries={guides[index] ?? []}
            rails={rails[index] ?? []}
            accent={accent}
            stops={!(guides[index + 1] ?? [])[row.depth - 1]}
            childFollows={(spineRows[index + 1]?.depth ?? 0) > row.depth}
            mode={mode}
            byId={byId}
            nameOf={nameOf}
            folded={flightDeckRowIsFolded(row, folds)}
            currentSessionId={currentSessionId}
            onToggleFold={() => toggleFold(row)}
            onOpenTask={onOpenTask}
            onOpenTaskMenu={onOpenTaskMenu}
            onOpenSession={onOpenSession}
          />
        ))}

        {proposals.length > 0 ? (
          <DeckSection label="Proposed" count={proposals.length} tone={stageColor('proposed')}>
            {proposals.map((row) => (
              <ProposalRow
                key={row.issue.id}
                title={row.issue.title}
                displayRef={issueDisplayRef(row.issue)}
                author={authorOf(row.issue)}
                selected={false}
                onPress={() => onOpenTask(row.issue)}
              />
            ))}
          </DeckSection>
        ) : null}

        {rootContinuation || departures.length > 0 ? (
          <DeckSection
            label="Where the work went"
            count={departures.length + (rootContinuation ? 1 : 0)}
          >
            {rootContinuation ? (
              <ContinuationSignpost
                continuation={rootContinuation}
                state={continuationState?.label ?? null}
                finished={rootFinished}
                sessions={rootRow?.sessions ?? []}
                onOpen={(id) => onOpenDeparture(id)}
                onFile={onFileRoot}
              />
            ) : null}
            {departures.map((departure) => (
              <DepartureRow
                key={departure.issue.id}
                displayRef={issueDisplayRef(departure.issue)}
                title={departure.issue.title}
                state={departure.state.label}
                attention={departure.state.attention}
                onPress={() => onOpenDeparture(departure.issue.id)}
              />
            ))}
          </DeckSection>
        ) : null}
      </ScrollView>
    </View>
  )
})

function SpineRow({
  row,
  carries,
  rails,
  accent,
  stops,
  childFollows,
  mode,
  byId,
  nameOf,
  folded,
  currentSessionId,
  onToggleFold,
  onOpenTask,
  onOpenTaskMenu,
  onOpenSession,
}: {
  row: FlightDeckRow
  carries: readonly boolean[]
  rails: readonly RailTone[]
  accent: string
  stops: boolean
  /** Whether the next RENDERED row is a child of this task. Its agents and its
   *  children share one line, so the line has to survive the gap between this
   *  block and the next row instead of stopping at the last agent's elbow. */
  childFollows: boolean
  mode: FlightDeckMode
  byId: ReadonlyMap<string, IssueWire>
  nameOf: (sessionId: SessionId) => string | undefined
  folded: boolean
  currentSessionId: SessionId | undefined
  onToggleFold: () => void
  onOpenTask: (i: IssueWire) => void
  onOpenTaskMenu?: (i: IssueWire) => void
  onOpenSession: (s: SessionMeta) => void
}) {
  const state = deckIssueState(row.issue, row.sessions, byId)
  const context = mode !== 'full' && !row.matched
  const note = context ? null : issueNote(row.issue, byId, row.sessions)
  const bands = folded ? [] : deckSessions(row, mode)
  // The seat is held for work that could be picked up — never under a proposal,
  // and never to restate a dependency the strip has already named above it.
  const seat =
    context || row.issue.stage === 'proposed'
      ? null
      : seatFor(presenceNote(row.issue, row.sessions, byId))
  // A FOLDED BRANCH REPORTS LIVE STATE, not the count already in its payload:
  // "2 running" is the thing the fold is hiding, and `3 tasks` is printed on the
  // same line beside it.
  const liveWord =
    folded && row.descendantIds.length > 0 && row.workingAgentCount > 0
      ? `${row.workingAgentCount} running`
      : undefined
  const selected = bands.some((s) => s.sessionId === currentSessionId)
  // NO GAP BETWEEN BLOCKS, deliberately. Every row draws the rails crossing it
  // inside its own band, so the tree is continuous only while the rows are
  // flush: a few points of breathing room between task blocks would cut every
  // ancestor line in the column at exactly that point.
  return (
    <View>
      <TaskStrip
        depth={row.depth}
        carries={carries}
        rails={rails}
        accent={accent}
        // The strip's own rail is its PARENT's descent, at the parent's x. It
        // ends at this elbow when no sibling follows — the agents and children
        // below hang one step further in, on a different line.
        stops={stops}
        title={row.issue.title}
        displayRef={issueDisplayRef(row.issue)}
        stage={row.issue.stage}
        state={state}
        note={note}
        seat={seat}
        summary={row.collapsedSummary}
        folded={folded}
        liveWord={liveWord}
        selected={selected}
        context={context}
        foldable={hasPayload(row)}
        onPress={() => onOpenTask(row.issue)}
        onLongPress={context ? undefined : () => onOpenTaskMenu?.(row.issue)}
        onToggleFold={onToggleFold}
      />
      {bands.map((session, i) => (
        <Band
          key={session.sessionId}
          row={row}
          session={session}
          depth={row.depth}
          carries={carries}
          rails={rails}
          accent={accent}
          nameOf={nameOf}
          stops={i === bands.length - 1 && !childFollows}
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
  rails,
  accent,
  nameOf,
  stops,
  current,
  onPress,
}: {
  row: FlightDeckRow
  session: SessionMeta
  depth: number
  carries: readonly boolean[]
  rails: readonly RailTone[]
  accent: string
  nameOf: (sessionId: SessionId) => string | undefined
  stops: boolean
  current: boolean
  onPress: () => void
}) {
  const phase = motionPhase(session)
  // Asked ON THIS TASK: a closed one never asks, however long its offer has been
  // standing (POD-1072).
  const asking = sessionAsksOnIssue(row.issue, session)
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
      rails={rails}
      accent={accent}
      stops={stops}
      name={sessionTitle(session)}
      displayRef={session.displayRef?.trim() || undefined}
      role={role}
      roleText={roleLabel(role, nameOf)}
      kind={session.agentKind}
      asking={asking}
      working={working}
      settled={sessionSettled(session)}
      lead={isLead(role)}
      // `sessionRole` only ever returns `coordinator` at the mission root — a
      // task's lead is `phase-lead` — so this IS "the mission's own lead".
      coordinator={role?.kind === 'coordinator'}
      current={current}
      right={current ? 'reading' : stamp(session, phase, working, asking)}
      onPress={onPress}
    />
  )
}

function ContinuationSignpost({
  continuation,
  state,
  finished,
  sessions,
  onOpen,
  onFile,
}: {
  continuation: IssueContinuation
  state: string | null
  finished: boolean
  sessions: readonly SessionMeta[]
  onOpen: (issueId: IssueId) => void
  onFile: () => void
}) {
  const target = continuation.target
  return (
    <View style={styles.signpost}>
      <View style={styles.signpostHead}>
        <View style={styles.signpostIcon}>
          <Icon as={ArrowDown} size={13} color={color.textDim} />
        </View>
        <View style={styles.signpostCopy}>
          <View style={styles.signpostTitleRow}>
            <Text numberOfLines={2} style={styles.signpostTitle}>
              {continuation.full}
            </Text>
            {state ? <Text style={styles.signpostState}>{state.toLowerCase()}</Text> : null}
          </View>
          <Text style={styles.signpostDetail}>
            {continuationPresenceLine(continuation.kind, sessions)}
            {target ? ` ${target.title} is where it carried on.` : ''}
          </Text>
        </View>
      </View>
      <View style={styles.signpostActions}>
        {target ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Open ${issueDisplayRef(target)}`}
            onPress={() => onOpen(target.id)}
            style={({ pressed }) => [
              styles.signpostAction,
              styles.signpostActionPrimary,
              pressed && styles.signpostActionPressed,
            ]}
          >
            <Text style={styles.signpostActionPrimaryText}>Open {issueDisplayRef(target)}</Text>
          </PressableScale>
        ) : null}
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={
            finished ? 'Tuck this task away' : 'Mark this task done and tuck it away'
          }
          onPress={onFile}
          style={({ pressed }) => [styles.signpostAction, pressed && styles.signpostActionPressed]}
        >
          <Icon as={finished ? ArrowDown : Check} size={13} color={color.textDim} />
          <Text style={styles.signpostActionText}>{finished ? 'Tuck away' : 'Done & tuck'}</Text>
        </PressableScale>
      </View>
    </View>
  )
}

function DepartureRow({
  displayRef,
  title,
  state,
  attention,
  onPress,
}: {
  displayRef: string
  title: string
  state: string
  attention: boolean
  onPress: () => void
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${displayRef} ${title}, ${state}`}
      onPress={onPress}
      style={({ pressed }) => [styles.departure, pressed && styles.signpostActionPressed]}
    >
      <Text style={styles.departureArrow}>↗</Text>
      <Text style={styles.departureRef}>{displayRef}</Text>
      <Text numberOfLines={1} style={styles.departureTitle}>
        {title}
      </Text>
      {attention ? <View style={styles.departureAttention} /> : null}
      <Text numberOfLines={1} style={styles.departureState}>
        {state.toLowerCase()}
      </Text>
    </PressableScale>
  )
}

/** A finished, empty mission is a lifecycle signpost, not generic empty copy. */
function RetiredSignpost({ abandoned, onTuck }: { abandoned: boolean; onTuck: () => void }) {
  return (
    <View style={styles.signpost}>
      <View style={styles.signpostHead}>
        <View style={styles.signpostIcon}>
          <Icon as={abandoned ? X : Check} size={13} color={color.textDim} />
        </View>
        <View style={styles.signpostCopy}>
          <Text style={styles.signpostTitle}>
            {abandoned ? 'This task was cancelled.' : 'This task is finished.'}
          </Text>
          <Text style={styles.signpostDetail}>
            No session remains on it. Tuck it away to fold it into Closed.
          </Text>
        </View>
      </View>
      <View style={styles.signpostActions}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Tuck this finished task away"
          onPress={onTuck}
          style={({ pressed }) => [styles.signpostAction, pressed && styles.signpostActionPressed]}
        >
          <Icon as={ArrowDown} size={13} color={color.textDim} />
          <Text style={styles.signpostActionText}>Tuck away</Text>
        </PressableScale>
      </View>
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
  if (session.archived || session.status === 'exited') {
    return `Retired · ${relativeTime(session.lastActiveAt, Date.now())}`
  }
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
  // The deck's ONE primary action, and the only accent on the panel: launching an
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
  topRail: { height: space.sm },
  topRailLine: { position: 'absolute', top: 0, bottom: 0 },
  signpost: {
    marginHorizontal: space.lg,
    marginVertical: space.lg,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  signpostHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  signpostIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.bgSunken,
  },
  signpostCopy: { flex: 1, minWidth: 0 },
  signpostTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  signpostTitle: { ...sans(600), fontSize: font.small, color: color.text },
  signpostState: { ...sans(500), flexShrink: 0, fontSize: font.micro, color: color.textFaint },
  signpostDetail: {
    ...sans(400),
    marginTop: 3,
    fontSize: font.tiny,
    lineHeight: 18,
    color: color.textDim,
  },
  signpostAction: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.bgSunken,
  },
  signpostActionPressed: { opacity: 0.78 },
  signpostActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.sm,
    marginLeft: 32,
  },
  signpostActionPrimary: { backgroundColor: color.text },
  signpostActionPrimaryText: { ...sans(600), fontSize: font.tiny, color: color.bg },
  signpostActionText: { ...sans(500), fontSize: font.tiny, color: color.text },
  departure: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xs,
  },
  departureArrow: { ...mono(500), fontSize: font.tiny, color: color.textFaint },
  departureRef: { ...mono(400), flexShrink: 0, fontSize: font.micro, color: color.textFaint },
  departureTitle: { ...sans(400), flex: 1, minWidth: 0, fontSize: font.tiny, color: color.textDim },
  departureAttention: { width: 5, height: 5, borderRadius: 3, backgroundColor: color.accent },
  departureState: { ...mono(400), flexShrink: 0, fontSize: font.micro, color: color.textFaint },
})
