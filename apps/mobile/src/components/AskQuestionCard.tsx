import { isChosenOption, parseAskQuestions } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

/**
 * What the card submits — the mobile mirror of the web card's answer shape and
 * of `sessions.answerAskUserQuestion`: option digits, free text via the native
 * Other entry, or skip. Who answered is never on the payload; the authority
 * stamps it.
 */
export type AskQuestionAnswer =
  | { skip: true }
  | { choices: Array<{ optionIndices: number[] } | { freeText: string; otherIndex: number }> }

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
}: {
  item: TranscriptItem
  live: boolean
  onAnswer?: (answer: AskQuestionAnswer) => Promise<void>
}) {
  const questions = parseAskQuestions(item.toolInputJson)
  // `picks[qi]` is the set of chosen 0-based option indices; `custom[qi]` is the
  // typed answer. The two are mutually exclusive per question — the native menu
  // cannot hold an option and an Other answer at once.
  const [picks, setPicks] = useState<Record<number, Set<number>>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const locked = !live || state === 'sending' || state === 'sent'

  const typed = (source: Record<number, string>, qi: number) => source[qi]?.trim() ?? ''

  /** One entry per question, in order; null when some question is unanswered. */
  const buildChoices = (
    nextPicks: Record<number, Set<number>>,
    nextCustom: Record<number, string>,
  ): Extract<AskQuestionAnswer, { choices: unknown }>['choices'] | null => {
    const choices: Extract<AskQuestionAnswer, { choices: unknown }>['choices'] = []
    for (let qi = 0; qi < questions.length; qi++) {
      const text = typed(nextCustom, qi)
      if (text !== '') {
        choices.push({ freeText: text, otherIndex: (questions[qi]?.options.length ?? 0) + 1 })
        continue
      }
      const indices = [...(nextPicks[qi] ?? new Set<number>())]
        .sort((a, b) => a - b)
        .map((oi) => oi + 1)
      if (indices.length === 0) return null
      choices.push({ optionIndices: indices })
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
      await onAnswer({ choices })
      setState('sent')
    } catch {
      setState('failed')
    }
  }

  const skip = async () => {
    if (!onAnswer || locked) return
    setState('sending')
    try {
      await onAnswer({ skip: true })
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
  const needsConfirm = live && state !== 'sent' && !commitsOnTap
  const showActions = live && state !== 'sent' && questions.length > 0
  const allAnswered =
    questions.length > 0 &&
    questions.every((_, qi) => (picks[qi]?.size ?? 0) > 0 || typed(custom, qi) !== '')

  if (questions.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.badge}>QUESTION FOR YOU</Text>
        <Text style={styles.question}>
          {item.toolInput || 'AskUserQuestion (unparseable input)'}
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.badge}>QUESTION FOR YOU</Text>
        {state === 'sending' ? <Text style={styles.meta}>sending…</Text> : null}
        {state === 'sent' ? <Text style={styles.meta}>answer sent</Text> : null}
        {state === 'failed' ? <Text style={styles.metaError}>not delivered — retry</Text> : null}
      </View>
      {questions.map((q, qi) => (
        <View key={q.question} style={styles.questionBlock}>
          <Text style={styles.question}>{q.question}</Text>
          <View style={styles.options}>
            {q.options.map((opt, oi) => {
              const picked = picks[qi]?.has(oi) ?? false
              const chosen = !live && isChosenOption(item.toolResult ?? '', opt.label)
              const highlighted = picked || chosen || (state === 'sent' && picked)
              return (
                <PressableScale
                  key={opt.label}
                  accessibilityRole="button"
                  accessibilityLabel={opt.label}
                  disabled={locked && !chosen}
                  onPress={() => onOption(qi, oi, q.multiSelect === true)}
                  style={({ pressed }) => [
                    styles.option,
                    highlighted && styles.optionPicked,
                    pressed && !locked && styles.optionPressed,
                  ]}
                >
                  <Text style={[styles.optionLabel, highlighted && styles.optionLabelPicked]}>
                    {opt.label}
                  </Text>
                  {opt.description ? (
                    <Text style={styles.optionDesc} numberOfLines={3}>
                      {opt.description}
                    </Text>
                  ) : null}
                </PressableScale>
              )
            })}
          </View>
          {/* The free-text escape rides the native Other entry. Live only —
              a read-only card is a record, not a control. */}
          {live && state !== 'sent' ? (
            <TextInput
              testID={`ask-free-text-${qi}`}
              accessibilityLabel="Type your own answer"
              value={custom[qi] ?? ''}
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
      {showActions ? (
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
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1c1817',
    borderColor: color.needsYouBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.md,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    ...monoLabel(),
    color: color.needsYou,
  },
  meta: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  metaError: {
    ...sans(400),
    color: color.danger,
    fontSize: font.tiny,
  },
  questionBlock: {
    gap: space.sm + 2,
  },
  question: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
    letterSpacing: -0.1,
  },
  options: {
    gap: space.sm,
  },
  option: {
    backgroundColor: color.surfaceHigh,
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 1,
    gap: 3,
  },
  optionPressed: {
    backgroundColor: color.surfacePressed,
  },
  optionPicked: {
    borderColor: color.accent,
    backgroundColor: color.accentSoft,
  },
  optionLabel: {
    ...sans(600),
    color: color.text,
    fontSize: font.small,
  },
  optionLabelPicked: {
    color: color.accent,
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
    borderRadius: radius.md,
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
  confirm: {
    flex: 1,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    paddingVertical: space.md,
  },
  confirmDisabled: {
    opacity: 0.4,
  },
  confirmText: {
    ...sans(700),
    color: color.onAccent,
    fontSize: font.small,
  },
  // Bordered rather than bare text: alone on its row (the single-select case)
  // an unframed word does not read as the tap target it is.
  skip: {
    borderColor: color.border,
    borderWidth: 1,
    borderRadius: radius.md,
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
