import {
  type CollapsedSummary,
  type DeckIssueState,
  type IssueNote,
  type PresenceNote,
  type SessionRole,
  sessionSettled,
} from '@podium/client-core/viewmodels'
import type { AgentKind, IssueStage, SessionMeta, SessionId } from '@podium/model'
import { ChevronDown } from 'lucide-react-native'
import { Animated, StyleSheet, Text, View } from 'react-native'
import Svg, { Line } from 'react-native-svg'
import { alpha } from '../theme/mix'
import { stageColor } from '../theme/stage'
import { color, font, mono, radius, sans, space, tracking } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'
import { StageGlyph } from './StageGlyph'
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
 *
 * A TASK'S AGENTS AND ITS CHILD TASKS SHARE ONE RAIL (POD-758, from the web).
 * They used to hang two lines apart here, with a session inset FURTHER than one
 * issue step so that a child task's title always landed left of its parent's
 * agent names and a session could never look like it was parenting the task
 * below it. The redesign settles that confusion by making an agent row a
 * different KIND of object instead — no fill, no outline, no rounded collar —
 * which costs no second line, and lets one branch line carry everything a task
 * owns. An agent that is not drawn as an object cannot be mistaken for one.
 */
export const PAD = 14
export const STEP = 22
/** Where a nesting level's rail sits — and, at depth 1, the mission's own rail. */
export const RAIL_INSET = 6
export const ROOT_RAIL = PAD + RAIL_INSET
export const RAIL_X = (depth: number) => PAD + Math.max(0, depth - 1) * STEP + RAIL_INSET
/** The left edge of a task strip's own ground — the elbow lands on it, and both
 *  gutter ticks stand clear to the left of it. */
export const BAND_LEFT = (depth: number) => PAD + depth * STEP
/**
 * Where a task's own agents hang: the rail of the NEXT depth, which is exactly
 * the rail its child tasks draw. One line, one indent — see the note above.
 */
export const BAND_RAIL = (depth: number) => RAIL_X(depth + 1)
/**
 * An agent's harness square starts on the LEFT EDGE a child task's strip starts
 * on — not on the child's stage glyph, which sits one disclosure slot further
 * in. The two kinds of row hang on one line at one indent; what distinguishes
 * them is that only one of them is a rectangle.
 */
export const BAND_PAD = (depth: number) => BAND_LEFT(depth + 1)
/** The strip's own left padding, before the disclosure slot. */
const STRIP_INSET = 4

/** 48pt, not the desktop's 30px: a strip is a touch target first. */
export const STRIP_H = 48
/** A proposal holds no space for an agent and needs none for itself. */
export const PROPOSED_H = 40
export const BAND_H = 44

/**
 * THE ATTENTION AND SELECTION TICKS — colour as a mark in the gutter, never as
 * a fill or a border on the row (POD-758).
 *
 * The spine has exactly two fills: grey for a task, fuchsia for a proposal.
 * Selection and attention are therefore not allowed to be surfaces, or the one
 * thing a colour means in this column stops being one thing. They arrive
 * instead as a short square tick standing in the rail's own gutter — the issue
 * accent for the row you are on, amber one notch further out for a row with a
 * session asking inside it. Two ticks stand side by side without either
 * becoming the other, which a border and a background cannot.
 */
const TICK_W = 3
const TICK_H = 18
/** Offsets from the row's own rail: selection just inside it, attention just
 *  outside — so attention is always the leftmost thing on the row. */
const TICK_SELECTED_X = 4
const TICK_ATTENTION_X = -6

/**
 * THE LEAD RAIL.
 *
 * A branch whose owner has a live coordinator draws its guide in the mission's
 * own accent instead of a hairline, so "who is running this" is answered by the
 * line rather than by a badge. Two tiers, because the same device names the
 * mission's lead and a task's lead and those are not the same claim. Un-led
 * branches keep the hairline, which is what stops the coloured line from
 * reading as decoration.
 */
export type RailTone = 'mission' | 'task' | null

export interface Rail {
  color: string
  width: number
}

const HAIRLINE: Rail = { color: color.hairline, width: StyleSheet.hairlineWidth * 2 }

/** 45% for the mission's own lead, 22% for a task's — quiet enough to trace
 *  from the header to the row, never loud enough to read as a highlight. */
