import { Button, HStack, Image, RNHostView, Spacer, Text, VStack } from '@expo/ui/swift-ui'
import {
  accessibilityAddTraits,
  accessibilityElement,
  accessibilityHidden,
  accessibilityHint,
  accessibilityIdentifier,
  accessibilityLabel,
  accessibilityValue,
  buttonStyle,
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  monospacedDigit,
  onLongPressGesture,
  padding,
  shapes,
} from '@expo/ui/swift-ui/modifiers'
import { settled } from '@podium/client-graph/mission-view'
import type { SessionModel } from '@podium/client-graph/models'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { type IssueStatus, issueStatusOf } from '@podium/model'
import { SESSION_WORD_LABEL, type SessionWord, TASK_WORD_LABEL } from '@podium/model/browser'
import { observer } from 'mobx-react-lite'
import { color } from '../theme/theme'
import { deckColor, deckWordColor } from './deck-colors'
import { listRowPress } from './list-row-press.ios'
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
import { WorkingMark } from './WorkingMark'

/**
 * The deck's rows as native List rows [POD-2529]. SwiftUI sizes and recycles
 * them like any system list: titles wrap to the cell's width, heights follow
 * Dynamic Type and live updates, and nothing is measured across the RN/SwiftUI
 * boundary (hosted RN rows lost their width and, in recycled cells, their
 * content: the blank gaps). Only the fixed-size desktop stage glyph and the
 * animated working mark stay React views, each in a fixed frame, as on Work.
 * Taps, the highlight and label colours come from the List's own row Button.
 *
 * Every row shares one leading grid with the proposal rows: 16 inset, a 20pt
 * glyph column, 12 gap, then text; a child steps in by one glyph column and
 * gap, so its glyph sits in its parent's title column (POD-2530).
 */
const INSET = 16
const GLYPH = 20
const GAP = 12
const INDENT = GLYPH + GAP
const MAX_INDENT = 3
/** Line heights of the 15pt title and 13pt seat name: glyphs centre on the first line. */
const TITLE_LINE = 20
const NAME_LINE = 18

const rowInsets = (trailing = INSET) =>
  listRowInsets({ leading: INSET, trailing, top: 0, bottom: 0 })

