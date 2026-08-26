import { CheckCircle2, LoaderCircle, RotateCcw } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ShellRestart } from './restart-shell'

/**
 * The last step of every activation that changes what this computer IS: the
 * config is written, and all that remains is for the shell to come back as the
 * thing it now says it is.
 *
 * `idle` — the step is still being filled in.
 * `restarting` — the choice is DURABLE and the restart has been asked for.
 * `restart-required` — durable too, but the shell will not go on its own.
 *
 * Nothing here is a failure state. Once a step reaches `restarting` the user's
 * connection is saved, so the two later phases differ only in who presses the
 * button — which is why neither may be drawn as an error (POD-1292).
 */
export type HandoffPhase = 'idle' | 'restarting' | 'restart-required'

export interface ActivationHandoffState {
  phase: HandoffPhase
  /** True once the choice is durable: the step's own form is finished with. */
  handedOff: boolean
  /**
   * Enter the handoff and ask the shell to restart. `prepare` runs after the
   * phase flips, so bookkeeping that may fail cannot delay the panel or the
   * restart behind it.
   */
  begin: (prepare?: () => Promise<void>) => Promise<void>
}

/**
 * A shell that accepts the request and then simply does not go leaves a spinner
 * that never resolves, which is the same silence as no feedback at all. Give it
 * this long, then hand the user the button.
 */
const RESTART_GRACE_MS = 6_000

export function useActivationHandoff(
  onConfigured: () => Promise<ShellRestart>,
): ActivationHandoffState {
  const [phase, setPhase] = useState<HandoffPhase>('idle')

  useEffect(() => {
    if (phase !== 'restarting') return
    const timer = setTimeout(() => setPhase('restart-required'), RESTART_GRACE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  const begin = useCallback(
    async (prepare?: () => Promise<void>): Promise<void> => {
      setPhase('restarting')
      if (prepare) await prepare()
      if ((await onConfigured()) === 'unavailable') setPhase('restart-required')
    },
    [onConfigured],
  )

  return { phase, handedOff: phase !== 'idle', begin }
}

/**
 * The panel that replaces a finished activation step. It reports a SUCCESS —
 * the connection exists — and the restart is stated as what happens next, not
 * as a fault the user has to work around.
 */
export function ActivationHandoffPanel({
  phase,
  title,
  restartingDetail,
  restartDetail,
  onRestart,
}: {
  phase: Exclude<HandoffPhase, 'idle'>
  title: string
  restartingDetail: string
  restartDetail: string
  onRestart: () => void
}): JSX.Element {
  const waiting = phase === 'restarting'
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-[11px] bg-[#17251d] px-4 py-3.5 shadow-[inset_0_0_0_1px_#2c5340]"
    >
      <div className="flex items-start gap-2.5">
        <CheckCircle2 size={17} className="mt-px flex-none text-[#6fbc8c]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block text-[12.5px] leading-[1.4] font-semibold text-[#cfead9]">
            {title}
          </strong>
          <p className="mt-1 flex items-center gap-1.5 text-[12.5px] leading-[1.5] text-[#93b7a3]">
            {waiting && (
              <LoaderCircle
                size={13}
                className="flex-none animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {waiting ? restartingDetail : restartDetail}
          </p>
        </div>
      </div>
      {!waiting && (
        <Button
          type="button"
          // Amber is what "press this" looks like everywhere in the wizard;
          // green is what "it worked" looks like. This panel is both, so the
          // colours stay in their own jobs rather than swapping.
          className="mt-3 h-[34px] rounded-[9px] border-0 bg-[#d9b477] px-3.5 text-[12.5px] font-semibold text-[#191308] hover:bg-[#e8ca97]"
          onClick={onRestart}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Restart Podium
        </Button>
      )}
    </div>
  )
}