export function railFor(tone: RailTone, accent: string): Rail {
  if (tone === 'mission') return { color: alpha(accent, 0.45), width: 2 }
  if (tone === 'task') return { color: alpha(accent, 0.22), width: 2 }
  return HAIRLINE
}

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

/** The harness square — the phone's icon for "what kind of thing is this". */
function HarnessChip({
  kind,
  size = 20,
  dimmed = false,
}: {
  kind: AgentKind | string | undefined
  size?: number
  dimmed?: boolean
}) {
  const tone = kindTone(kind)
  return (
    <View
      style={[
        styles.kind,
        {
          width: size,
          height: size,
          borderRadius: size >= 20 ? radius.xs : 4,
          backgroundColor: tone.bg,
          opacity: dimmed ? 0.45 : 1,
        },
      ]}
    >
      <Text style={[styles.kindCh, { color: tone.fg, fontSize: size >= 20 ? 9 : 8 }]}>
        {tone.ch}
      </Text>
    </View>
  )
}

/** Past this the icons stop being a census and start being a texture. */
const CREW_SHOWN = 4

/**
 * WHO IS BEHIND THE FOLD — one harness square per session, and no names.
 *
 * A collapsed strip is a census, not a roster. Names need room the strip does
 * not have and a bare count says nothing about what kind of thing is in there;
 * the harness squares say "two Claudes and a shell" in the width of three
 * characters. Settled agents dim rather than disappear — nothing in this spine
 * is hidden by default — and the whole line rides on the row's accessible name,
 * which is where the phone keeps what a desktop puts on a tooltip.
 */
function CrewCensus({ crew }: { crew: readonly SessionMeta[] }) {
  const shown = crew.slice(0, CREW_SHOWN)
  const extra = crew.length - shown.length
  return (
    <View style={styles.census}>
      {shown.map((session) => (
        <HarnessChip
          key={session.sessionId}
          kind={session.agentKind}
          size={15}
          dimmed={sessionSettled(session)}
        />
      ))}
      {extra > 0 ? <Text style={styles.censusMore}>+{extra}</Text> : null}
    </View>
  )
}

/**
 * THE EMPTY SEAT — a dotted chip in the strip's own chip slot (POD-758).
 *
 * It used to be a presence line under the task, holding roughly the space a
 * session would occupy. That space taught where you would tap, and cost a line
 * of the spine on every unstaffed task to teach it. The seat is a chip now, in
 * the slot where a staffed task shows its crew: "nobody is here" is read
 * exactly where somebody would be, which is the same lesson in no rows at all.
 *
 * DOTTED, NEVER DASHED. One rim style, reserved for one meaning across the
 * whole spine — a session belongs here and there is not one.
 */
function SeatChip({ note }: { note: PresenceNote }) {
  return (
    <View style={[styles.seat, note.attention ? styles.seatAsking : null]}>
      <Text style={[styles.seatText, note.attention ? styles.seatTextAsking : null]}>
        {note.attention ? 'no agent' : 'seat open'}
      </Text>
    </View>
  )
}

/** Which presence notes are a HELD SEAT rather than a settled fact. Everything
 *  else the strip already says in its state word or its issue note, and saying
 *  it twice is what made the old presence line read as an agent. */
export const seatFor = (note: PresenceNote | null): PresenceNote | null =>
  note && (note.kind === 'ready' || note.kind === 'attention') ? note : null

/**
 * BLOCKED WEARS A HATCH — a shallow diagonal rule over the same grey ground.
 *
 * No border and no hue: blocked is a stopped state, not an obligation, and in
 * this theme the warning tone IS the attention tone (#f5c518), so a
 * "warning-coloured" strip would read as "answer me" on the exact surface built
 * to tell those apart.
 */
/** The theme's own ink at 5% — one step of texture, and no hue. */
const HATCH_INK = alpha(color.text, 0.05)
const HATCH_STEP = 8
/** Enough rules to cross the widest strip at any depth; the strip clips them. */
const HATCH_RULES = Array.from({ length: 60 }, (_, i) => i * HATCH_STEP)

function Hatch() {
  return (
    <Svg pointerEvents="none" style={[styles.hatch]}>
      {HATCH_RULES.map((x) => (
        <Line
          key={x}
          x1={x}
          y1={0}
          x2={x - STRIP_H}
          y2={STRIP_H}
          stroke={HATCH_INK}
          strokeWidth={HATCH_STEP / 2}
        />
      ))}
    </Svg>
  )
}