export const DeckTaskRow = observer(function DeckTaskRow({
  task,
  indent,
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
  const step = Math.min(indent, MAX_INDENT) * INDENT
  if (facts === LOADING) {
    return (
      <HStack
        spacing={GAP}
        modifiers={[
          padding({ leading: step }),
          frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
          accessibilityLabel('Loading task'),
          accessibilityIdentifier('deck-task-loading'),
          rowInsets(),
        ]}
      >
        <Image
          systemName="circle"
          size={8}
          color={color.textFaint}
          modifiers={[frame({ width: GLYPH }), accessibilityHidden()]}
        />
        <Spacer />
      </HStack>
    )
  }
  const { word, title, ref, foldable, open } = facts
  const blockers = word === 'blocked' ? settled(() => task.unmetBlockedByIds.length) : 0
  const label = taskWordText(word, blockers === LOADING ? 0 : blockers)
  return (
    <HStack
      spacing={0}
      modifiers={[
        frame({ maxWidth: Infinity, alignment: 'leading' }),
        // The disclosure's 32pt column ends 8pt from the card edge.
        rowInsets(foldable ? 8 : INSET),
      ]}
    >
      <HStack
        alignment="top"
        spacing={GAP}
        modifiers={[
          padding({ top: 8, bottom: 8 }),
          frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
          contentShape(shapes.rectangle()),
          accessibilityElement('ignore'),
          accessibilityLabel(`${ref} ${title}, ${label}`),
          accessibilityHint('Opens the task. Long press for actions.'),
          onLongPressGesture(onLongPress),
          // The List's own row Button (highlight, label colours, taps only);
          // VoiceOver reads it from the label above, the id names the Button.
          listRowPress(onPress),
          accessibilityIdentifier('deck-task'),
        ]}
      >
        <Indent step={step} />
        <StageMark stage={issueStatusOf(facts.status)} ground={color.groupedCard} />
        <VStack
          alignment="leading"
          spacing={4}
          modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
        >
          <Text
            modifiers={[
              font({ textStyle: 'subheadline' }),
              foregroundStyle(word === 'done' ? color.textDim : color.text),
              lineLimit(2),
              frame({ maxWidth: Infinity, alignment: 'leading' }),
            ]}
          >
            {title}
          </Text>
          <HStack spacing={0} modifiers={[monospacedDigit()]}>
            <Text modifiers={metaText(color.textDim)}>{`${ref} · `}</Text>
            <Text modifiers={metaText(deckWordColor(word))}>{label}</Text>
          </HStack>
        </VStack>
      </HStack>
      {foldable ? (
        // A disclosure on the trailing edge (DisclosureGroup), its own
        // borderless button: a tap folds and never opens the task, and every
        // row keeps its ring, title and ID on the same leading columns.
        <Button
          onPress={() => task.deck.toggleFold(task.id)}
          modifiers={[
            buttonStyle('borderless'),
            accessibilityLabel(`${open ? 'Collapse' : 'Expand'} ${title}`),
            accessibilityValue(open ? 'Expanded' : 'Collapsed'),
          ]}
        >
          <Image
            systemName={open ? 'chevron.down' : 'chevron.right'}
            size={13}
            color={color.textFaint}
            modifiers={[frame({ width: 32, height: 44 }), contentShape(shapes.rectangle())]}
          />
        </Button>
      ) : null}
    </HStack>
  )
})

/** An agent seated on a task: its glyph sits in the task's title column. */
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
  const word = session.word
  const step = (Math.min(indent, MAX_INDENT) + 1) * INDENT
  return (
    <HStack
      alignment="top"
      spacing={GAP}
      modifiers={[
        padding({ top: 8, bottom: 8 }),
        frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
        contentShape(shapes.rectangle()),
        accessibilityElement('ignore'),
        accessibilityLabel(`${name}, ${SESSION_WORD_LABEL[word]}${current ? ', open' : ''}`),
        ...(current ? [accessibilityAddTraits(['isSelected'])] : []),
        listRowPress(onPress),
        accessibilityIdentifier('deck-agent'),
        ...seatRowTraits(current),
      ]}
    >
      <Indent step={step} />
      <SessionMark word={word} line={NAME_LINE} />
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
      >
        <Text
          modifiers={[
            font({ textStyle: 'footnote' }),
            foregroundStyle(color.text),
            lineLimit(2),
            frame({ maxWidth: Infinity, alignment: 'leading' }),
          ]}
        >
          {name}
        </Text>
        <SessionMeta word={word} model={model} />
      </VStack>
    </HStack>
  )
})

/** One of the root's seats: the coordinator first (board DeckSheet). */
export const DeckSeatRow = observer(function DeckSeatRow({
  task,
  sessionId,
  current,
  onPress,
}: DeckSeatRowProps) {
  const session = task.deck.screen.pool.sessionObject(sessionId) as SessionModel
  const name = seatName(task, sessionId, session)
  const word = session.word
  const model = sessionModelLabel(session)
  return (
    <HStack
      alignment="top"
      spacing={GAP}
      modifiers={[
        padding({ top: 8, bottom: 8 }),
        frame({ minHeight: 44, maxWidth: Infinity, alignment: 'leading' }),
        contentShape(shapes.rectangle()),
        accessibilityElement('ignore'),
        accessibilityLabel(`${name}, ${SESSION_WORD_LABEL[word]}${current ? ', open' : ''}`),
        ...(current ? [accessibilityAddTraits(['isSelected'])] : []),
        listRowPress(onPress),
        accessibilityIdentifier('deck-seat'),
        ...seatRowTraits(current),
      ]}
    >
      <SessionMark word={word} line={TITLE_LINE} />
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
      >
        <Text
          modifiers={[
            font({ textStyle: 'subheadline', weight: 'semibold' }),
            foregroundStyle(color.text),
            lineLimit(2),
            frame({ maxWidth: Infinity, alignment: 'leading' }),
          ]}
        >
          {name}
        </Text>
        <SessionMeta word={word} model={model} />
      </VStack>
    </HStack>
  )
})

