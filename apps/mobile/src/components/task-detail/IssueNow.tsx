import { motionPhase, sessionTitle } from '@podium/client-core/viewmodels'
import type { IssueWire, SessionId, SessionMeta } from '@podium/model'
import { ChevronRight } from '../icons'
import { StyleSheet, Text, View } from 'react-native'
import { alpha } from '../../theme/mix'
import { color, font, mono, radius, sans, space } from '../../theme/theme'
import { AgentMark, kindTone, markSize } from '../AgentMark'
import { Icon } from '../Icon'
import { PressableScale } from '../PressableScale'
import { WorkingMark } from '../WorkingMark'
import { GitStampLine } from '../WorkRowParts'
import { MachineLabel } from './chrome'

/** The session tile on this panel. Named because the mark is sized from it. */
const NOW_TILE = 22

/**
 * NOW — what is true about this task at this second [POD-724, the phone's answer
 * to POD-591].
 *
 * The defect on the desktop was that the task PAGE knew less about its own task
 * than the sidebar row for it did. On the phone it was worse: the task screen
 * listed sessions as plain cards under a "Sessions (3)" heading and said nothing
 * at all about the branch, so an operator checking on a task from the couch could
 * not learn whether anything was computing or whether there was anything to land
 * without opening a session.
 *
 * So this block sits directly under the title, before any prose, and carries the
 * volatile facts: who is computing, and where the branch stands. THE BRANCH LINE
 * IS HERE AND NOT IN THE PROPERTIES BLOCK — which is the one place this diverges
 * from the desktop, and deliberately: over there the rail is always on screen
 * beside the document, so repeating git state in Now would be saying it twice.
 * Here the properties are behind a fold, so a git fact left in them is a git fact
 * the operator never sees. One home, and on this viewport the home is Now.
 *
 * It only takes a FRAME while something is live. A task whose agents have all
 * finished still has an answer to "what is happening now", but the answer is one
 * quiet line, not a panel above the description.
 */

/** Live rows first (working, then waiting on you), then the rest — the block is
 *  read top-down and the top is where the movement should be. */
const PHASE_RANK: Record<string, number> = { working: 0, waiting: 1, queued: 2, done: 3 }

/** How many live rows the block draws before the roster carries the rest. */
const SHOWN = 3

