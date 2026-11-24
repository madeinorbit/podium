import type { SessionResurrectionResult } from '@podium/client-core/commands'
import { type ExitedAction, exitedRecovery } from '@podium/client-core/values'
import type { SessionMeta } from '@podium/model'
import { type JSX, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { color, font, leading, mono, radius, sans, space } from '../theme/theme'
import { Icon } from './Icon'
import { Moon, RotateCcw } from './icons'
import { PressableScale } from './PressableScale'

type RecoveryActionId = 'resume' | 'restart' | 'relaunch' | 'remove'

interface RecoveryAction {
  id: RecoveryActionId
  label: string
  compactLabel: string
  busyLabel: string | null
  hint: string
}

function recoveryAction(kind: 'parked' | 'ended', action: ExitedAction): RecoveryAction {
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
  // Nothing to lose and something still to try: the agent died during startup,
  // before it opened a conversation. Same resurrect call as Resume — the server
  // holds the proof and decides that this one goes out without a resume ref.
  if (action === 'relaunch') {
    return {
      id: 'relaunch',
      label: 'Start the agent again',
      compactLabel: 'Start again',
      busyLabel: 'Starting…',
      hint: 'It stopped before opening a conversation, so there is nothing to resume — starting again runs it fresh in the same directory.',
    }
  }
  return {
    id: 'remove',
    label: 'Remove session',
    compactLabel: 'Remove',
    busyLabel: null,
    // NOT "it left no conversation": that case is `relaunch` above. What is left
    // is a session with no recorded way back into a conversation that may exist.
    hint: 'No way back into its conversation was recorded.',
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
  notice = false,
}: {
  action: RecoveryAction
  session: Pick<
    SessionMeta,
    | 'sessionId'
    | 'status'
    | 'stoppedAt'
    | 'exitCode'
    | 'spawnFailure'
    | 'agentKind'
    | 'resumable'
    | 'neverBound'
  >
  onResume: (sessionId: SessionMeta['sessionId']) => Promise<SessionResurrectionResult>
  onRemove: (sessionId: SessionMeta['sessionId']) => Promise<void>
  notice?: boolean
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = notice ? action.compactLabel : action.label

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    let resumed = false
    try {
      if (action.id === 'remove') {
        await onRemove(session.sessionId)
      } else {
        const result = await onResume(session.sessionId)
        resumed = result.ok
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
      // Keep the same note until lifecycle sync replaces it. A fast success
      // must not flash Resume between the busy label and the live transcript.
      if (!resumed) setBusy(false)
    }
  }

  return (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: busy, busy }}
        aria-busy={busy}
        disabled={busy}
        testID={['lifecycle-', action.id].join('')}
        onPress={() => void run()}
        style={({ pressed }) => [
          notice ? styles.noticeAction : styles.action,
          !notice && action.id === 'remove' ? styles.removeAction : null,
          pressed ? (notice ? styles.noticeActionPressed : styles.actionPressed) : null,
        ]}
      >
        <Text
          style={
            notice
              ? styles.noticeActionText
              : action.id === 'remove'
                ? styles.removeText
                : styles.actionText
          }
        >
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

export function MobileSessionLifecycle({
  session,
  hasTranscript,
  onResume,
  onRemove,
  installRecovery,
}: {
  session: Pick<
    SessionMeta,
    | 'sessionId'
    | 'status'
    | 'stoppedAt'
    | 'exitCode'
    | 'spawnFailure'
    | 'agentKind'
    | 'resumable'
    | 'neverBound'
  >
  installRecovery?: JSX.Element
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
        neverBound: session.neverBound === true,
      })
  const action = parked
    ? recoveryAction('parked', 'resume')
    : recoveryAction('ended', ended?.action ?? 'remove')
  const detail = ended?.detail ?? ''

  if (hasTranscript) {
    return (
      <View style={styles.notice} testID={parked ? 'hibernated-notice' : 'exited-notice'}>
        <View style={styles.noticeHeading}>
          <Icon as={parked ? Moon : RotateCcw} size={13} color={color.textDim} />
          <Text style={styles.noticeTitle}>{parked ? 'Hibernated' : 'Exited'}</Text>
        </View>
        <Text style={styles.noticeCopy}>
          {parked
            ? 'Its process was stopped to free memory.\nThe conversation is intact.'
            : `${detail} Transcript is read-only.`}
        </Text>
        {!parked && installRecovery}
        <LifecycleButton
          key={`${session.status}:${session.stoppedAt ?? session.exitCode ?? ''}`}
          action={action}
          session={session}
          onResume={onResume}
          onRemove={onRemove}
          notice
        />
      </View>
    )
  }

  return (
    <View style={styles.pane} testID="lifecycle-pane">
      <Icon as={parked ? Moon : RotateCcw} size={28} color={color.accentTint} />
      <Text style={styles.paneCopy}>{parked ? action.hint : `${detail} ${action.hint}`}</Text>
      {!parked && installRecovery}
      <LifecycleButton
        key={`${session.status}:${session.stoppedAt ?? session.exitCode ?? ''}`}
        action={action}
        session={session}
        onResume={onResume}
        onRemove={onRemove}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  notice: {
    alignItems: 'center',
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  noticeHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  noticeTitle: {
    ...sans(600),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  noticeCopy: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
    textAlign: 'center',
  },
  noticeAction: {
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
  },
  noticeActionText: {
    ...sans(600),
    color: color.accentTint,
    fontSize: font.small,
  },
  noticeActionPressed: {
    backgroundColor: color.surfacePressed,
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
  /** Remove is the SECONDARY of the pane, not its alarm: the copy above it
   *  already says the session left nothing to resume, and a red-rimmed button
   *  under that sentence reads as a warning about pressing it. */
  removeAction: {
    backgroundColor: color.surfaceHigh,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
  },
  actionText: {
    ...mono(700),
    color: color.onAccent,
    fontSize: font.micro,
  },
  removeText: {
    ...mono(700),
    color: color.body,
    fontSize: font.micro,
  },
  error: {
    ...sans(500),
    color: color.dangerText,
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
  paneCopy: {
    ...sans(400),
    color: color.textDim,
    fontSize: font.small,
    lineHeight: leading(font.small, 'prose'),
    maxWidth: 360,
    textAlign: 'center',
  },
})