/** The rail segments crossing this row, plus the elbow into its own band. */
function Guides({
  depth,
  carries,
  toX,
  rails,
  accent,
  railTop = true,
  stops,
  ownX,
  elbowColor,
}: {
  depth: number
  /** `treeGuides[i]` — which ancestor rails carry on past this row. */
  carries: readonly boolean[]
  /** Where the elbow ends: the band's left edge. */
  toX: number
  /** The tone of the rail at each level, `rails[level - 1]`. */
  rails: readonly RailTone[]
  accent: string
  railTop?: boolean
  /** This row is the last thing on its own rail, so the rail stops at the elbow. */
  stops: boolean
  /** Where this row's own rail runs. */
  ownX: number
  /** The elbow's colour, when this row is the one its branch is about. */
  elbowColor?: string
}) {
  const own = railFor(rails[depth - 1] ?? null, accent)
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { width: toX }]}>
      {carries.map((on, level) => {
        if (!on || level + 1 === depth) return null
        const rail = railFor(rails[level] ?? null, accent)
        return (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: level IS the identity
            key={level}
            style={[
              styles.rail,
              { left: RAIL_X(level + 1), width: rail.width, backgroundColor: rail.color },
            ]}
          />
        )
      })}
      <View
        style={[
          styles.rail,
          { left: ownX, width: own.width, backgroundColor: own.color },
          stops ? styles.railHalf : null,
          railTop ? null : styles.railBottom,
        ]}
      />
      <View
        style={[
          styles.elbow,
          {
            left: ownX,
            width: Math.max(0, toX - ownX),
            backgroundColor: elbowColor ?? color.hairline,
          },
        ]}
      />
    </View>
  )
}

/**
 * One task in the spine. Two lines, always.
 *
 * At 393pt a title, a display ref and a state word cannot share one line — the
 * title loses half its characters, which on the one surface used to decide what
 * to run is the wrong thing to spend the measure on. Identity and state move to
 * an iOS subtitle row and the title gets the full width. That is why the phone
 * has no rigid state column: the desktop's 70px right-hand rail is a device for
 * a wide list, and here the same fact lives one line down instead.
 *
 * A TASK IS GREY, IN EVERY STATE (POD-758) — done, running, blocked, moving,
 * open or closed, selected or not. One fill for one kind of thing is what lets
 * the column's only other fill (a proposal's fuchsia) mean exactly one thing:
 * this task does not exist yet. So selection is not a fill and not an accent
 * border either. It darkens the outline one step, bolds the title, and takes
 * the accent tick in the gutter — three quiet changes to the row rather than
 * one loud one that turns a strip into a callout card.
 */
