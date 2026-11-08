import { shallowEqual } from '@podium/client-core/shallow-equal'
import type { SessionModel } from '@podium/client-graph/models'
import { asSessionId } from '@podium/model/browser'
import { LoaderCircle } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useRuntimeSelector } from '@/app/store'

/**
 * A STOP, AS ITS RECORD SAYS (POD-6397). Pressing Stop writes a
 * `session.interrupt` effect naming the turn on screen; this reads the
 * session's latest one, the same on every device:
 *
 *  - on its way: "Interrupting…", until the agent has actually stopped;
 *  - failed, expired or lost track while that turn still runs: "Not stopped",
 *    with Kill (end the session, discarding unsaved work) and Dismiss.
 *
 * Renders nothing otherwise: a Stop that worked leaves no notice behind.
 */
export const InterruptNotice = observer(function InterruptNotice({
  session,
}: {
  session: SessionModel
}): JSX.Element | null {
  const { endSession, dismissEffect } = useRuntimeSelector(
    (s) => ({ endSession: s.endSession, dismissEffect: s.dismissEffect }),
    shallowEqual,
  )
  if (session.interrupting) {
    return (
      <div className="composer-notices">
        <div className="composer-notice" data-notice="interrupting" role="status">
          <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
          <strong>Interrupting…</strong>
          <span>waiting for the agent to stop</span>
        </div>
      </div>
    )
  }
  if (!session.interruptStuck) return null
  const stop = session.interrupt
  return (
    <div className="composer-notices">
      <div
        className="composer-notice composer-notice--error"
        data-notice="interrupt-stuck"
        role="alert"
      >
        <strong>Not stopped</strong>
        <span className="min-w-0 truncate">
          {stop?.error?.message ?? 'The agent is still working.'}
        </span>
        <button
          type="button"
          data-pressable
          className="ml-auto rounded-[4px] px-1.5 font-semibold text-destructive hover:bg-chip"
          title="End the session now, discarding unsaved work"
          onClick={() => void endSession(asSessionId(session.id), true)}
        >
          Kill
        </button>
        {stop && (
          <button
            type="button"
            data-pressable
            className="rounded-[4px] px-1.5 text-text-dim hover:bg-chip hover:text-text-strong"
            onClick={() => void dismissEffect(stop.id)}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
})
