import type { SessionResurrectionResult } from '@podium/client-core/engine'
import { exitedRecovery } from '@podium/client-core/viewmodels'
import type { SessionMeta } from '@podium/model'
import { Moon, RotateCcw } from 'lucide-react-native'
import { type JSX, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, leading, mono, radius, sans, space, tone } from '../theme/theme'
import { Icon } from './Icon'
import { PressableScale } from './PressableScale'

type RecoveryActionId = 'resume' | 'restart' | 'remove'

interface RecoveryAction {
  id: RecoveryActionId
  label: string
  compactLabel: string
  busyLabel: string | null
  hint: string
}

function recoveryAction(
  kind: 'parked' | 'ended',
  action: 'restart' | 'resume' | 'remove',
): RecoveryAction {
  if (kind === 'parked') {
    return {
      id: 'resume',
      label: 'Resume session',
      compactLabel: 'Resume',
      busyLabel: 'Waking…',
      hint: 'This session is hibernated — its process was stopped to free memory, but the conversation is intact.',
    }
  }
  if (action === 'restart') {
    return {
      id: 'restart',
      label: 'Restart shell',
      compactLabel: 'Restart',
      busyLabel: 'Restarting…',
      hint: 'Restart opens a fresh shell in the same directory.',
    }
  }
  if (action === 'resume') {
    return {
      id: 'resume',
      label: 'Resume session',
      compactLabel: 'Resume',
      busyLabel: 'Resuming…',
      hint: 'The conversation is intact — resume to pick up where it left off.',
    }
  }
  return {
    id: 'remove',
    label: 'Remove session',
    compactLabel: 'Remove',
    busyLabel: null,
    hint: 'It left no conversation to resume.',
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'unknown error'
}

function LifecycleButton({
  action,
  session,
  onResume,
  onRemove,
  compact,
}: {
  action: RecoveryAction
  session: SessionMeta
  onResume: (sessionId: SessionMeta['sessionId']) => Promise<SessionResurrectionResult>
  onRemove: (sessionId: SessionMeta['sessionId']) => Promise<void>
  compact: boolean
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = compact ? action.compactLabel : action.label

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (action.id === 'remove') {
        await onRemove(session.sessionId)
      } else {
        const result = await onResume(session.sessionId)
        if (!result.ok) {
          setError(`Couldn't resume the session — ${result.reason ?? 'unknown error'}`)
        }
      }
    } catch (cause) {
      setError(
        action.id === 'remove'
          ? `Couldn't remove the session — ${errorMessage(cause)}`
          : `Couldn't resume the session — ${errorMessage(cause)}`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={busy}
        testID={['lifecycle-', action.id].join('')}
        onPress={() => void run()}
        style={({ pressed }) => [
          styles.action,
          action.id === 'remove' ? styles.removeAction : null,
          pressed ? styles.actionPressed : null,
        ]}
      >
        <Text style={[styles.actionText, action.id === 'remove' ? styles.removeText : null]}>
          {busy && action.busyLabel ? action.busyLabel : label}
        </Text>
      </PressableScale>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error} testID="lifecycle-error">
          {error}
        </Text>
      ) : null}
    </>
  )
}

export function SessionLifecycle({
  session,
  hasTranscript,
  onResume,
  onRemove,
}: {
  session: SessionMeta
  hasTranscript: boolean
  onResume: (sessionId: SessionMeta['sessionId']) => Promise<SessionResurrectionResult>
  onRemove: (sessionId: SessionMeta['sessionId']) => Promise<void>
}): JSX.Element | null {
  if (session.status !== 'hibernated' && session.status !== 'exited') return null

  const parked = session.status === 'hibernated'
  const ended = parked
    ? null
    : exitedRecovery({
        exitCode: session.exitCode,
        ...(session.spawnFailure ? { spawnFailure: session.spawnFailure } : {}),
        isShell: session.agentKind === 'shell',
        resumable: session.resumable === true,
      })
  const action = parked
    ? recoveryAction('parked', 'resume')
    : recoveryAction('ended', ended?.action ?? 'remove')
  const detail = ended?.detail ?? ''

  if (!hasTranscript) {
    return (
      <View
        style={[styles.pane, parked ? styles.parkedPane : styles.endedPane]}
        testID="lifecycle-pane"
      >
        <Icon
          as={parked ? Moon : RotateCcw}
          size={28}
          color={parked ? tone.accent.fg : tone.danger.fg}
        />
        <Text style={styles.paneCopy}>{parked ? action.hint : `${detail} ${action.hint}`}</Text>
        <LifecycleButton
          action={action}
          session={session}
          onResume={onResume}
          onRemove={onRemove}
          compact={false}
        />
      </View>
    )
  }

  return (
    <View
      accessibilityRole="summary"
      style={[styles.banner, parked ? styles.parkedBanner : styles.endedBanner]}
      testID="lifecycle-banner"
    >
      <View style={styles.bannerRow}>
        <Icon
          as={parked ? Moon : RotateCcw}
          size={15}
          color={parked ? tone.accent.fg : tone.danger.fg}
        />
        <Text style={[styles.bannerText, parked ? styles.parkedText : styles.endedText]}>
          {parked
            ? 'Hibernated — transcript is read-only until you resume.'
            : `${detail} Transcript is read-only.`}
        </Text>
        <LifecycleButton
          action={action}
          session={session}
          onResume={onResume}
          onRemove={onRemove}
          compact
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexShrink: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  parkedBanner: {
    backgroundColor: tone.accent.bg,
    borderBottomColor: tone.accent.border,
  },
  endedBanner: {
    backgroundColor: tone.danger.bg,
    borderBottomColor: tone.danger.border,
  },
  bannerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  bannerText: {
    ...sans(400),
    flex: 1,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
    paddingTop: 1,
  },
  parkedText: {
    color: tone.accent.fg,
  },
  endedText: {
    color: tone.danger.fg,
  },
  action: {
    alignSelf: 'flex-start',
    backgroundColor: color.accent,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
  },
  actionPressed: {
    backgroundColor: color.accentTint,
  },
  removeAction: {
    backgroundColor: color.surfaceHigh,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tone.danger.border,
  },
  actionText: {
    ...mono(700),
    color: color.onAccent,
    fontSize: font.micro,
  },
  removeText: {
    color: tone.danger.fg,
  },
  error: {
    ...sans(500),
    color: color.danger,
    fontSize: font.micro,
    lineHeight: leading(font.micro, 'prose'),
    paddingTop: space.xs,
  },
  pane: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
  },
  parkedPane: {
    backgroundColor: tone.accent.bg,
  },
  endedPane: {
    backgroundColor: tone.danger.bg,
  },
  paneCopy: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
    maxWidth: 360,
    textAlign: 'center',
  },
})