export function TaskStrip({
  depth,
  carries,
  rails,
  accent,
  stops,
  title,
  displayRef,
  stage,
  state,
  note,
  seat,
  summary,
  folded,
  liveWord,
  selected,
  foldable,
  onPress,
  onLongPress,
  onToggleFold,
}: {
  depth: number
  carries: readonly boolean[]
  rails: readonly RailTone[]
  accent: string
  stops: boolean
  title: string
  displayRef: string
  stage: IssueStage
  state: DeckIssueState
  note: IssueNote | null
  /** The seat this task holds for the agent it does not have, if any. */
  seat: PresenceNote | null
  /** What the fold is hiding — drawn only while `folded`. */
  summary: CollapsedSummary
  folded: boolean
  /** Live state in words while folded (`2 running`), replacing the state word. */
  liveWord?: string
  selected: boolean
  foldable: boolean
  onPress: () => void
  onLongPress?: () => void
  onToggleFold: () => void
}) {
  const bandLeft = BAND_LEFT(depth)
  const ownX = RAIL_X(depth)
  const mid = STRIP_H / 2
  const census = folded ? summary.crew : []
  const word = liveWord ?? state.label
  return (
    <View style={styles.stripWrap}>
      <Guides
        depth={depth}
        carries={carries}
        rails={rails}
        accent={accent}
        toX={bandLeft}
        ownX={ownX}
        stops={stops}
      />
      {/* Both marks stand BESIDE the strip rather than on it: attention outside
          the rail, selection inside it, so a selected task that also has
          somebody asking shows two ticks and neither has to become the other. */}
      {state.attention ? (
        <View
          pointerEvents="none"
          style={[
            styles.tick,
            { left: ownX + TICK_ATTENTION_X, top: mid - TICK_H / 2, backgroundColor: color.accent },
          ]}
        />
      ) : null}
      {selected ? (
        <View
          pointerEvents="none"
          style={[
            styles.tick,
            { left: ownX + TICK_SELECTED_X, top: mid - TICK_H / 2, backgroundColor: accent },
          ]}
        />
      ) : null}
      <PressableScale
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityLabel={stripLabel({ displayRef, title, state, word, seat, census })}
        style={[
          styles.strip,
          {
            marginLeft: bandLeft,
            height: STRIP_H,
            borderColor: selected ? color.borderStrong : color.hairline,
          },
        ]}
      >
        {state.state === 'blocked' ? <Hatch /> : null}
        {/* THE DISCLOSURE MOVED INTO THE STRIP (POD-758). It used to stand in
            the rail gutter, as the tree's node marker, which is what kept four
            depths inside 393pt. The gutter is now where the selection and
            attention ticks live, and a chevron sharing those twenty pixels
            would land on top of both. Inside the strip it costs one fixed slot
            at every depth rather than a column per level — and the slot is held
            open on a leaf, so every title in the column starts at one x. */}
        {foldable ? (
          <PressableScale
            onPress={onToggleFold}
            hitSlop={12}
            accessibilityLabel={folded ? 'Expand' : 'Collapse'}
            style={styles.chev}
          >
            <Animated.View style={{ transform: [{ rotate: folded ? '-90deg' : '0deg' }] }}>
              <Icon as={ChevronDown} size={12} color={color.textFaint} />
            </Animated.View>
          </PressableScale>
        ) : (
          <View style={styles.chev} />
        )}
        <StageGlyph stage={stage} size={13} ground={color.surface} />
        <View style={styles.stripText}>
          <View style={styles.stripTitleRow}>
            <Text
              numberOfLines={1}
              style={[
                styles.stripTitle,
                selected ? styles.stripTitleSelected : null,
                state.state === 'done' ? styles.stripTitleDone : null,
              ]}
            >
              {title}
            </Text>
            {seat ? <SeatChip note={seat} /> : null}
            {census.length > 0 ? <CrewCensus crew={census} /> : null}
          </View>
          <View style={styles.subline}>
            <Text style={styles.ref}>{displayRef}</Text>
            <Text style={styles.sep}>·</Text>
            {/* The one mark this slot keeps is the one that MOVES. Every static
                state is already carried on the left by the stage glyph, the
                hatch, or the issue note naming the blocker. */}
            {state.state === 'working' && liveWord === undefined ? (
              <BrailleSpinner size={9} tint={color.working} />
            ) : null}
            <Text numberOfLines={1} style={[styles.state, stateStyle(state)]}>
              {word}
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
            {folded && summary.tasks > 0 ? (
              <>
                <Text style={styles.sep}>·</Text>
                <Text style={styles.payload}>
                  {summary.tasks} task{summary.tasks === 1 ? '' : 's'}
                </Text>
              </>
            ) : null}
          </View>
        </View>
      </PressableScale>
    </View>
  )
}

/** Everything the strip draws, said once for a screen reader — including the
 *  chips a sighted operator reads as shapes. */
function stripLabel({
  displayRef,
  title,
  state,
  word,
  seat,
  census,
}: {
  displayRef: string
  title: string
  state: DeckIssueState
  word: string
  seat: PresenceNote | null
  census: readonly SessionMeta[]
}): string {
  const parts = [`${displayRef} ${title}`, word]
  if (seat) parts.push(seat.text)
  if (census.length > 0)
    parts.push(`${census.length} agent${census.length === 1 ? '' : 's'} inside`)
  if (state.attention) parts.push('needs you')
  return parts.join(', ')
}

function stateStyle(state: DeckIssueState) {
  if (state.state === 'working') return { color: color.working }
  if (state.state === 'blocked') return { color: color.danger }
  if (state.state === 'done') return { color: color.textMicro }
  return null
}

/**
 * One agent under its task.
 *
 * AN AGENT ROW HAS NO FILL AND NO OUTLINE (POD-758), and no rounded collar. It
 * is a CONTENT of a task, not an object beside one — drawn by its harness
 * square, its indent and its rail, so the only rectangles left in this column
 * are tasks. The mission's coordinator is the single exception: it owns the
 * whole mission, and being the only filled agent row anywhere in the spine, the
 * fill says exactly that and nothing else.
 *
 * Even the asking row stays unfilled. Attention is a MARK in this system — amber
 * type, an amber inner rule, the `!` disc — never a surface.
 *
 * There is deliberately NO answer button here. The decision lives on the offer
 * card in the transcript, one tap away; putting it on the band too would give
 * one choice two homes. The band only has to be findable.
 */
