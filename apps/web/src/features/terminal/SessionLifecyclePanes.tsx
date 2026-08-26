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
import type { SessionId, SessionMeta } from '@podium/model/browser'
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
  size,
}: {
  action: LifecycleAction
  sessionId: SessionId
  compact: boolean
  className?: string
  variant?: 'default' | 'secondary' | 'outline' | 'ghost'
  /** Overrides the size `compact` would pick. The state bar is chrome at the
   *  status strip's own height, so its control is an xs cell inside it rather
   *  than a 28px button filling the bar edge to edge. */
  size?: 'sm' | 'xs'
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
      {...(size ? { size } : compact ? { size: 'sm' as const } : {})}
      {...(className ? { className } : {})}
      disabled={busy}
      data-testid={`lifecycle-${action.id}`}
      onClick={() =>
        run(action, async () => {
          if (action.run === 'kill') return killSession(sessionId)
          await resurrectSession(sessionId)
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
 * The one remaining non-session field is deliberately hand-declared: `isShell`
 * is a DERIVATION the panel computes (`agentKind === 'shell'`). Picking it would
 * be claiming the model publishes something it does not.
 *
 * `worktreeMissing`/`worktreePath` are GONE (POD-1704). They carried a
 * client-side guess about whether a directory still existed, and a degraded repo
 * scan turned that guess into a false claim with a destructive button under it.
 * A missing worktree is rebuilt from the branch on resume, so it is not a fact
 * this surface needs.
 */
type ExitedProps = Pick<
  SessionMeta,
  'sessionId' | 'exitCode' | 'spawnFailure' | 'resumable' | 'neverBound'
> & {
  isShell: boolean
}

function exitedAction(p: ExitedProps): { detail: string; action: LifecycleAction } {
  const { detail, action } = exitedRecovery({
    exitCode: p.exitCode,
    ...(p.spawnFailure ? { spawnFailure: p.spawnFailure } : {}),
    isShell: p.isShell,
    resumable: p.resumable === true,
    neverBound: p.neverBound === true,
  })
  return { detail, action: recoveryAction('ended', action) }
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
 *  gone but keeps the conversation readable, with resume/restart or remove.
 *  Shares `.pane-state-bar` with the hibernated one — they are the same object
 *  reporting two versions of the same fact, and used to be two differently
 *  tinted slabs (POD-747). Only the tone differs, and it is carried by the glyph
 *  and the state's own word, never by a fill. */
export function ExitedBanner(props: ExitedProps & { waking?: boolean }): JSX.Element {
  const { detail, action } = exitedAction(props)
  // Same rule as the hibernated bar (POD-762): a wake already in flight is
  // reported, not offered again. It also stops being a FAULT while it runs —
  // the process is on its way back, which is the parked tone, not the warning
  // ink an exit earns.
  if (props.waking) return <WakingBar mark={<RotateCcw size={13} strokeWidth={1.7} />} />
  return (
    <div className="pane-state-bar" data-tone="fault">
      <span className="pane-state-bar-mark" aria-hidden="true">
        <RotateCcw size={13} strokeWidth={1.7} />
      </span>
      <span className="pane-state-bar-copy">{detail} Transcript is read-only.</span>
      <LifecycleButton
        action={action}
        sessionId={props.sessionId}
        compact
        size="xs"
        variant={action.id === 'remove' ? 'ghost' : 'outline'}
        className="shrink-0"
      />
    </div>
  )
}

/**
 * The state bar while a wake is in flight — the SAME object as the two below,
 * in the parked tone, with the state's own word in strong ink and the glyph
 * pulsing because this state is the one that ends by itself (POD-762).
 *
 * It is a live region: unlike "Hibernated" or "Exited", which are true when you
 * arrive, this one appears in answer to a key the operator just pressed.
 */
function WakingBar({ mark, queuedCount = 0 }: { mark: JSX.Element; queuedCount?: number }) {
  return (
    <div className="pane-state-bar pane-state-bar-waking" data-tone="parked" role="status">
      <span className="pane-state-bar-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="pane-state-bar-copy">
        <span className="pane-state-bar-word">Waking</span> the agent — your{' '}
        {queuedCount > 1 ? `${queuedCount} messages send` : 'message sends'} as soon as it&apos;s
        ready.
      </span>
    </div>
  )
}

/**
 * Thin bar over a hibernated session's (read-only) transcript: explains the
 * state and offers one-click resume, without hiding the conversation.
 *
 * ONCE A MESSAGE IS WAITING THE BAR STOPS OFFERING THE WAKE (POD-762) and
 * reports it instead. The offer would be a lie — the wake is already running,
 * the button would queue nothing, and the operator who just pressed Enter is
 * looking here for confirmation that something happened. `waking` is the
 * server's own queue depth, so the bar reads the same after a reload and after
 * a trip through three other issues.
 */
export function HibernatedBanner({
  sessionId,
  waking = false,
  queuedCount = 0,
}: {
  sessionId: SessionId
  waking?: boolean
  queuedCount?: number
}): JSX.Element {
  const action = recoveryAction('parked', 'resume')
  if (waking)
    return <WakingBar mark={<Moon size={13} strokeWidth={1.7} />} queuedCount={queuedCount} />
  return (
    <div className="pane-state-bar" data-tone="parked">
      <span className="pane-state-bar-mark" aria-hidden="true">
        <Moon size={13} strokeWidth={1.7} />
      </span>
      <span className="pane-state-bar-copy">
        <span className="pane-state-bar-word">Hibernated</span> — transcript is read-only until you
        resume.
      </span>
      <LifecycleButton
        action={action}
        sessionId={sessionId}
        compact
        size="xs"
        variant="outline"
        className="shrink-0"
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
