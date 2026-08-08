import type { CollapsedSummary, DeckIssueState, IssueNote, SessionRole } from '@podium/client-core/viewmodels'
import type { AgentKind } from '@podium/model'
import { Check, ChevronDown, CircleSlash, Clock, CornerDownRight } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import { FLOW_SLATE } from '../theme/issueColors'
import { alpha } from '../theme/mix'
import { color, font, mono, radius, sans, space, tracking } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { BrailleSpinner } from './StatusGlyphs'

/**
 * THE SPINE'S GEOMETRY, on a 393pt screen.
 *
 * The desktop draws this at mouse scale — 30px strips, a 14px depth step, a
 * chevron column at every level. None of that survives the phone: a 30pt row is
 * below the 44pt touch floor, and a dedicated chevron column at four depths
 * spends 80pt of a 393pt measure on disclosure alone.
 *
 * What is kept is the thing that makes it a tree rather than a list: every row
 * draws the rail segments crossing it and the elbow into its own band, so
 * adjacent rows compose one continuous line and a filter can drop any row
 * without re-parenting anything (`treeGuides` decides which rails carry on).
 *
 * THE MISSION ROOT IS NOT A ROW. The deck header is the root: the rail leaves
 * that block, the root's own agents hang directly off it, and the first child
 * continues the same line (POD-516 round 3). Rendering the root as an ordinary
 * strip would say the mission twice and cost a strip of a budget the phone does
 * not have.
 */
export const PAD = 14
export const STEP = 22
/** Where a nesting level's rail sits — and, at depth 1, the mission's own rail. */
export const RAIL_INSET = 6
export const ROOT_RAIL = PAD + RAIL_INSET
/** A strip's status glyph starts here; its title 28 further in. */
export const GLYPH_X = (depth: number) => PAD + Math.max(0, depth - 1) * STEP + 26
export const RAIL_X = (depth: number) => PAD + Math.max(0, depth - 1) * STEP + RAIL_INSET
/**
 * Where a task's own agents hang. A session is inset FURTHER than one issue
 * step, so a child task's title always lands left of its parent's agent names:
 * issue depth reads as issue depth, and a session never looks like it is
 * parenting the task below it.
 */
export const BAND_RAIL = (depth: number) => (depth === 0 ? ROOT_RAIL : GLYPH_X(depth) + 10)
export const BAND_PAD = (depth: number) => (depth === 0 ? 60 : GLYPH_X(depth) + 38)

/** 48pt, not the desktop's 30px: a strip is a touch target first. */
export const STRIP_H = 48
/** A proposal holds no space for an agent and needs none for itself. */
export const PROPOSED_H = 40
export const BAND_H = 44

export const KIND_TONE: Record<string, { fg: string; bg: string; ch: string }> = {
  'claude-code': { fg: color.claude, bg: alpha(color.claude, 0.16), ch: 'C' },
  codex: { fg: color.text, bg: 'rgba(243,243,248,0.10)', ch: 'X' },
  grok: { fg: color.textDim, bg: 'rgba(154,154,168,0.14)', ch: 'G' },
  opencode: { fg: color.working, bg: color.workingSoft, ch: 'O' },
  cursor: { fg: color.working, bg: color.workingSoft, ch: 'U' },
  shell: { fg: color.textFaint, bg: 'rgba(108,118,144,0.14)', ch: '$' },
}
export function kindTone(kind: AgentKind | string | undefined) {
  return KIND_TONE[kind ?? ''] ?? { fg: color.textDim, bg: 'rgba(154,154,168,0.14)', ch: '·' }
}

/** The rail segments crossing this row, plus the elbow into its own band. */
function Guides({
  depth,
  carries,
  toX,
  railTop = true,
  stops,
}: {
  depth: number
  /** `treeGuides[i]` — which ancestor rails carry on past this row. */
  carries: readonly boolean[]
  /** Where the elbow ends: the glyph's left edge, or the band's. */
  toX: number
  railTop?: boolean
  /** This row is the last thing on its own rail, so the rail stops at the elbow. */
  stops: boolean
}) {
  const own = RAIL_X(depth)
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { width: toX }]}>
      {carries.map((on, level) =>
        on && level + 1 !== depth ? (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: level IS the identity
            key={level}
            style={[styles.rail, { left: RAIL_X(level + 1) }]}
          />
        ) : null,
      )}
      <View
        style={[
          styles.rail,
          { left: own },
          stops ? styles.railHalf : null,
          railTop ? null : styles.railBottom,
        ]}
      />
      <View style={[styles.elbow, { left: own, width: Math.max(0, toX - own - 2) }]} />
    </View>
  )
}