export function SessionBand({
  depth,
  carries,
  rails,
  accent,
  stops,
  name,
  displayRef,
  role,
  roleText,
  kind,
  asking,
  working,
  settled,
  lead,
  coordinator,
  current,
  right,
  onPress,
  onLongPress,
}: {
  depth: number
  carries: readonly boolean[]
  rails: readonly RailTone[]
  accent: string
  stops: boolean
  name: string
  /** The permanent birth ref — the handle an operator types and says out loud. */
  displayRef: string | undefined
  role: SessionRole | null
  /** The role as a word, already resolved (a spawn edge needs its parent's name). */
  roleText: string | null
  kind: AgentKind | undefined
  asking: boolean
  working: boolean
  /** Retired, or holding a finished turn — dims one tier rather than leaving. */
  settled: boolean
  /** This agent is the one its branch's coloured rail is about. */
  lead: boolean
  /** The mission's own coordinator — the one agent row with a fill. */
  coordinator: boolean
  /** The transcript underneath is showing this session. */
  current: boolean
  /** The timer, the age, or the compute total — whichever this state earns. */
  right: string | null
  onPress: () => void
  onLongPress?: () => void
}) {
  const pad = BAND_PAD(depth)
  const ownX = BAND_RAIL(depth)
  const mid = BAND_H / 2
  // The fill and the inner rule start where the row's content does, not at the
  // rail: the rail belongs to the branch, and the row opens onto it.
  const fillLeft = pad - 10
  const railTone = rails[depth] ?? null
  return (
    <View style={styles.bandWrap}>
      <Guides
        depth={depth + 1}
        carries={[...carries, false]}
        rails={rails}
        accent={accent}
        toX={pad}
        ownX={ownX}
        stops={stops}
        // THE LEAD'S OWN ELBOW IS THE ONLY COLOURED ONE. Everybody in the block
        // hangs on the same coloured line; only the agent the line is ABOUT is
        // joined to it in that colour, so the branch names one agent instead of
        // tinting the roster. An asking row overrides it — amber outranks
        // provenance, because one of them is a job for the operator.
        elbowColor={asking ? color.accent : lead ? railFor(railTone, accent).color : color.hairline}
      />
      {coordinator ? (
        <View
          pointerEvents="none"
          style={[styles.leadFill, { left: fillLeft, backgroundColor: alpha(accent, 0.08) }]}
        />
      ) : null}
      {asking ? <View pointerEvents="none" style={[styles.askRule, { left: fillLeft }]} /> : null}
      {/* THE SESSION YOU ARE IN takes the same square accent tick a selected
          task takes, in the row's own gutter. Extending the mark rather than
          reaching for a fill is the whole point of the tick: "this one" is one
          device in this column, whatever kind of row it lands on. */}
      {current ? (
        <View
          pointerEvents="none"
          style={[
            styles.tick,
            { left: ownX + TICK_SELECTED_X, top: mid - TICK_H / 2, backgroundColor: accent },
          ]}
        />
      ) : null}
      <PressableScale
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityLabel={[name, roleText, asking ? 'needs you' : null]
          .filter(Boolean)
          .join(', ')}
        style={[styles.band, { paddingLeft: pad }, settled ? styles.bandSettled : null]}
      >
        <HarnessChip kind={kind} />
        <View style={styles.bandText}>
          <View style={styles.bandNameRow}>
            <Text numberOfLines={1} style={[styles.bandName, current ? styles.bandNameOn : null]}>
              {name}
            </Text>
            {/* The ref never truncates and the NAME shrinks around it: it is the
                one string on the row that is worthless partly rendered. */}
            {displayRef ? <Text style={styles.bandRef}>{displayRef}</Text> : null}
          </View>
          {/* A LEAD IS NAMED BY ITS LINE, and the word only adds what the line
              cannot: which of the two altitudes it is. Full strength for the
              mission's coordinator, 70% for a task's lead. */}
          {roleText && !asking ? (
            <Text
              numberOfLines={1}
              style={[
                styles.role,
                lead
                  ? {
                      ...styles.roleLead,
                      color: accent,
                      opacity: role?.kind === 'coordinator' ? 1 : 0.7,
                    }
                  : null,
              ]}
            >
              {roleText}
            </Text>
          ) : null}
        </View>
        <View style={styles.bandRight}>
          {working ? <BrailleSpinner size={12} tint={color.working} /> : null}
          {asking ? (
            <View style={styles.askDisc}>
              <Text style={styles.askDiscCh}>!</Text>
            </View>
          ) : null}
          {asking ? <Text style={styles.asking}>Needs you</Text> : null}
          {right ? (
            <Text style={[styles.bandStamp, working ? { color: color.working } : null]}>
              {right}
            </Text>
          ) : null}
        </View>
      </PressableScale>
    </View>
  )
}

