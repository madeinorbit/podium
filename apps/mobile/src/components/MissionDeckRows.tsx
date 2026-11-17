import { settled } from '@podium/client-graph/mission-view'
import type { SessionModel } from '@podium/client-graph/models'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { issueStatusOf } from '@podium/model'
import {
  SESSION_WORD_LABEL,
  type SessionWord,
  TASK_WORD_LABEL,
  type TaskWord,
} from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { color, font, leading, sans, space } from '../theme/theme'
import { deckColor, deckWordColor } from './deck-colors'
import { Icon } from './Icon'
import { Check, ChevronDown, ChevronRight } from './icons'
import {
  type DeckAgentRowProps,
  type DeckPhaseHeadingProps,
  type DeckSeatRowProps,
  type DeckTaskRowProps,
  seatName,
  sessionModelLabel,
  taskWordText,
} from './mission-deck-rows.types'
import { StageGlyph } from './StageGlyph'
import { WorkingWord } from './WorkingWord'

/** The deck's rows on web and Android, inside MissionDeckList's plain cards.
 * iOS draws the same rows natively in the SwiftUI list (MissionDeckRows.ios). */

export const DeckPhaseHeading = observer(function DeckPhaseHeading({
  phase,
}: DeckPhaseHeadingProps) {
  const facts = settled(() => ({
    counter: phase.counter,
    title: phase.row.title,
    open: phase.open,
    status: phase.row.status,
    word: phase.word,
    complete: phase.workComplete,
  }))
  if (facts === LOADING) return <View style={styles.section} accessibilityLabel="Loading phase" />
  const {
    counter: { done, total },
    title,
    open,
  } = facts
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${TASK_WORD_LABEL[facts.word]}, ${done} of ${total} done`}
      accessibilityState={{ expanded: open }}
      hitSlop={SECTION_SLOP}
      onPress={() => phase.deck.toggleFold(phase.id)}
      style={({ pressed }) => [styles.section, pressed && styles.dimmed]}
      testID="deck-phase"
    >
      <View style={styles.gutter}>
        <StageGlyph
          stage={facts.complete ? 'done' : issueStatusOf(facts.status)}
          ground={color.groupedBg}
        />
      </View>
      <Text style={styles.sectionTitle} numberOfLines={2}>
        {title}
      </Text>
      <View style={styles.sectionTrail}>
        <Text style={[styles.sectionCount, { color: deckWordColor(facts.word) }]}>
          {`${done}/${total}`}
        </Text>
        <Icon as={open ? ChevronDown : ChevronRight} size={13} color={color.textFaint} />
      </View>
    </Pressable>
  )
})

export const DeckTaskRow = observer(function DeckTaskRow({
  task,
  indent,
  first,
  onPress,
  onLongPress,
}: DeckTaskRowProps) {
  // A cold row's facts are still loading: draw its place, not a throw.
  const facts = settled(() => ({
    word: task.word,
    status: task.row.status,
    title: task.row.title,
    ref: task.row.displayRef,
    foldable: task.foldable,
    open: task.open,
  }))
  if (facts === LOADING) {
    return (
      <View style={styles.line} accessibilityLabel="Loading task" testID="deck-task-loading">
        <View
          style={[styles.gutter, styles.taskGlyph, { marginLeft: Math.min(indent, 3) * INDENT }]}
        >
          <View style={styles.ring} />
        </View>
        <View style={[styles.lineBody, !first && styles.separated]} />
      </View>
    )
  }
  const { word, title, ref, foldable, open } = facts
  const blockers = word === 'blocked' ? settled(() => task.unmetBlockedByIds.length) : 0
  const label = taskWordText(word, blockers === LOADING ? 0 : blockers)
  return (
    <View collapsable={false} style={styles.line}>
      <View style={[styles.gutter, styles.taskGlyph, { marginLeft: Math.min(indent, 3) * INDENT }]}>
        <StageGlyph stage={issueStatusOf(facts.status)} ground={color.groupedCard} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${ref} ${title}, ${label}`}
        pressRetentionOffset={12}
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [
          styles.lineBody,
          foldable && styles.lineBodyFoldable,
          !first && styles.separated,
          pressed && styles.pressed,
        ]}
        testID="deck-task"
      >
        <View collapsable={false} style={styles.taskText}>
          <Text style={[styles.lineTitle, word === 'done' && styles.doneTitle]} numberOfLines={2}>
            {title}
          </Text>
          <WorkingWord
            active={word === 'working'}
            seed={ref}
            style={styles.meta}
            numberOfLines={1}
            glint={
              <>
                <Text style={{ color: color.clear }}>{`${ref} · `}</Text>
                {label}
              </>
            }
          >
            {`${ref} · `}
            <Text style={wordTone(word)}>{label}</Text>
          </WorkingWord>
        </View>
        {foldable ? (
          // A disclosure on the trailing edge (SwiftUI DisclosureGroup) keeps
          // every row's ring, title and ID on the same leading columns.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${open ? 'Collapse' : 'Expand'} ${title}`}
            accessibilityState={{ expanded: open }}
            hitSlop={DISCLOSURE_SLOP}
            style={styles.foldToggle}
            onPress={() => task.deck.toggleFold(task.id)}
          >
            <Icon as={open ? ChevronDown : ChevronRight} size={13} color={color.textFaint} />
          </Pressable>
        ) : null}
      </Pressable>
    </View>
  )
})

