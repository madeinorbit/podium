import { outboxCommandFor } from '@podium/client-core/engine'
import { randomUUID } from '@podium/client-core/id'
import type { OutboxDeadLetterEntry } from '@podium/client-core/outbox'
import {
  describeQueuedChange,
  inlineConfirmationCanSatisfy,
  recoverableAuthoredText,
  recoveryCopyFor,
  recoveryDialogCopy,
  replaceAuthoredText,
  unsatisfiableConfirmationDetail,
} from '@podium/client-core/outbox-recovery-copy'
import type { ConfirmationRule } from '@podium/commands'
import { asMutationId } from '@podium/model'
import { recoveryPlanFor } from '@podium/sync/outbox'
import { useEffect, useState } from 'react'
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileStore } from '../client/hooks'
import { color, font, leading, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { AlertTriangle, Pencil, RefreshCw, Trash2 } from './icons'
import { PressableScale } from './PressableScale'

function confirmationRuleFor(kind: string): ConfirmationRule {
  return outboxCommandFor(kind)?.confirmation ?? 'broker'
}

function DeadLetterCard({ parked }: { parked: OutboxDeadLetterEntry }) {
  const { recoverOutbox } = useMobileStore()
  const plan = recoveryPlanFor(parked.reason.code)
  const baseCopy = recoveryCopyFor(parked.reason.code)
  const rule = confirmationRuleFor(parked.entry.kind)
  const confirmable = plan.retry !== 'confirmation' || inlineConfirmationCanSatisfy(rule)
  const copy = confirmable
    ? baseCopy
    : { ...baseCopy, detail: unsatisfiableConfirmationDetail(rule), retryLabel: undefined }
  const authored = recoverableAuthoredText(parked.entry.input)
  const change = describeQueuedChange(parked.entry.kind, parked.entry.input)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(authored ?? '')
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setDraft(authored ?? '')
    setFailed(null)
  }, [authored])

  const retry = () => {
    try {
      switch (plan.retry) {
        case 'rights-fix':
          recoverOutbox.retry(parked.entry.mutationId, { rightsFixed: true })
          break
        case 'rebase':
          recoverOutbox.retry(parked.entry.mutationId, { expectedRevision: 0 })
          break
        case 'confirmation':
          recoverOutbox.retry(parked.entry.mutationId, { confirmed: true })
          break
        case 'new-mutation-id':
          recoverOutbox.retry(parked.entry.mutationId, {
            mutationId: asMutationId(randomUUID()),
          })
          break
        case 'never':
          return
      }
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const sendUpdated = () => {
    try {
      const input = parked.entry.input
      const next =
        input && typeof input === 'object'
          ? { ...(input as Record<string, unknown>), ...replaceAuthoredText(input, draft) }
          : draft
      recoverOutbox.edit(parked.entry.mutationId, next)
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const discard = () => {
    try {
      recoverOutbox.discard(parked.entry.mutationId)
    } catch (cause) {
      setFailed(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const reasonText =
    authored === null && copy.retryLabel === undefined
      ? `${copy.title}. Discard this change and try again.`
      : `${copy.title}. ${copy.detail}`

  return (
    <View style={styles.card} testID="outbox-recovery-card">
      <Text style={styles.changeLabel}>{change.label}</Text>
      {editing ? (
        <TextInput
          accessibilityLabel="Your text"
          autoFocus
          multiline
          value={draft}
          onChangeText={setDraft}
          style={styles.editor}
          textAlignVertical="top"
        />
      ) : (
        <>
          {authored !== null ? (
            <Text selectable style={styles.authoredText}>
              {authored}
            </Text>
          ) : change.summary ? (
            <Text style={styles.summary}>{change.summary}</Text>
          ) : null}
          <Text style={styles.reason}>{reasonText}</Text>
        </>
      )}
      {failed ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {failed}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {editing ? (
          <>
            <RecoveryButton label="Cancel" onPress={() => setEditing(false)} />
            <RecoveryButton label="Send updated" primary onPress={sendUpdated} />
          </>
        ) : (
          <>
            <RecoveryButton
              destructive
              icon={Trash2}
              label="Discard"
              onPress={() =>
                Alert.alert(
                  'Discard this change?',
                  'The saved change will be removed from this phone and cannot be recovered.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Discard change',
                      style: 'destructive',
                      onPress: discard,
                    },
                  ],
                )
              }
            />
            {copy.retryLabel ? (
              <RecoveryButton
                icon={RefreshCw}
                label={copy.retryLabel}
                primary
                onPress={retry}
                testID="outbox-retry"
              />
            ) : null}
            {authored !== null ? (
              <RecoveryButton
                icon={Pencil}
                label="Edit"
                primary={copy.retryLabel === undefined}
                onPress={() => setEditing(true)}
              />
            ) : null}
          </>
        )}
      </View>
    </View>
  )
}

export function OutboxRecoveryPanel() {
  const { outboxDeadLetters } = useMobileStore()
  if (outboxDeadLetters.length === 0) return null
  const copy = recoveryDialogCopy(outboxDeadLetters.length)
  return (
    <View style={styles.section} accessibilityLiveRegion="polite">
      <View style={styles.headingRow}>
        <Icon as={AlertTriangle} size={18} color={color.dangerText} />
        <View style={styles.headingCopy}>
          <Text accessibilityRole="header" style={styles.heading}>
            {copy.title}
          </Text>
          <Text style={styles.detail}>{copy.detail}</Text>
        </View>
      </View>
      {outboxDeadLetters.map((parked) => (
        <DeadLetterCard key={parked.entry.mutationId} parked={parked} />
      ))}
    </View>
  )
}

function RecoveryButton({
  destructive = false,
  icon,
  label,
  onPress,
  primary = false,
  testID,
}: {
  destructive?: boolean
  icon?: Parameters<typeof Icon>[0]['as']
  label: string
  onPress(): void
  primary?: boolean
  testID?: string
}) {
  const foreground = destructive ? color.dangerText : primary ? color.onAccent : color.textDim
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        pressed && styles.buttonPressed,
      ]}
    >
      {icon ? <Icon as={icon} size={15} color={foreground} /> : null}
      <Text style={[styles.buttonText, { color: foreground }]}>{label}</Text>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: 2,
  },
  headingCopy: { flex: 1, minWidth: 0, gap: 2 },
  heading: { color: color.text, ...sans(600), fontSize: font.body },
  detail: { color: color.textDim, fontSize: font.small, lineHeight: leading(font.small, 'prose') },
  card: {
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.card,
    padding: space.md,
  },
  changeLabel: { color: color.text, ...sans(600), fontSize: font.small },
  authoredText: {
    maxHeight: 120,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    color: color.body,
    padding: space.md,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
  },
  summary: { color: color.body, fontSize: font.small },
  reason: { color: color.textDim, fontSize: font.small, lineHeight: leading(font.small, 'prose') },
  editor: {
    minHeight: 112,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentTint,
    backgroundColor: color.surface,
    color: color.text,
    padding: space.md,
    fontSize: font.small,
  },
  error: { color: color.dangerText, fontSize: font.tiny },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.sm },
  button: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.surfaceHigh,
    paddingHorizontal: space.md,
  },
  buttonPrimary: { borderColor: color.accent, backgroundColor: color.accent },
  buttonPressed: { opacity: 0.82 },
  buttonText: { ...sans(600), fontSize: font.tiny },
})