/**
 * One task in the spine. Two lines, always.
 *
 * At 393pt a title, a display ref and a state word cannot share one line — the
 * title loses half its characters, which on the one surface used to decide what
 * to run is the wrong thing to spend the measure on. Identity and state move to
 * an iOS subtitle row and the title gets the full width.
 */
export function TaskStrip({
  depth,
  carries,
  stops,
  title,
  displayRef,
  state,
  note,
  colorHex,
  focused,
  foldable,
  folded,
  onPress,
  onLongPress,
  onToggleFold,
}: {
  depth: number
  carries: readonly boolean[]
  stops: boolean
  title: string
  displayRef: string
  state: DeckIssueState
  note: IssueNote | null
  colorHex?: string
  focused: boolean
  foldable: boolean
  folded: boolean
  onPress: () => void
  onLongPress?: () => void
  onToggleFold: () => void
}) {
  const proposed = state.state === 'proposed'
  const glyphX = GLYPH_X(depth)
  const tint = colorHex ?? FLOW_SLATE
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={`${displayRef} ${title}, ${state.label}${state.attention ? ', needs you' : ''}`}
      style={[
        styles.strip,
        { height: proposed ? PROPOSED_H : STRIP_H, paddingLeft: glyphX },
        focused ? { backgroundColor: alpha(tint, 0.14) } : null,
      ]}
    >
      <Guides depth={depth} carries={carries} toX={glyphX} stops={stops} />
      {foldable ? (
        // The disclosure lives IN the rail gutter — the tree's node marker, not
        // a column of its own. That is what keeps four depths inside 393pt.
        <PressableScale
          onPress={onToggleFold}
          hitSlop={10}
          accessibilityLabel={folded ? 'Expand' : 'Collapse'}
          style={[styles.chev, { left: RAIL_X(depth) - 10 }]}
        >
          <Animated.View style={{ transform: [{ rotate: folded ? '-90deg' : '0deg' }] }}>
            <Icon as={ChevronDown} size={12} color={color.textFaint} />
          </Animated.View>
        </PressableScale>
      ) : null}
      <StateGlyph state={state} proposed={proposed} />
      <View style={styles.stripText}>
        <View style={styles.stripTitleRow}>
          <Text
            numberOfLines={1}
            style={[styles.stripTitle, state.state === 'done' ? styles.stripTitleDone : null]}
          >
            {title}
          </Text>
          {/* The one thing Superade yellow is allowed to mean. */}
          {state.attention ? <View style={styles.dot} /> : null}
        </View>
        <View style={styles.subline}>
          <Text style={styles.ref}>{displayRef}</Text>
          <Text style={styles.sep}>·</Text>
          <Text numberOfLines={1} style={[styles.state, stateStyle(state)]}>
            {state.label}
          </Text>
          {/* Two channels, never merged: the state says `Blocked`, the note
              says by what. `issueNote().short` is the module's own short form. */}
          {note ? (
            <>
              <Text style={styles.sep}>·</Text>
              <Text numberOfLines={1} style={[styles.note, stateStyle(state)]}>
                {note.short}
              </Text>
            </>
          ) : null}
        </View>
      </View>
    </PressableScale>
  )
}

function StateGlyph({ state, proposed }: { state: DeckIssueState; proposed: boolean }) {
  const tone =
    state.state === 'done'
      ? color.textMicro
      : state.state === 'blocked'
        ? color.danger
        : state.state === 'working'
          ? color.working
          : color.textFaint
  const glyph = state.state === 'done' ? Check : state.state === 'blocked' ? CircleSlash : Clock
  return (
    <View style={[styles.glyph, proposed ? styles.glyphProposed : null]}>
      <Icon as={glyph} size={13} color={tone} />
    </View>
  )
}

