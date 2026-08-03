/**
 * THE READ-ONLY SURFACES (POD-408) — what a `parked` or `ended` panel shows.
 *
 * Four components, one rule: `panel-surface.ts` says WHICH of them renders,
 * `lifecycle-actions.ts` says what the button is called and what it runs, and
 * `useLifecycleRunner` owns the in-flight flag that used to be written out four
 * times. Nothing here decides anything; it renders a descriptor.
 *
 * Pane vs banner is the only real distinction: a pane is the whole surface (a
 * shell has no transcript to read), a banner sits over one (the conversation
 * outlives the process and is worth reading). Dead-end panels are forbidden —
 * every one of these says what happened and offers the way back.
 */

import { shallowEqual } from '@podium/client-core/store'
import { exitedRecovery } from '@podium/client-core/viewmodels'
import type { SessionId, SessionMeta } from '@podium/model'
import { Moon, RotateCcw } from 'lucide-react'
import { type JSX, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { type LifecycleAction, recoveryAction } from './lifecycle-actions'

/**
 * The one in-flight flag. Every recovery control disables itself and re-labels
 * while its action is in flight, and re-enables on rejection so a refused wake
 * stays retryable — which is the behaviour the four copies each implemented
 * separately and which only one of them had a test for.
 */
function useLifecycleRunner(): {
  busy: boolean
  run: (action: LifecycleAction, fn: () => Promise<void>) => void
} {
  const [busy, setBusy] = useState(false)
  return {
    busy,
    run: (action, fn) => {
      // An action with no busy label keeps no busy state: Remove takes the row
      // away, so there is nothing left to re-label.
      if (action.busyLabel === null) {
        void fn()
        return
      }
      setBusy(true)
      void fn().then(
        () => setBusy(false),
        () => setBusy(false),
      )
    },
  }
}

/** A recovery control rendered from its descriptor. `compact` picks the banner's
 *  shorter label; the busy label is shared. */
function LifecycleButton({
  action,
  sessionId,
  compact,
  className,
  variant,
}: {
  action: LifecycleAction
  sessionId: SessionId
  compact: boolean
  className?: string
  variant?: 'default' | 'secondary' | 'outline' | 'ghost'
}): JSX.Element {
  const { resurrectSession, killSession } = useStoreSelector(
    (s) => ({ resurrectSession: s.resurrectSession, killSession: s.killSession }),
    shallowEqual,
  )
  const { busy, run } = useLifecycleRunner()
  const label = compact ? action.compactLabel : action.label
  return (
    <Button
      type="button"
      {...(variant ? { variant } : {})}
      {...(compact ? { size: 'sm' as const } : {})}
      {...(className ? { className } : {})}
      disabled={busy}
      data-testid={`lifecycle-${action.id}`}
      onClick={() =>
        run(action, async () => {
          if (action.run === 'kill') return killSession(sessionId)
          return resurrectSession(sessionId)
        })
      }
    >
      {busy && action.busyLabel ? action.busyLabel : label}
    </Button>
  )
}

/**
 * What an exited session's surface needs.
 *
 * The four SESSION facts are PICKED from the model, never restated (POD-302's
 * ratchet: a hand-written `exitCode: number | undefined` is a ninth definition
 * of "a session" arriving while the epic is deleting eight). `Pick` names the
 * keys and inherits their types, so the model stays the single place that says
 * what `spawnFailure` is.
 *
 * The other three are NOT session fields and are deliberately hand-declared:
 * each is a DERIVATION the panel computes (`agentKind === 'shell'`, the cwd
 * matched against the scanned worktrees, that path prettified). Picking them
 * would be claiming the model publishes something it does not.
 */
type ExitedProps = Pick<SessionMeta, 'sessionId' | 'exitCode' | 'spawnFailure' | 'resumable'> & {
  isShell: boolean
  worktreeMissing: boolean
  worktreePath?: string
}

function exitedAction(p: ExitedProps): { detail: string; action: LifecycleAction } {
  const { detail, action } = exitedRecovery({
    exitCode: p.exitCode,
    ...(p.spawnFailure ? { spawnFailure: p.spawnFailure } : {}),
    isShell: p.isShell,
    resumable: p.resumable === true,
    worktreeMissing: p.worktreeMissing,
    ...(p.worktreePath ? { worktreePath: p.worktreePath } : {}),
  })
  return { detail, action: recoveryAction('ended', action, p.worktreeMissing) }
}

/**
 * The process is gone but the row survived (crash, external kill, or plain
 * exit). A shell restarts fresh in its directory (nothing to lose), an agent
 * resumes its conversation when it left a ref, and Remove covers the rest.
 */
export function ExitedPane(props: ExitedProps): JSX.Element {
  const { detail, action } = exitedAction(props)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-warning">
      <RotateCcw size={28} aria-hidden="true" />
      <p className="m-0 max-w-[42ch] text-[13px] text-muted-foreground">
        {detail} {action.hint}
      </p>
      <LifecycleButton
        action={action}
        sessionId={props.sessionId}
        compact={false}
        {...(action.id === 'remove' ? { variant: 'secondary' as const } : {})}
      />
    </div>
  )
}

/** Thin bar over an exited session's (read-only) transcript: says the process is
 *  gone but keeps the conversation readable, with resume/restart or remove. */
export function ExitedBanner(props: ExitedProps): JSX.Element {
  const { detail, action } = exitedAction(props)
  return (
    // items-start (not -center) so the action stays put when the notice wraps to
    // a second line — the worktree-missing message is longer than a bare exit line.
    <div className="flex shrink-0 items-start gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning">
      <RotateCcw size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{detail} Transcript is read-only.</span>
      <LifecycleButton
        action={action}
        sessionId={props.sessionId}
        compact
        variant={action.id === 'remove' ? 'ghost' : 'outline'}
        className={
          action.id === 'remove'
            ? 'shrink-0'
            : 'shrink-0 border-warning/50 text-warning hover:bg-warning/10 hover:text-warning'
        }
      />
    </div>
  )
}

/** Thin bar over a hibernated session's (read-only) transcript: explains the
 *  state and offers one-click resume, without hiding the conversation. */
export function HibernatedBanner({ sessionId }: { sessionId: SessionId }): JSX.Element {
  const action = recoveryAction('parked', 'resume')
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary">
      <Moon size={14} aria-hidden="true" />
      <span className="min-w-0 flex-1">Hibernated — transcript is read-only until you resume.</span>
      <LifecycleButton
        action={action}
        sessionId={sessionId}
        compact
        variant="outline"
        className="shrink-0 border-primary/50 text-primary hover:bg-primary/10 hover:text-primary"
      />
    </div>
  )
}

/** Firefox-snoozed-tab moment: the process is parked, one click wakes it. */
export function HibernatedPane({ sessionId }: { sessionId: SessionId }): JSX.Element {
  const action = recoveryAction('parked', 'resume')
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-primary">
      <Moon size={28} aria-hidden="true" />
      <p className="m-0 max-w-[42ch] text-[13px] text-muted-foreground">{action.hint}</p>
      <LifecycleButton action={action} sessionId={sessionId} compact={false} />
    </div>
  )
}