export function IssueNow({
  issue,
  sessions,
  onOpenSession,
}: {
  issue: IssueWire
  sessions: SessionMeta[]
  onOpenSession: (sessionId: SessionId) => void
}) {
  const ranked = [...sessions]
    .map((session) => ({ session, phase: motionPhase(session, issue) }))
    .sort((a, b) => (PHASE_RANK[a.phase] ?? 9) - (PHASE_RANK[b.phase] ?? 9))
  const working = ranked.filter((r) => r.phase === 'working').length
  const waiting = ranked.filter((r) => r.phase === 'waiting').length
  // Long fleets fold: a task can carry fifteen sessions of which thirteen are
  // finished. The block promises what is happening NOW; the properties block's
  // roster answers "who has ever been here".
  const shown = ranked.filter((r) => r.phase === 'working' || r.phase === 'waiting').slice(0, SHOWN)
  const rest = ranked.length - shown.length

  // The branch line is keyed on the BRANCH, not on the stamp: `GitStampLine` is
  // the sidebar density and stays silent when there is nothing actionable, which
  // is right for a list row and wrong here — a task page that shows no branch at
  // all cannot be read as "the branch is clean", only as "this page does not
  // know". So the name is always drawn once there is one, and the stamp adds the
  // exceptions underneath it when there are any.
  const git = issue.branch ? (
    <View style={styles.gitRow}>
      <Text style={styles.branch} numberOfLines={1}>
        {issue.branch}
      </Text>
      <GitStampLine branch={issue.branch} git={issue.gitState} />
    </View>
  ) : null

  // NOTHING IS LIVE — so the block spends no structure on saying so. A task whose
  // agents all finished yesterday was still getting the page's strongest object
  // to report that nothing was happening.
  if (shown.length === 0) {
    return (
      <View style={styles.quiet} testID="issue-now">
        <Text style={styles.quietText}>
          {sessions.length === 0
            ? 'No agent is on this task.'
            : `${sessions.length} session${sessions.length === 1 ? '' : 's'} · none working`}
        </Text>
        {issue.branch ? (
          <Text style={styles.branch} numberOfLines={1}>
            {issue.branch}
          </Text>
        ) : null}
        <GitStampLine branch={issue.branch} git={issue.gitState} />
      </View>
    )
  }

  return (
    <View style={styles.panel} testID="issue-now">
      <View style={styles.head}>
        <MachineLabel>Now</MachineLabel>
        {/* The summary names the reason the block is here. `none working` over a
            row that is waiting on the operator is the one state on this page that
            is genuinely an ask, and it must not be reported in the faintest ink
            the theme has. */}
        <Text style={[styles.summary, working > 0 ? styles.live : styles.attention]}>
          {working > 0
            ? `${working} of ${sessions.length} session${sessions.length === 1 ? '' : 's'} working`
            : `${waiting} waiting on you`}
        </Text>
      </View>

      {shown.map(({ session, phase }, index) => {
        const t = kindTone(session.agentKind)
        return (
          <PressableScale
            key={session.sessionId}
            accessibilityRole="button"
            accessibilityLabel={`Open ${sessionTitle(session)}`}
            accessibilityHint={phase === 'waiting' ? 'Waiting on you' : 'Working'}
            onPress={() => onOpenSession(session.sessionId)}
            scaleTo={0.995}
            style={({ pressed }) => [
              styles.row,
              index > 0 && styles.rowDivider,
              phase === 'waiting' && styles.rowWaiting,
              pressed && styles.rowPressed,
            ]}
          >
            <View style={[styles.tile, { backgroundColor: t.bg, borderColor: alpha(t.fg, 0.4) }]}>
              <AgentMark kind={session.agentKind} size={markSize(NOW_TILE)} ink={t.fg} />
            </View>
            <Text style={styles.name} numberOfLines={1}>
              {sessionTitle(session)}
            </Text>
            {phase === 'working' ? <WorkingMark size={12} /> : <View style={styles.waitingDot} />}
            <Icon as={ChevronRight} size={14} color={color.textFaint} />
          </PressableScale>
        )
      })}

      {rest > 0 ? (
        <Text style={styles.rest}>
          {rest} more session{rest === 1 ? '' : 's'} — see the roster
        </Text>
      ) : null}

      {git}
    </View>
  )
}

const styles = StyleSheet.create({
  // ENGRAVED, NOT CARDED (the Carved Rule): a resting surface that needs to read
  // differently from its neighbours recesses rather than lifting. A drop-shadowed
  // panel here would be the page's only floating element.
  panel: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    backgroundColor: color.engraved,
    overflow: 'hidden',
    marginBottom: space.xl,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 30,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  summary: {
    ...mono(400),
    marginLeft: 'auto',
    fontSize: font.micro,
  },
  live: {
    color: color.workingText,
  },
  attention: {
    color: color.needsYouText,
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  rowWaiting: {
    backgroundColor: color.needsYouSoft,
  },
  rowPressed: {
    backgroundColor: color.surfacePressed,
  },
  tile: {
    width: NOW_TILE,
    height: NOW_TILE,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    ...sans(500),
    flex: 1,
    minWidth: 0,
    color: color.body,
    fontSize: font.small,
  },
  waitingDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: color.needsYou,
  },
  rest: {
    ...mono(400),
    color: color.textMicro,
    fontSize: font.micro,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  gitRow: {
    gap: 2,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: alpha(color.hairline, 0.8),
  },
  branch: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
  },
  quiet: {
    gap: 3,
    marginBottom: space.xl,
  },
  quietText: {
    ...mono(400),
    color: color.textFaint,
    fontSize: font.micro,
  },
})
