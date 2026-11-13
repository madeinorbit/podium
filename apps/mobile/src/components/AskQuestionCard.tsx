import {
  type AskAnswerChoice,
  askQuestionOutcome,
  codexAsyncQuestionReply,
  isChosenOption,
  isCodexAsyncQuestion,
  isPreviewLayout,
  parseAskQuestions,
} from '@podium/client-core/values'
import type { TranscriptItem } from '@podium/model'
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { decisionTile } from './decision-tile'
import { Icon } from './Icon'
import { Pencil } from './icons'
import { PressableScale } from './PressableScale'

/**
 * What the card submits — the mobile mirror of the web card's answer shape and
 * of `sessions.answerAskUserQuestion`: option digits, free text via the native
 * Other entry, or skip. Who answered is never on the payload; the authority
 * stamps it.
 */
export type AskQuestionAnswer =
  | (({ skip: true } | { choices: AskAnswerChoice[] }) & {
      interactionId?: string
      question?: string
    })
  | { reply: { itemId: string; question: string; text: string } }

/**
 * The agent asking the human — options rendered as big tap targets. Live cards
 * submit 1-based option indices (single-select commits on first tap, multi-select
 * gets an explicit confirm); answered cards show the chosen option highlighted.
 *
 * FREE TEXT AND SKIP (POD-602) match the web card and Claude's own contract:
 * the native menu always appends an Other entry after the agent's options, so a
 * typed answer rides `otherIndex` = optionCount + 1, and Skip is Esc on the
 * whole dialog. The box is deliberately single-line — the server types the text
 * straight into the live menu's Other field, where a newline would submit early.
 */