/** An agent seated on a task, inset under it (board DeckLarge). */
export const DeckAgentRow = observer(function DeckAgentRow({
  task,
  sessionId,
  indent,
  current,
  onPress,
}: DeckAgentRowProps) {
  const session = task.deck.screen.pool.sessionObject(sessionId) as SessionModel
  const name = seatName(task, sessionId, session)
  const model = sessionModelLabel(session)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${SESSION_WORD_LABEL[session.word]}${current ? ', open' : ''}`}
      accessibilityState={{ selected: current }}
      pressRetentionOffset={12}
      onPress={onPress}
      style={({ pressed }) => [styles.agent, current && styles.selected, pressed && styles.pressed]}
      testID="deck-agent"
    >
      {/* The seat sits in its task's title column. */}
      <View
        style={[
          styles.gutter,
          styles.agentGlyph,
          { marginLeft: GUTTER + space.md + Math.min(indent, 3) * INDENT },
        ]}
      >
        <SessionGlyph word={session.word} />
      </View>
      <View style={styles.seatText}>
        <Text style={styles.agentName} numberOfLines={2}>
          {name}
        </Text>
        <WorkingWord
          active={session.word === 'working'}
          seed={sessionId}
          style={styles.meta}
          numberOfLines={2}
          glint={
            <>
              {SESSION_WORD_LABEL[session.word]}
              <Text style={{ color: color.clear }}>{model ? ` · ${model}` : ''}</Text>
            </>
          }
        >
          <Text style={wordTone(session.word)}>{SESSION_WORD_LABEL[session.word]}</Text>
          {model ? ` · ${model}` : ''}
        </WorkingWord>
      </View>
    </Pressable>
  )
})

/** One of the root's seats: the coordinator first (board DeckSheet). */
export const DeckSeatRow = observer(function DeckSeatRow({
  task,
  sessionId,
  first,
  current,
  onPress,
}: DeckSeatRowProps) {
  const session = task.deck.screen.pool.sessionObject(sessionId) as SessionModel
  const name = seatName(task, sessionId, session)
  const word = SESSION_WORD_LABEL[session.word]
  const model = sessionModelLabel(session)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${word}${current ? ', open' : ''}`}
      accessibilityState={{ selected: current }}
      pressRetentionOffset={12}
      onPress={onPress}
      // The open seat is a full-bleed row tint the card clips to its own shape;
      // its state colour stays on the dot and word.
      style={({ pressed }) => [styles.seat, current && styles.selected, pressed && styles.pressed]}
      testID="deck-seat"
    >
      <View style={[styles.gutter, styles.seatGlyph]}>
        <SessionGlyph word={session.word} />
      </View>
      <View style={[styles.seatBody, !first && styles.separated]}>
        <View style={styles.seatText}>
          <Text style={styles.seatName} numberOfLines={2}>
            {name}
          </Text>
          <WorkingWord
            active={session.word === 'working'}
            seed={sessionId}
            style={styles.meta}
            numberOfLines={2}
            glint={
              <>
                {word}
                <Text style={{ color: color.clear }}>{model ? ` · ${model}` : ''}</Text>
              </>
            }
          >
            <Text style={wordTone(session.word)}>{word}</Text>
            {model ? ` · ${model}` : ''}
          </WorkingWord>
        </View>
      </View>
    </Pressable>
  )
})

