import type { SessionResurrectionResult } from '@podium/client-core/engine'
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
  compact,
  notice = false,
}: {
  action: RecoveryAction
  session: Pick<
    SessionMeta,
    'sessionId' | 'status' | 'exitCode' | 'spawnFailure' | 'agentKind' | 'resumable' | 'neverBound'
  >
  onResume: (sessionId: SessionMeta['sessionId']) => Promise<SessionResurrectionResult>
  onRemove: (sessionId: SessionMeta['sessionId']) => Promise<void>
  compact: boolean
  notice?: boolean
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
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        testID={['lifecycle-', action.id].join('')}
        onPress={() => void run()}
        style={({ pressed }) => [
          notice ? styles.noticeAction : compact ? styles.barAction : styles.action,
          !compact && action.id === 'remove' ? styles.removeAction : null,
          pressed ? (notice || compact ? styles.barActionPressed : styles.actionPressed) : null,
        ]}
      >
        <Text
          style={
            notice
              ? styles.noticeActionText
              : compact
                ? styles.barActionText
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
}: {
  session: Pick<
    SessionMeta,
    'sessionId' | 'status' | 'exitCode' | 'spawnFailure' | 'agentKind' | 'resumable' | 'neverBound'
  >
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

  if (parked && hasTranscript) {
    return (
      <View style={styles.notice} testID="hibernated-notice">
        <View style={styles.noticeHeading}>
          <Icon as={Moon} size={13} color={color.textDim} />
          <Text style={styles.noticeTitle}>Hibernated</Text>
        </View>
        <Text style={styles.noticeCopy}>
          {'Its process was stopped to free memory.\nThe conversation is intact.'}
        </Text>
        <LifecycleButton
          action={action}
          session={session}
          onResume={onResume}
          onRemove={onRemove}
          compact
          notice
        />
      </View>
    )
  }

  if (!hasTranscript) {
    return (
      <View style={styles.pane} testID="lifecycle-pane">
        <Icon as={parked ? Moon : RotateCcw} size={28} color={color.accentTint} />
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
      style={[styles.banner, styles.faultBanner]}
      testID="lifecycle-banner"
    >
      <View style={[styles.mark, styles.faultMark]}>
        <Icon as={RotateCcw} size={14} color={color.accentTint} />
      </View>
      <Text style={styles.bannerText}>{`${detail} Transcript is read-only.`}</Text>
      <LifecycleButton
        action={action}
        session={session}
        onResume={onResume}
        onRemove={onRemove}
        compact
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
  // Exited sessions retain their recovery bar above the transcript.
  banner: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.bar,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairlineBar,
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingVertical: space.xs + 1,
  },
  /** A fault line can carry the daemon's diagnosis and run to two lines; the
   *  mark and the control must not drift down the bar with it. */
  faultBanner: {
    alignItems: 'flex-start',
  },
  mark: {
    flexShrink: 0,
  },
  faultMark: {
    paddingTop: 2,
  },
  bannerText: {
    ...mono(400),
    flex: 1,
    color: color.textDim,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
  },
  /** The bar's control is chrome inside chrome: an outline cell, not the
   *  filled-accent primary the pane below uses. */
  barAction: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs - 1,
  },
  barActionPressed: {
    backgroundColor: color.surfacePressed,
  },
  barActionText: {
    ...mono(500),
    color: color.body,
    fontSize: font.micro,
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
