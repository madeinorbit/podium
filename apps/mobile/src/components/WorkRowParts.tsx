import {
  deriveFleetPresence,
  deriveGitStamp,
  FLEET_KIND_LIMIT,
  type MissionProgress,
} from '@podium/client-core/viewmodels'
import type { IssueGitState, SessionMeta } from '@podium/model'
import { StyleSheet, Text, View } from 'react-native'
import { alpha } from '../theme/mix'
import { color, font, mono, radius, space } from '../theme/theme'
import { AgentMark, kindTone, markSize } from './AgentMark'

/**
 * The three pieces of row furniture the desktop sidebar row carries and the
 * phone row did not [POD-724]: the fleet stack, the git stamp and the mission
 * progress meter. Same facts, same rules about when each earns its place — the
 * phone list is the same list, so a row that says three things at the desk must
 * not say one on the phone.
 */

/** The ghost a PARKED harness wears (POD-756): its process was stopped to free
 *  memory, the agent is still on the task. One tone for every kind — the fact
 *  being drawn is "this one is asleep", not which harness it is. The kind's own
 *  mark stays: a parked Codex is still a Codex. */
const PARKED_TONE = { fg: color.textFaint, bg: alpha(color.textDim, 0.1) }

/** The stacked tile's edge. Named because the mark inside is sized from it. */
const FLEET_TILE = 19

/**
 * The mission's execution presence: a stack of real harness-kind tiles, the
 * agent total once there is more than one, and `×N` for native (in-process
 * Task) children.
 *
 * Kinds, not sessions. A nine-agent mission running three harnesses shows three
 * tiles and a `9` — the stack answers "who is here", the number answers "how
 * many". Everything is derived from the row's bubbled session set.
 *
 * Who counts as here is `deriveFleetPresence`'s call, shared with the desktop
 * row (POD-756): a PARKED agent is on the task and draws a ghost tile. The
 * phone used to filter hibernation out exactly as the sidebar did, so a fleet
 * the memory reaper had put to sleep read as an empty one.
 */
export function FleetSummary({
  sessions,
}: {
  sessions: readonly SessionMeta[]
}) {
  const { present, tiles, nativeCount, label } = deriveFleetPresence(sessions)
  if (present.length === 0) return null
  const shown = tiles.slice(0, FLEET_KIND_LIMIT)
  return (
    <View accessibilityRole="image" accessibilityLabel={label} style={styles.fleet}>
      <View style={styles.stack}>
        {shown.map(({ kind, parked }, index) => {
          const tone = kindTone(kind)
          const t = parked ? { ...tone, ...PARKED_TONE } : tone
          return (
            <View
              key={kind}
              style={[
                styles.tile,
                { backgroundColor: t.bg, borderColor: alpha(t.fg, 0.4) },
                index > 0 ? styles.tileOverlap : null,
                { zIndex: index + 1 },
              ]}
            >
              <AgentMark kind={kind} size={markSize(FLEET_TILE)} ink={t.fg} />
            </View>
          )
        })}
      </View>
      {present.length > 1 ? <Text style={styles.fleetTotal}>{present.length}</Text> : null}
      {nativeCount > 0 ? <Text style={styles.native}>{`×${nativeCount}`}</Text> : null}
    </View>
  )
}

/**
 * The sidebar density of the git stamp: only the actionable exceptions, in dim
 * mono with no chip box. Clean and no-op states stay silent — a worklist row is
 * for decisions, not a miniature git dashboard (POD-236). A wrong-branch
 * mismatch is the one genuine fault and keeps the alert tone.
 */
export function GitStampLine({
  branch,
  git,
  suppressAhead = false,
}: {
  branch: string | null | undefined
  git: IssueGitState | null | undefined
  suppressAhead?: boolean
}) {
  const m = deriveGitStamp(branch, git)
  if (m.kind !== 'ready') return null
  const ahead = suppressAhead ? undefined : m.ahead
  // `merged` earns the line here for the same reason it does on the desktop
  // stamp (POD-1193): landing is the outcome of the merge decision, not a
  // clean no-op, so the row that asked for it can say it is done.
  if (!m.mismatch && !m.merged && m.dirty === undefined && ahead === undefined) return null
  const parts: string[] = []
  if (m.mismatch) parts.push('Wrong branch')
  if (m.merged) parts.push('merged')
  if (m.dirty !== undefined) parts.push(`${m.dirty} uncommitted`)
  if (ahead !== undefined) parts.push(`${ahead} commit${ahead === 1 ? '' : 's'} ahead`)
  return (
    <Text style={[styles.git, m.mismatch && styles.gitFault]} numberOfLines={1}>
      {parts.join(' · ')}
    </Text>
  )
}

/** Two tasks or nothing: a row that is one issue with one agent has no fraction
 *  — it is 0% until it is 100%, and a bar with two states says nothing the
 *  status word has not. */
export const ROW_PROGRESS_MIN_TASKS = 2

export type RowProgress = MissionProgress

/**
 * The row's baseline rule: a segmented meter drawn across the text column, in
 * the row's existing bottom padding, so a row that has one costs no height and
 * a list of thirty keeps one even rhythm. Review is the one bisque segment: it
 * is the progress state that explicitly asks the operator for attention.
 */
export function RowProgressMeter({
  progress,
  working,
}: {
  progress: RowProgress
  working: boolean
}) {
  if (progress.total < ROW_PROGRESS_MIN_TASKS) return null
  const total = Math.max(1, progress.total)
  const pct = (n: number) => `${Math.round((n / total) * 10000) / 100}%` as const
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: progress.total, now: progress.done }}
      style={styles.meter}
    >
      <View style={[styles.seg, { width: pct(progress.done), backgroundColor: color.working }]} />
      <View
        style={[
          styles.seg,
          {
            width: pct(progress.run),
            backgroundColor: alpha(color.working, working ? 0.55 : 0.34),
          },
        ]}
      />
      {progress.review > 0 ? (
        <View
          style={[styles.seg, { width: pct(progress.review), backgroundColor: color.needsYou }]}
        />
      ) : null}
      <View style={[styles.seg, { width: pct(progress.block), backgroundColor: color.danger }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  fleet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  stack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tile: {
    width: FLEET_TILE,
    height: FLEET_TILE,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileOverlap: {
    marginLeft: -5,
  },
  fleetTotal: {
    ...mono(400),
    color: color.textDim,
    fontSize: font.micro,
  },
  native: {
    ...mono(500),
    color: color.claude,
    fontSize: 9,
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: radius.xs,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.claude, 0.35),
    backgroundColor: alpha(color.claude, 0.12),
  },
  git: {
    ...mono(400),
    color: color.textMicro,
    fontSize: 9,
  },
  gitFault: {
    color: color.danger,
  },
  meter: {
    flexDirection: 'row',
    height: 2,
    marginTop: space.xs + 1,
    borderRadius: 1,
    overflow: 'hidden',
    backgroundColor: alpha(color.border, 0.7),
  },
  seg: {
    height: '100%',
  },
})
