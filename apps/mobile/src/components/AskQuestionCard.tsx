import type { TranscriptItem } from '@podium/protocol'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { color, font, radius, space } from '../theme/theme'
import { isChosenOption, parseAskQuestions } from '../viewModels/askQuestion'

/**
 * The agent asking the human — options rendered as big tap targets. Live cards
 * submit 1-based option indices (single-select commits on first tap, multi-select
 * gets an explicit confirm); answered cards show the chosen option highlighted.
 */
export function AskQuestionCard({
  item,
  live,
  onAnswer,
}: {
  item: TranscriptItem
  live: boolean
  onAnswer?: (choices: { optionIndices: number[] }[]) => Promise<void>
}) {
  const questions = parseAskQuestions(item.toolInputJson)
  const [picks, setPicks] = useState<Record<number, Set<number>>>({})
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const locked = !live || state === 'sending' || state === 'sent'

  const submit = async (next: Record<number, Set<number>>) => {
    if (!onAnswer) return
    const choices = questions.map((_, qi) => ({
      optionIndices: [...(next[qi] ?? new Set<number>())].sort((a, b) => a - b).map((oi) => oi + 1),
    }))
    if (choices.some((c) => c.optionIndices.length === 0)) return
    setState('sending')
    try {
      await onAnswer(choices)
      setState('sent')
    } catch {
      setState('failed')
    }
  }

  const onOption = (qi: number, oi: number, multiSelect: boolean) => {
    if (locked) return
    setPicks((prev) => {
      const cur = new Set(prev[qi])
      if (multiSelect) {
        if (cur.has(oi)) cur.delete(oi)
        else cur.add(oi)
      } else {
        cur.clear()
        cur.add(oi)
      }
      const next = { ...prev, [qi]: cur }
      const allSingle = questions.every((q) => !q.multiSelect)
      const allAnswered = questions.every((_, i) => (next[i]?.size ?? 0) > 0)
      if (allSingle && allAnswered) void submit(next)
      return next
    })
  }

  const needsConfirm = live && state === 'idle' && questions.some((q) => q.multiSelect)
  const allAnswered = questions.length > 0 && questions.every((_, qi) => (picks[qi]?.size ?? 0) > 0)

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
              const chosen = !live && isChosenOption(item, opt.label)
              const highlighted = picked || chosen || (state === 'sent' && picked)
              return (
                <Pressable
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
                </Pressable>
              )
            })}
          </View>
        </View>
      ))}
      {needsConfirm ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send answer"
          disabled={!allAnswered}
          onPress={() => void submit(picks)}
          style={[styles.confirm, !allAnswered && styles.confirmDisabled]}
        >
          <Text style={styles.confirmText}>Send answer</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.needsYouBg,
    borderColor: color.needsYou,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    color: color.needsYou,
    fontSize: font.tiny,
    fontWeight: '700',
    letterSpacing: 1,
  },
  meta: {
    color: color.textDim,
    fontSize: font.tiny,
  },
  metaError: {
    color: color.danger,
    fontSize: font.tiny,
  },
  questionBlock: {
    gap: space.sm,
  },
  question: {
    color: color.text,
    fontSize: font.body,
    fontWeight: '600',
    lineHeight: 21,
  },
  options: {
    gap: space.sm,
  },
  option: {
    backgroundColor: color.card,
    borderColor: color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: 2,
  },
  optionPressed: {
    backgroundColor: color.cardPressed,
  },
  optionPicked: {
    borderColor: color.accent,
    backgroundColor: '#1a2338',
  },
  optionLabel: {
    color: color.text,
    fontSize: font.body,
    fontWeight: '600',
  },
  optionLabelPicked: {
    color: color.accent,
  },
  optionDesc: {
    color: color.textDim,
    fontSize: font.small,
    lineHeight: 18,
  },
  confirm: {
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    alignItems: 'center',
    paddingVertical: space.md,
  },
  confirmDisabled: {
    opacity: 0.4,
  },
  confirmText: {
    color: color.accentText,
    fontSize: font.body,
    fontWeight: '700',
  },
})