export function AskQuestionCard({
  item,
  live,
  onAnswer,
  interactionId,
  presentation = 'card',
  compact = false,
}: {
  item: TranscriptItem
  live: boolean
  interactionId?: string
  onAnswer?: (answer: AskQuestionAnswer) => Promise<void>
  presentation?: 'card' | 'band'
  askedAt?: string
  compact?: boolean
}) {
  const questions = parseAskQuestions(item.toolInputJson)
  const codex = isCodexAsyncQuestion(item)
  const outcome = askQuestionOutcome({ item })
  const resultDetail =
    outcome === 'failed' || outcome === 'unknown'
      ? item.toolResult?.trim() || 'No answer was recorded.'
      : undefined
  const { height: screenHeight } = useWindowDimensions()
  // `picks[qi]` is the set of chosen 0-based option indices; `custom[qi]` is the
  // typed answer. The two are mutually exclusive per question — the native menu
  // cannot hold an option and an Other answer at once.
  const [picks, setPicks] = useState<Record<number, Set<number>>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const [editing, setEditing] = useState<Record<number, boolean>>({})
  const [expanded, setExpanded] = useState(false)
  const [answerFocused, setAnswerFocused] = useState(false)
  useEffect(() => {
    if (!compact) setExpanded(false)
  }, [compact])
  const band = presentation === 'band'
  const answerSent = state === 'sent' && !resultDetail
  const locked = !live || state === 'sending' || answerSent

  const typed = (source: Record<number, string>, qi: number) => source[qi]?.trim() ?? ''

  /** One entry per question, in order; null when some question is unanswered. */
  const buildChoices = (
    nextPicks: Record<number, Set<number>>,
    nextCustom: Record<number, string>,
  ): AskAnswerChoice[] | null => {
    // The question's SHAPE travels with its answer: the native menu leaves a
    // multi-select only on Tab, and the server cannot infer that from one pick
    // (POD-609). A question with per-option previews draws a different dialog
    // again — no Other row, digits that only move a cursor — and answering it
    // with the list script silently commits option 1 (POD-770).
    const choices: AskAnswerChoice[] = []
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi]
      const shape = {
        ...(q?.multiSelect ? { multiSelect: true as const } : {}),
        ...(q && isPreviewLayout(q) ? { previewLayout: true as const } : {}),
      }
      const text = typed(nextCustom, qi)
      if (text !== '') {
        choices.push({ freeText: text, otherIndex: (q?.options.length ?? 0) + 1, ...shape })
        continue
      }
      const indices = [...(nextPicks[qi] ?? new Set<number>())]
        .sort((a, b) => a - b)
        .map((oi) => oi + 1)
      if (indices.length === 0) return null
      choices.push({ optionIndices: indices, ...shape })
    }
    return choices
  }

  const submit = async (
    nextPicks: Record<number, Set<number>>,
    nextCustom: Record<number, string> = custom,
  ) => {
    if (!onAnswer) return
    const choices = buildChoices(nextPicks, nextCustom)
    if (!choices) return
    setState('sending')
    try {
      await onAnswer(
        codex
          ? {
              reply: {
                itemId: item.id,
                question: item.toolInputJson ?? '',
                text: codexAsyncQuestionReply(item, choices),
              },
            }
          : {
              choices,
              ...(interactionId ? { interactionId, question: item.toolInputJson } : {}),
            },
      )
      setState('sent')
    } catch {
      setState('failed')
    }
  }

  const skip = async () => {
    if (!onAnswer || locked || codex) return
    setState('sending')
    try {
      await onAnswer({
        skip: true,
        ...(interactionId ? { interactionId, question: item.toolInputJson } : {}),
      })
      setState('sent')
    } catch {
      setState('failed')
    }
  }

  const onOption = (qi: number, oi: number, multiSelect: boolean) => {
    if (locked) return
    const cur = new Set(picks[qi])
    if (multiSelect) {
      if (cur.has(oi)) cur.delete(oi)
      else cur.add(oi)
    } else {
      cur.clear()
      cur.add(oi)
    }
    const nextPicks = { ...picks, [qi]: cur }
    // Choosing a listed option drops this question's typed answer.
    const nextCustom = { ...custom, [qi]: '' }
    setPicks(nextPicks)
    setCustom(nextCustom)
    // Tap-to-commit only while the card is pure single-select taps. Any typed
    // answer anywhere hands the commit to the Send button instead — a tap must
    // never fire a half-typed sentence at the agent.
    const allSingle = questions.every((q) => !q.multiSelect)
    const noneTyped = questions.every((_, i) => typed(nextCustom, i) === '')
    const everyAnswered = questions.every((_, i) => (nextPicks[i]?.size ?? 0) > 0)
    if (allSingle && noneTyped && everyAnswered) void submit(nextPicks, nextCustom)
  }

  const onCustomChange = (qi: number, value: string) => {
    if (locked) return
    setCustom({ ...custom, [qi]: value })
    if (value.trim() !== '' && (picks[qi]?.size ?? 0) > 0) setPicks({ ...picks, [qi]: new Set() })
  }

  const anyTyped = questions.some((_, qi) => typed(custom, qi) !== '')
  const commitsOnTap = questions.every((q) => !q.multiSelect) && !anyTyped
  const needsConfirm = live && !answerSent && !commitsOnTap
  const showActions = live && !answerSent && questions.length > 0
  const allAnswered =
    questions.length > 0 &&
    questions.every((_, qi) => (picks[qi]?.size ?? 0) > 0 || typed(custom, qi) !== '')

  if (questions.length === 0) {
    return (
      <View testID="ask-question-tile" style={[styles.card, band && styles.band]}>
        <Text style={styles.question}>
          {item.toolInput || 'AskUserQuestion (unparseable input)'}
        </Text>
      </View>
    )
  }

  if (compact && !expanded && !answerFocused)
    return (
      <View
        testID="ask-question-compact"
        style={[styles.card, band && styles.band, styles.compact]}
      >
        <Text style={[styles.question, styles.compactTitle]} numberOfLines={1}>
          {resultDetail ?? questions[0]?.question}
        </Text>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Show question"
          onPress={() => setExpanded(true)}
          style={styles.compactButton}
        >
          <Text style={styles.compactLabel}>Show</Text>
        </PressableScale>
      </View>
    )

  return (
    <View testID="ask-question-tile" style={[styles.card, band && styles.band]}>
      <ScrollView
        testID="ask-question-scroll"
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: Math.min(420, screenHeight * 0.4) - space.md * 2 }}
        contentContainerStyle={styles.scrollContent}
      >
        {resultDetail ? (
          <Text style={styles.metaError} accessibilityLiveRegion="polite">
            {resultDetail}
          </Text>
        ) : null}
        {state !== 'idle' && !(state === 'sent' && resultDetail) ? (
          <Text
            style={state === 'failed' ? styles.metaError : styles.meta}
            accessibilityLiveRegion="polite"
          >
            {state === 'sending'
              ? 'Sending…'
              : state === 'sent'
                ? 'Answer sent'
                : 'Not delivered. Try again.'}
          </Text>
        ) : null}
        {questions.map((q, qi) => (
          <View key={q.question} style={[styles.questionBlock, band && styles.questionBlockBand]}>
            <Text style={[styles.question, band && styles.questionBand]}>{q.question}</Text>
            <View style={[styles.options, band && styles.optionsBand]}>
              {q.options.map((opt, oi) => {
                const picked = picks[qi]?.has(oi) ?? false
                const chosen = !live && isChosenOption(item.toolResult ?? '', opt.label)
                const highlighted = picked || chosen || (answerSent && picked)
                return (
                  <PressableScale
                    key={opt.label}
                    accessibilityRole="button"
                    accessibilityLabel={opt.label}
                    disabled={locked && !chosen}
                    hitSlop={band ? 6 : undefined}
                    onPress={() => onOption(qi, oi, q.multiSelect === true)}
                    style={({ pressed }) => [
                      styles.option,
                      band && styles.optionBand,
                      highlighted && styles.optionPicked,
                      pressed && !locked && styles.optionPressed,
                    ]}
                  >
                    <Text style={[styles.optionLabel, highlighted && styles.optionLabelPicked]}>
                      {opt.label}
                    </Text>
                    {opt.description && !band ? (
                      <Text style={styles.optionDesc} numberOfLines={3}>
                        {opt.description}
                      </Text>
                    ) : null}
                  </PressableScale>
                )
              })}
              {band && live && !answerSent ? (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Write a different answer"
                  hitSlop={6}
                  disabled={locked}
                  onPress={() => setEditing({ ...editing, [qi]: true })}
                  style={({ pressed }) => [
                    styles.editAnswer,
                    pressed && !locked && styles.optionPressed,
                  ]}
                >
                  <Icon as={Pencil} size={14} color={color.textDim} />
                </PressableScale>
              ) : null}
            </View>
            {/* The free-text escape rides the native Other entry. Live only —
              a read-only card is a record, not a control. */}
            {live && !answerSent && (!band || editing[qi]) ? (
              <TextInput
                testID={`ask-free-text-${qi}`}
                accessibilityLabel="Type your own answer"
                value={custom[qi] ?? ''}
                onFocus={() => {
                  setAnswerFocused(true)
                  setExpanded(true)
                }}
                onBlur={() => setAnswerFocused(false)}
                onChangeText={(text) => onCustomChange(qi, text)}
                onSubmitEditing={() => {
                  if (!locked && allAnswered) void submit(picks)
                }}
                placeholder="Or type your own answer…"
                placeholderTextColor={color.textFaint}
                editable={!locked}
                returnKeyType="send"
                style={[styles.input, locked && styles.inputLocked]}
              />
            ) : null}
          </View>
        ))}
        {showActions && (!band || needsConfirm) ? (
          <View style={styles.actions}>
            {needsConfirm ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Send answer"
                disabled={locked || !allAnswered}
                onPress={() => void submit(picks)}
                style={[styles.confirm, (locked || !allAnswered) && styles.confirmDisabled]}
              >
                <Text style={styles.confirmText}>Send answer</Text>
              </PressableScale>
            ) : null}
            {!band && !codex ? (
              <PressableScale
                testID="ask-skip"
                accessibilityRole="button"
                accessibilityLabel="Skip question"
                disabled={locked}
                onPress={() => void skip()}
                style={[styles.skip, locked && styles.confirmDisabled]}
              >
                <Text style={styles.skipText}>Skip</Text>
              </PressableScale>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  scrollContent: { gap: space.sm },
  compact: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 0 },
  compactTitle: { flex: 1, minWidth: 0 },
  compactButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  compactLabel: { ...sans(600), color: color.accentTint, fontSize: font.small },
  card: { ...decisionTile.card, ...decisionTile.signal },
  band: { marginHorizontal: space.lg, marginVertical: space.sm },
  meta: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  metaError: {
    ...sans(400),
    color: color.dangerText,
    fontSize: font.tiny,
  },
  questionBlock: {
    flexShrink: 0,
    minWidth: 0,
    gap: space.sm + 2,
  },
  questionBlockBand: {
    gap: space.sm,
  },
  question: {
    flexShrink: 0,
    ...sans(600),
    color: color.text,
    fontSize: 15,
    lineHeight: 20,
  },
  questionBand: {
    fontSize: font.small,
  },
  options: {
    gap: space.sm,
  },
  optionsBand: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  option: {
    backgroundColor: color.surfaceHigh,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 1,
    gap: 3,
  },
  optionBand: { ...decisionTile.button, borderWidth: 0, alignItems: 'center', flexShrink: 1 },
  editAnswer: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceHigh,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.sm,
  },
  optionPressed: {
    backgroundColor: color.surfacePressed,
  },
  optionPicked: {
    borderColor: color.accent,
    backgroundColor: color.accentSoft,
  },
  optionLabel: {
    maxWidth: '100%',
    minWidth: 0,
    ...sans(500),
    color: color.text,
    fontSize: 14,
    lineHeight: 20,
  },
  optionLabelPicked: {
    color: color.accentTint,
  },
  optionDesc: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  input: {
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    ...sans(400),
    color: color.text,
    fontSize: font.small,
  },
  inputLocked: {
    opacity: 0.4,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  // The same quiet-accent grammar as the band's primary option: keyline and
  // tinted label, not a filled slab. Still unmistakably the commit — it is the
  // only bordered-accent shape on the card.
  confirm: {
    flex: 1,
    backgroundColor: color.accentSoft,
    borderWidth: 1,
    borderColor: color.accentBorder,
    borderRadius: radius.control,
    alignItems: 'center',
    paddingVertical: space.md,
  },
  confirmDisabled: {
    opacity: 0.4,
  },
  confirmText: {
    ...sans(600),
    color: color.accentTint,
    fontSize: font.small,
  },
  // Bordered rather than bare text: alone on its row (the single-select case)
  // an unframed word does not read as the tap target it is.
  skip: {
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.control,
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  skipText: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.small,
  },
})