const ROLE_LABEL: Record<Exclude<SessionRole, { kind: 'spawned' }>['kind'], string> = {
  coordinator: 'COORDINATOR',
  // "task lead", not "phase lead": the thing it leads is a task, and the spine
  // calls every node in it a task. Two words for one node is one too many.
  'phase-lead': 'TASK LEAD',
  peer: 'operator-added peer',
}

/** The role as the word under the name. A spawn edge is named by its PARENT —
 *  "by Spine designer" is the fact the operator can act on; the parent session
 *  id is not. An unresolvable parent gets no word rather than an id. */
export function roleLabel(
  role: SessionRole | null,
  nameOf: (sessionId: SessionId) => string | undefined,
): string | null {
  if (role === null) return null
  if (role.kind !== 'spawned') return ROLE_LABEL[role.kind]
  const parent = nameOf(role.parentSessionId)
  return parent ? `by ${parent}` : null
}

export const isLead = (role: SessionRole | null): boolean =>
  role?.kind === 'coordinator' || role?.kind === 'phase-lead'

/**
 * A PROPOSAL IS THE COLUMN'S ONLY OTHER FILL (POD-758).
 *
 * The spine has exactly two grounds: grey for a task, fuchsia for a proposal.
 * That is the whole reason selection and attention had to become ticks — with
 * two fills and nothing else, purple in this column means one thing and one
 * thing only, and the operator learns it in a glance: THIS TASK DOES NOT EXIST
 * YET. The stage's own hue is taken from the shared stage table, so the glyph,
 * the ref and the ground are three spellings of one fact.
 *
 * A proposal is something an AGENT asked for, so the row names the session that
 * asked — the ref is how you go and ask it why. It holds no seat (nobody has
 * accepted it), wears no state word (it has no state to be in) and takes the
 * shorter band, because a row with nothing happening in it should not occupy
 * the space of a row that has.
 */
export function ProposalRow({
  title,
  displayRef,
  author,
  selected,
  onPress,
  onLongPress,
}: {
  title: string
  displayRef: string
  /** The display ref of the session that filed it, when the deck can resolve it. */
  author: string | null
  selected: boolean
  onPress: () => void
  onLongPress?: () => void
}) {
  const fuchsia = stageColor('proposed')
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={`${displayRef} ${title}, proposed${author ? `, by ${author}` : ''}`}
      style={[
        styles.proposal,
        {
          backgroundColor: alpha(fuchsia, selected ? 0.08 : 0.05),
          borderColor: alpha(fuchsia, selected ? 0.4 : 0.15),
        },
      ]}
    >
      <StageGlyph stage="proposed" size={12} ground={color.bg} />
      <View style={styles.proposalText}>
        <Text numberOfLines={1} style={styles.proposalTitle}>
          <Text style={[styles.proposalRef, { color: fuchsia }]}>{displayRef} </Text>
          {title}
        </Text>
      </View>
      {/* Never dropped: the author IS the proposal's secondary content, and a
          row with only a title tells the operator nothing to act on. */}
      {author ? <Text style={[styles.proposalBy, { color: fuchsia }]}>by {author}</Text> : null}
    </PressableScale>
  )
}

/**
 * A NAMED REGION BELOW THE TREE.
 *
 * The spine is one thing — the mission's shape — and anything that is not part
 * of that shape leaves it rather than hanging off it on a guide rail borrowed
 * from a parent it does not really have. The heading carries its own count and
 * its own rule rather than sitting under a full-width border: a rule that
 * starts after the word reads as that word underlining a region, where a border
 * across the column reads as the spine ending. The spine has not ended — this
 * is its tail.
 */
