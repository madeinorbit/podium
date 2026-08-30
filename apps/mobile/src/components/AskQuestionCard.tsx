import {
  type AskAnswerChoice,
  isChosenOption,
  isPreviewLayout,
  parseAskQuestions,
} from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import { Pencil } from './icons'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { alpha } from '../theme/mix'
import { color, font, leading, mono, monoLabel, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

/**
 * What the card submits — the mobile mirror of the web card's answer shape and
 * of `sessions.answerAskUserQuestion`: option digits, free text via the native
 * Other entry, or skip. Who answered is never on the payload; the authority
 * stamps it.
 */
export type AskQuestionAnswer = { skip: true } | { choices: AskAnswerChoice[] }

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
  presentation = 'card',
  askedAt,
}: {
  item: TranscriptItem
  live: boolean
  onAnswer?: (answer: AskQuestionAnswer) => Promise<void>
  presentation?: 'card' | 'band'
  askedAt?: string
}) {
  const questions = parseAskQuestions(item.toolInputJson)
  // `picks[qi]` is the set of chosen 0-based option indices; `custom[qi]` is the
  // typed answer. The two are mutually exclusive per question — the native menu
  // cannot hold an option and an Other answer at once.
  const [picks, setPicks] = useState<Record<number, Set<number>>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const [editing, setEditing] = useState<Record<number, boolean>>({})
  const band = presentation === 'band'
  const asked = askedAt ?? item.ts
  const locked = !live || state === 'sending' || state === 'sent'

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
      <View style={[styles.card, band && styles.band]}>
        <View style={[styles.headerRow, band && styles.bandHeader]}>
          {band ? <View style={styles.askDot} /> : null}
          <Text style={styles.badge}>{band ? 'CLAUDE IS ASKING' : 'QUESTION FOR YOU'}</Text>
          {band ? <View style={styles.askRule} /> : null}
          {band ? <AskedAge at={asked} /> : null}
        </View>
        <Text style={styles.question}>
          {item.toolInput || 'AskUserQuestion (unparseable input)'}
        </Text>
      </View>
    )
  }

  return (
    <View style={[styles.card, band && styles.band]}>
      <View style={[styles.headerRow, band && styles.bandHeader]}>
        {band ? <View style={styles.askDot} /> : null}
        <Text style={styles.badge}>{band ? 'CLAUDE IS ASKING' : 'QUESTION FOR YOU'}</Text>
        {band ? <View style={styles.askRule} /> : null}
        {state === 'sending' ? <Text style={styles.meta}>sending…</Text> : null}
        {state === 'sent' ? <Text style={styles.meta}>answer sent</Text> : null}
        {state === 'failed' ? <Text style={styles.metaError}>not delivered — retry</Text> : null}
        {band && state === 'idle' ? <AskedAge at={asked} /> : null}
      </View>
      {questions.map((q, qi) => (
        <View key={q.question} style={[styles.questionBlock, band && styles.questionBlockBand]}>
          <Text style={[styles.question, band && styles.questionBand]}>{q.question}</Text>
          <View style={[styles.options, band && styles.optionsBand]}>
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
                    band && styles.optionBand,
                    highlighted && styles.optionPicked,
                    band && oi === 0 && styles.optionBandPrimary,
                    pressed && !locked && styles.optionPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.optionLabel,
                      highlighted && styles.optionLabelPicked,
                      band && oi === 0 && styles.optionBandPrimaryText,
                    ]}
                  >
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
            {band && live && state !== 'sent' ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Write a different answer"
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
          {live && state !== 'sent' && (!band || editing[qi]) ? (
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
          {!band ? (
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
    </View>
  )
}

function AskedAge({ at }: { at: string | undefined }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!at) return
    const timer = setInterval(() => setNow(Date.now()), 20_000)
    return () => clearInterval(timer)
  }, [at])
  if (!at) return null
  const start = Date.parse(at)
  if (!Number.isFinite(start)) return null
  const minutes = Math.max(0, Math.floor((now - start) / 60_000))
  const age =
    minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
  return <Text style={styles.askedAge}>{`asked ${age}`}</Text>
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
  band: {
    borderRadius: 0,
    borderLeftWidth: 0,
    borderRightWidth: 0,
    backgroundColor: alpha(color.needsYou, 0.05),
    paddingTop: 15,
    paddingRight: 11,
    paddingBottom: 15,
    paddingLeft: 13,
    gap: space.sm,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bandHeader: {
    justifyContent: 'flex-start',
    gap: 6,
  },
  askDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.needsYou,
  },
  askRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.needsYouBorder,
  },
  badge: {
    ...monoLabel(),
    color: color.needsYouText,
  },
  meta: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
  },
  askedAge: {
    ...mono(400),
    color: color.textMicro,
    fontSize: 11,
  },
  metaError: {
    ...sans(400),
    color: color.danger,
    fontSize: font.tiny,
  },
  questionBlock: {
    gap: space.sm + 2,
  },
  questionBlockBand: {
    gap: space.sm,
  },
  question: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
    letterSpacing: -0.1,
  },
  questionBand: {
    fontSize: font.small,
  },
  options: {
    gap: space.sm,
  },
  optionsBand: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
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
  optionBand: {
    flex: 1,
    height: 38,
    paddingHorizontal: space.md,
    paddingVertical: 0,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionBandPrimary: {
    borderColor: color.needsYou,
    backgroundColor: color.needsYou,
  },
  optionBandPrimaryText: {
    color: color.onAccent,
  },
  editAnswer: {
    width: 44,
    height: 38,
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
    ...sans(600),
    color: color.text,
    fontSize: font.small,
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