function stateStyle(state: DeckIssueState) {
  if (state.state === 'working') return { color: color.working }
  if (state.state === 'blocked') return { color: color.danger }
  if (state.state === 'done') return { color: color.textMicro }
  return null
}

/**
 * One agent under its task — inset, on the darker rail tier, with its own
 * ground so it can never be mistaken for a task.
 *
 * There is deliberately NO answer button here. The decision lives on the offer
 * card in the transcript, one tap away; putting it on the band too would give
 * one choice two homes. The band only has to be findable.
 */
export function SessionBand({
  depth,
  carries,
  stops,
  name,
  role,
  kind,
  asking,
  working,
  right,
  onPress,
  onLongPress,
}: {
  depth: number
  carries: readonly boolean[]
  stops: boolean
  name: string
  role: SessionRole | null
  kind: AgentKind | undefined
  asking: boolean
  working: boolean
  /** The timer, the age, or the compute total — whichever this state earns. */
  right: string | null
  onPress: () => void
  onLongPress?: () => void
}) {
  const pad = BAND_PAD(depth)
  const tone = kindTone(kind)
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={`${name}${asking ? ', needs you' : ''}`}
      style={[styles.band, { paddingLeft: pad }]}
    >
      <View
        pointerEvents="none"
        style={[
          styles.bandGround,
          { left: pad - 10 },
          asking ? { borderColor: alpha(color.accent, 0.32) } : null,
        ]}
      />
      <BandGuides depth={depth} carries={carries} stops={stops} toX={pad} />
      <View style={[styles.kind, { backgroundColor: tone.bg }]}>
        <Text style={[styles.kindCh, { color: tone.fg }]}>{tone.ch}</Text>
      </View>
      <View style={styles.bandText}>
        <Text numberOfLines={1} style={styles.bandName}>
          {name}
        </Text>
        {role ? <Text style={styles.role}>{roleWord(role)}</Text> : null}
      </View>
      <View style={styles.bandRight}>
        {working ? <BrailleSpinner size={12} tint={color.working} /> : null}
        {asking ? <View style={styles.dot} /> : null}
        {right ? (
          <Text style={[styles.bandStamp, working ? { color: color.working } : null]}>{right}</Text>
        ) : null}
        {asking ? <Text style={styles.asking}>needs you</Text> : null}
      </View>
    </PressableScale>
  )
}

/** A band hangs on its TASK's rail, not the depth rail. */
function BandGuides({
  depth,
  carries,
  stops,
  toX,
}: {
  depth: number
  carries: readonly boolean[]
  stops: boolean
  toX: number
}) {
  const own = BAND_RAIL(depth)
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { width: toX }]}>
      {carries.map((on, level) =>
        on ? (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: level IS the identity
            key={level}
            style={[styles.rail, { left: RAIL_X(level + 1) }]}
          />
        ) : null,
      )}
      <View style={[styles.rail, { left: own }, stops ? styles.railHalf : null]} />
      <View style={[styles.elbow, { left: own, width: Math.max(0, toX - own - 12) }]} />
    </View>
  )
}

export function roleWord(role: SessionRole): string {
  switch (role.kind) {
    case 'coordinator':
      return 'coordinator'
    case 'phase-lead':
      return 'phase lead'
    case 'peer':
      return 'peer'
    default:
      return 'spawned'
  }
}

/** What a fold is HIDING, so the fold can still say it — descendants and the
 *  row's own agents both, because folding takes both away. */