export function DeckSection({
  label,
  count,
  tone,
  children,
}: {
  label: string
  count?: number
  /** The region's own hue, when it has one (proposals). */
  tone?: string
  children: React.ReactNode
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionLabel, tone ? { color: tone } : null]}>{label}</Text>
        {count !== undefined ? <Text style={styles.sectionCount}>{count}</Text> : null}
        <View style={styles.sectionRule} />
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  rail: { position: 'absolute', top: 0, bottom: 0 },
  railHalf: { bottom: '50%' },
  railBottom: { top: '50%' },
  elbow: { position: 'absolute', top: '50%', height: StyleSheet.hairlineWidth * 2 },
  hatch: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  tick: { position: 'absolute', width: TICK_W, height: TICK_H },

  stripWrap: { position: 'relative' },
  // The ONE rectangle in this column, and it is grey in every state.
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: STRIP_INSET,
    paddingRight: space.sm,
    marginRight: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  chev: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  stripText: { flex: 1, minWidth: 0, paddingLeft: space.sm },
  stripTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  stripTitle: {
    ...sans(400),
    flexShrink: 1,
    fontSize: font.small,
    lineHeight: 19,
    letterSpacing: tracking[15],
    color: color.text,
  },
  stripTitleSelected: { ...sans(600) },
  stripTitleDone: { color: color.textFaint },
  subline: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  ref: { ...mono(400), fontSize: 10, color: color.textMicro },
  sep: { ...mono(400), fontSize: 10, color: color.textMicro, opacity: 0.5 },
  state: { ...mono(400), fontSize: font.micro, color: color.textFaint, flexShrink: 1 },
  note: { ...mono(400), fontSize: font.micro, color: color.textFaint, flexShrink: 1 },
  payload: { ...mono(400), fontSize: font.micro, color: color.textFaint, flexShrink: 0 },

  census: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 },
  censusMore: { ...mono(400), fontSize: font.micro, color: color.textFaint },

  seat: {
    flexShrink: 0,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dotted',
    borderColor: color.borderStrong,
    borderRadius: 3,
  },
  seatAsking: { borderColor: alpha(color.accent, 0.6) },
  seatText: { ...mono(400), fontSize: 9, color: color.textFaint },
  seatTextAsking: { ...mono(600), color: color.accentTint },

  bandWrap: { position: 'relative' },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    height: BAND_H,
    paddingRight: space.md,
    gap: space.sm,
  },
  // Settled agents dim one tier rather than leaving. Removing them is the view
  // bar's job, not the row's.
  bandSettled: { opacity: 0.6 },
  // The one agent row with a fill: square and open to the left, because it is
  // still an agent row and not a card.
  leadFill: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  askRule: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: color.accent },
  kind: { alignItems: 'center', justifyContent: 'center' },
  kindCh: { ...mono(600) },
  bandText: { flex: 1, minWidth: 0 },
  bandNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  bandName: {
    ...sans(400),
    flexShrink: 1,
    fontSize: font.tiny,
    lineHeight: 18,
    color: color.body,
    letterSpacing: tracking[13],
  },
  bandNameOn: { color: color.text },
  bandRef: { ...mono(400), fontSize: 10, color: color.textFaint, flexShrink: 0 },
  role: { ...mono(400), fontSize: 10, color: color.textMicro, marginTop: 1 },
  roleLead: { ...mono(500), letterSpacing: 1.1 },
  bandRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bandStamp: { ...mono(400), fontSize: font.micro, color: color.textFaint },
  asking: { ...mono(600), fontSize: font.micro, color: color.accentTint },
  askDisc: {
    width: 13,
    height: 13,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accent,
  },
  askDiscCh: { ...mono(600), fontSize: 9, lineHeight: 11, color: color.onAccent },

  proposal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: PROPOSED_H,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  proposalText: { flex: 1, minWidth: 0 },
  proposalTitle: {
    ...sans(400),
    fontSize: font.tiny,
    lineHeight: 18,
    color: color.body,
    letterSpacing: tracking[13],
  },
  proposalRef: { ...mono(400), fontSize: 10 },
  proposalBy: { ...mono(400), fontSize: font.micro, flexShrink: 0 },

  section: { marginTop: space.md, paddingHorizontal: PAD },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sectionLabel: {
    ...mono(500),
    fontSize: 9,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: color.label,
  },
  sectionCount: { ...mono(400), fontSize: font.micro, color: color.textFaint },
  sectionRule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.hairline },
  sectionBody: { marginTop: space.sm, gap: 6 },
})