/** A phase heading: its own quiet row above its card, as Work's group headers
 * (a grouped List header would uppercase it). The whole row folds the phase. */
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
  if (facts === LOADING) {
    return (
      <HStack
        modifiers={[
          ...headingTraits,
          padding({ horizontal: INSET, top: 24, bottom: 8 }),
          frame({ minHeight: 44, maxWidth: Infinity }),
          accessibilityLabel('Loading phase'),
        ]}
      >
        <Spacer />
      </HStack>
    )
  }
  const {
    counter: { done, total },
    title,
    open,
  } = facts
  return (
    <Button
      onPress={() => phase.deck.toggleFold(phase.id)}
      modifiers={[
        buttonStyle('plain'),
        accessibilityLabel(`${title}, ${TASK_WORD_LABEL[facts.word]}, ${done} of ${total} done`),
        accessibilityValue(open ? 'Expanded' : 'Collapsed'),
        accessibilityAddTraits(['isHeader']),
        accessibilityIdentifier('deck-phase'),
        ...headingTraits,
      ]}
    >
      <HStack
        spacing={GAP}
        modifiers={[
          padding({ horizontal: INSET, top: 24, bottom: 8 }),
          frame({ maxWidth: Infinity, alignment: 'leading' }),
          contentShape(shapes.rectangle()),
        ]}
      >
        <StageMark
          stage={facts.complete ? 'done' : issueStatusOf(facts.status)}
          ground={color.groupedBg}
        />
        <Text
          modifiers={[
            font({ textStyle: 'body', weight: 'semibold' }),
            foregroundStyle(color.text),
            lineLimit(2),
            frame({ maxWidth: Infinity, alignment: 'leading' }),
          ]}
        >
          {title}
        </Text>
        <HStack spacing={8}>
          <Text
            modifiers={[
              font({ textStyle: 'subheadline' }),
              foregroundStyle(deckWordColor(facts.word)),
              monospacedDigit(),
            ]}
          >{`${done}/${total}`}</Text>
          <Image
            systemName={open ? 'chevron.down' : 'chevron.right'}
            size={13}
            color={color.textFaint}
            modifiers={[accessibilityHidden()]}
          />
        </HStack>
      </HStack>
    </Button>
  )
})

/** A heading row sits on the ground, edge to edge, with no separator. */
const headingTraits = [
  listRowBackground(color.groupedBg),
  listRowSeparator('hidden'),
  listRowInsets({ leading: 0, trailing: 0, top: 0, bottom: 0 }),
]

/** The open seat is a full-bleed row tint the card clips to its own shape;
 * its state colour stays on the dot and word. */
function seatRowTraits(current: boolean) {
  return [rowInsets(), ...(current ? [listRowBackground(deckColor.liveFill)] : [])]
}

/** The meta line's type; each piece names its own colour (the first
 * foregroundStyle on a Text wins). */
const metaText = (tint: string) => [
  font({ textStyle: 'footnote' }),
  foregroundStyle(tint),
  lineLimit(1),
]

/** A nesting step as a leading spacer (the row's gap follows it). A leading
 * padding instead hides the title from the List, whose separator then starts
 * at the card edge rather than the text column. */
function Indent({ step }: { step: number }) {
  return step > 0 ? <Spacer modifiers={[frame({ width: step - GAP })]} /> : null
}

/** The desktop stage glyph, a fixed 14pt drawing centred in the glyph column. */
function StageMark({ stage, ground }: { stage: IssueStatus; ground: string }) {
  return (
    <HStack modifiers={[frame({ width: GLYPH, height: TITLE_LINE }), accessibilityHidden()]}>
      <RNHostView matchContents>
        <StageGlyph stage={stage} ground={ground} />
      </RNHostView>
    </HStack>
  )
}

/** Dot needs you, ring idle, check done; working draws the shared animated mark. */
function SessionMark({ word, line }: { word: SessionWord; line: number }) {
  if (word === 'working') {
    return (
      <HStack modifiers={[frame({ width: GLYPH, height: line }), accessibilityHidden()]}>
        <RNHostView matchContents>
          <WorkingMark size={10} />
        </RNHostView>
      </HStack>
    )
  }
  const glyph =
    word === 'needs-you'
      ? { symbol: 'circle.fill', size: 8, tint: color.needsYou }
      : word === 'error'
        ? { symbol: 'circle.fill', size: 8, tint: color.danger }
        : word === 'done'
          ? { symbol: 'checkmark', size: 12, tint: deckColor.done }
          : { symbol: 'circle', size: 8, tint: color.textFaint }
  return (
    <Image
      systemName={glyph.symbol}
      size={glyph.size}
      color={glyph.tint}
      modifiers={[frame({ width: GLYPH, height: line }), accessibilityHidden()]}
    />
  )
}

function SessionMeta({ word, model }: { word: SessionWord; model: string | null }) {
  return (
    <HStack spacing={0}>
      <Text modifiers={metaText(deckWordColor(word))}>{SESSION_WORD_LABEL[word]}</Text>
      {model ? <Text modifiers={metaText(color.textDim)}>{` · ${model}`}</Text> : null}
    </HStack>
  )
}