export function CollapsedPayload({
  summary,
  depth,
}: {
  summary: CollapsedSummary
  depth: number
}) {
  const parts = [`${summary.tasks} task${summary.tasks === 1 ? '' : 's'}`]
  if (summary.done > 0) parts.push(`${summary.done} done`)
  if (summary.run > 0) parts.push(`${summary.run} running`)
  return (
    <View style={[styles.payload, { marginLeft: BAND_PAD(depth) - 12 }]}>
      <Text numberOfLines={1} style={styles.payloadText}>
        {parts.join(' · ')}
      </Text>
      <View style={styles.payloadSpacer} />
      {summary.kinds.map((k) => {
        const tone = kindTone(k)
        return (
          <View key={k} style={[styles.payloadKind, { backgroundColor: tone.bg }]}>
            <Text style={[styles.payloadKindCh, { color: tone.fg }]}>{tone.ch}</Text>
          </View>
        )
      })}
      {summary.needsYou ? <View style={styles.dot} /> : null}
    </View>
  )
}

/** Sixteen sessions must never bury the task tree. */
export function RosterFold({
  count,
  expanded,
  depth,
  onPress,
}: {
  count: number
  expanded: boolean
  depth: number
  onPress: () => void
}): ReactNode {
  if (count <= 0) return null
  return (
    <PressableScale
      onPress={onPress}
      style={[styles.rosterFold, { marginLeft: BAND_PAD(depth) }]}
      accessibilityLabel={expanded ? 'Hide finished agents' : `Show ${count} finished agents`}
    >
      <Icon as={CornerDownRight} size={11} color={color.textMicro} />
      <Text style={styles.rosterFoldText}>
        {expanded ? 'hide' : `${count} finished`}
      </Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  rail: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth * 2, backgroundColor: color.hairline },
  railHalf: { bottom: '50%' },
  railBottom: { top: '50%' },
  elbow: {
    position: 'absolute',
    top: '50%',
    height: StyleSheet.hairlineWidth * 2,
    backgroundColor: color.hairline,
  },

  strip: { flexDirection: 'row', alignItems: 'center', paddingRight: space.md },
  chev: { position: 'absolute', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', zIndex: 3 },
  glyph: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  glyphProposed: { opacity: 0.6 },
  stripText: { flex: 1, minWidth: 0, paddingLeft: space.sm, paddingRight: space.xs },
  stripTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  stripTitle: {
    ...sans(400),
    flexShrink: 1,
    fontSize: font.small,
    lineHeight: 19,
    letterSpacing: tracking[15],
    color: color.text,
  },
  stripTitleDone: { color: color.textFaint },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.accent,
  },
  subline: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  ref: { ...mono(400), fontSize: 10, color: color.textMicro },
  sep: { ...mono(400), fontSize: 10, color: color.textMicro, opacity: 0.5 },
  state: { ...mono(400), fontSize: font.micro, color: color.textFaint, flexShrink: 1 },
  note: { ...mono(400), fontSize: font.micro, color: color.textFaint, flexShrink: 1 },

  band: { flexDirection: 'row', alignItems: 'center', height: BAND_H, paddingRight: space.md },
  bandGround: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    right: space.sm,
    borderRadius: radius.lg,
    backgroundColor: color.rail,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: alpha(color.border, 0.55),
  },
  kind: { width: 20, height: 20, borderRadius: radius.xs, alignItems: 'center', justifyContent: 'center' },
  kindCh: { ...mono(600), fontSize: 9 },
  bandText: { flex: 1, minWidth: 0, paddingLeft: space.sm },
  bandName: {
    ...sans(400),
    fontSize: font.tiny,
    lineHeight: 18,
    color: color.body,
    letterSpacing: tracking[13],
  },
  role: { ...mono(400), fontSize: 10, color: color.textMicro, marginTop: 1 },
  bandRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bandStamp: { ...mono(400), fontSize: font.micro, color: color.textFaint },
  asking: { ...mono(500), fontSize: font.micro, color: color.accent },

  payload: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginRight: space.md,
    marginTop: 2,
    marginBottom: space.sm,
    paddingHorizontal: 11,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    backgroundColor: color.bgSunken,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderStyle: 'dashed',
  },
  payloadSpacer: { flex: 1 },
  payloadText: { ...mono(400), fontSize: font.micro, color: color.textFaint, flexShrink: 1 },
  payloadKind: { width: 15, height: 15, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  payloadKindCh: { ...mono(600), fontSize: 8 },

  rosterFold: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingBottom: 10 },
  rosterFoldText: { ...mono(400), fontSize: font.micro, color: color.textMicro },
})
