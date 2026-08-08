import type { IssueWire } from '@podium/model'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, leading, monoLabel, radius, sans, space } from '../theme/theme'
import { PressableScale } from './PressableScale'

/** The task-owned human question, actionable without a global decision queue. */
export function IssueQuestionCard({
  issue,
  onAnswer,
  onOpenSession,
  onResolve,
}: {
  issue: IssueWire
  onAnswer?: (answer: string) => Promise<void>
  onOpenSession?: () => void
  onResolve: () => Promise<void>
}) {
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const options = issue.humanQuestionOptions ?? []

  const commit = async (action: () => Promise<void>) => {
    setSending(true)
    setFailed(false)
    try {
      await action()
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={styles.card} testID="issue-question-card">
      <View style={styles.headingRow}>
        <Text style={styles.label}>DECISION NEEDED</Text>
        {sending ? <Text style={styles.meta}>sending…</Text> : null}
        {failed ? <Text style={styles.error}>not sent — try again</Text> : null}
      </View>
      <Text style={styles.question}>
        {issue.humanQuestion?.trim() || 'This task is waiting for human input.'}
      </Text>
      {options.length > 0 && onAnswer ? (
        <View style={styles.options}>
          {options.map((option) => (
            <PressableScale
              key={option}
              accessibilityRole="button"
              accessibilityLabel={option}
              disabled={sending}
              onPress={() => void commit(() => onAnswer(option))}
              style={[styles.option, sending && styles.muted]}
            >
              <Text style={styles.optionText}>{option}</Text>
            </PressableScale>
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        {onOpenSession ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Answer in session"
            disabled={sending}
            onPress={onOpenSession}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>Answer in session</Text>
          </PressableScale>
        ) : null}
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Mark question resolved"
          disabled={sending}
          onPress={() => void commit(onResolve)}
          style={styles.resolve}
        >
          <Text style={styles.resolveText}>Mark resolved</Text>
        </PressableScale>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    borderWidth: 1,
    borderColor: color.needsYouBorder,
    borderRadius: radius.md,
    backgroundColor: color.needsYouSoft,
    padding: space.md,
    gap: space.sm,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  label: {
    ...monoLabel(),
    color: color.needsYou,
  },
  meta: {
    marginLeft: 'auto',
    color: color.textDim,
    fontSize: font.tiny,
  },
  error: {
    marginLeft: 'auto',
    color: color.danger,
    fontSize: font.tiny,
  },
  question: {
    ...sans(600),
    color: color.text,
    fontSize: font.body,
    lineHeight: leading(font.body, 'prose'),
  },
  options: {
    gap: space.sm,
  },
  option: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    backgroundColor: color.elevated,
    paddingHorizontal: space.md,
    justifyContent: 'center',
  },
  optionText: {
    ...sans(500),
    color: color.body,
    fontSize: font.small,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  primary: {
    minHeight: 40,
    borderRadius: radius.sm,
    backgroundColor: color.accent,
    paddingHorizontal: space.md,
    justifyContent: 'center',
  },
  primaryText: {
    ...sans(600),
    color: color.onAccent,
    fontSize: font.small,
  },
  resolve: {
    minHeight: 40,
    paddingHorizontal: space.xs,
    justifyContent: 'center',
  },
  resolveText: {
    ...sans(500),
    color: color.textDim,
    fontSize: font.tiny,
  },
  muted: {
    opacity: 0.5,
  },
})