function wordTone(word: TaskWord | SessionWord) {
  return { color: deckWordColor(word) }
}

function SessionGlyph({ word }: { word: SessionWord }): ReactNode {
  if (word === 'working') return <View style={[styles.ring, { borderColor: deckColor.working }]} />
  if (word === 'needs-you') return <View style={styles.dot} />
  if (word === 'error') return <View style={[styles.dot, styles.errorDot]} />
  if (word === 'done') return <Icon as={Check} size={13} color={deckColor.done} />
  return <View style={styles.ring} />
}

/** Every row's glyph column, then its text column, on the 4pt grid. */
const GUTTER = 20
const INSET = space.lg
/** A child's glyph sits in its parent's title column, like its seats. */
const INDENT = GUTTER + space.md
const ROW_H = 44
/** UISegmentedControl stops growing its labels a little past the default size. */
const _SEGMENT_MAX_SCALE = 1.35

const _CHIP_SLOP = { top: 6, bottom: 6 }
const _TOGGLE_SLOP = { top: 12, bottom: 12, left: 8, right: 8 }
const SECTION_SLOP = { top: 6, bottom: 6 }
const DISCLOSURE_SLOP = { top: 4, bottom: 4, left: 8, right: 4 }
const styles = StyleSheet.create({
  dimmed: { opacity: 0.5 },
  // SwiftUI keeps ~20pt between any header and its first row: that is the gap.
  seat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: ROW_H,
    paddingLeft: INSET,
  },
  selected: { backgroundColor: deckColor.liveFill },
  seatBody: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: INSET,
    paddingVertical: space.sm,
  },
  seatText: { flex: 1, minWidth: 0, gap: space.xs },
  seatName: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingLeft: INSET,
    paddingRight: INSET,
    paddingTop: space.xl,
    paddingBottom: space.sm,
  },
  sectionTitle: {
    ...sans(600),
    flex: 1,
    minWidth: 0,
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body),
  },
  /** Count and chevron share one trailing column on every heading. */
  sectionTrail: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sectionCount: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    fontVariant: ['tabular-nums'],
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: ROW_H,
    paddingLeft: INSET,
  },
  pressed: { backgroundColor: color.tertiaryFill },
  gutter: { width: GUTTER, alignItems: 'center', justifyContent: 'center' },
  // Row glyphs sit on the title's first line (Reminders, Mail), whatever the
  // row's height: a box one title line tall, below the text's top padding.
  taskGlyph: { alignSelf: 'flex-start', height: leading(font.small), marginTop: space.sm },
  seatGlyph: { alignSelf: 'flex-start', height: leading(font.small), marginTop: space.sm },
  agentGlyph: { alignSelf: 'flex-start', height: leading(font.tiny) },
  // Absolute, so the text column keeps the plain block layout RNHostView
  // measures (a row-direction body overflowed the card with long titles).
  foldToggle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: space.sm,
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // RNHostView measures without a height proposal. Let the text supply its
  // intrinsic height, including when width or content arrives after mount.
  taskText: { minWidth: 0, paddingVertical: space.sm, gap: space.xs },
  meta: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
    fontVariant: ['tabular-nums'],
  },
  lineBody: {
    flex: 1,
    minWidth: 0,
    minHeight: ROW_H,
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingRight: INSET,
  },
  lineBodyFoldable: { paddingRight: INSET + space.xl },
  separated: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  lineTitle: {
    ...sans(400),
    minWidth: 0,
    color: color.text,
    fontSize: font.small,
    lineHeight: leading(font.small),
  },
  doneTitle: { color: color.textDim },
  agent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    minHeight: ROW_H,
    paddingVertical: space.sm,
    paddingLeft: INSET,
    paddingRight: INSET,
  },
  agentName: {
    ...sans(400),
    minWidth: 0,
    color: color.text,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny),
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.needsYou },
  errorDot: { backgroundColor: color.danger },
  ring: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: color.textFaint },
})
