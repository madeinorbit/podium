import { useCommands } from '@podium/client-core/react'
/**
 * MOVING A SESSION TO ANOTHER MACHINE, FROM A MENU (POD-6422).
 *
 * A move is a `session.handoff` effect record: the write resolves once it is
 * durably queued, and the move answers on the record. The session's own pane
 * shows the move from the record (`SessionModel.handingOffTo`), then from the
 * server's overlay, on every device; only the device that asked says how it
 * ended, once: which session landed where, or the target it never reached
 * (the server leaves the session where it was).
 */

import { useClientRuntime } from '@podium/client-core/react'
import { awaitEffect, effectShortfall } from '@podium/client-graph/write/await-effect'
import type { MachineId, SessionId } from '@podium/model/browser'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'

/** How long the device that asked follows the record: its 2-minute start
 *  deadline, then a move that may clone the repository on its target. A record
 *  that never reaches this device (its create refused) stops being waited for. */
const FOLLOW_MS = 15 * 60 * 1000

export interface HandoffNames {
  /** The session as the person knows it. */
  readonly session: string
  /** The machine it goes to. */
  readonly machine: string
}

export function useSessionHandoff(): (
  sessionId: SessionId,
  machineId: MachineId,
  names: HandoffNames,
) => void {
  // The action owner, as the menus' other actions; never a store subscription.
  const owner = useClientRuntime<Trpc>()
  const commandModules = useCommands<Trpc>()

  const pool = useWorklistPool()
  return useCallback(
    (sessionId, machineId, names) => {
      const failed = (why: string) => toast.error(`Handover to ${names.machine} failed — ${why}`)
      void commandModules.sessions.handoff(sessionId, machineId).then(
        async (effectId) => {
          if (!pool) return
          const effect = await awaitEffect(pool, effectId, {
            signal: AbortSignal.timeout(FOLLOW_MS),
          }).catch(() => undefined)
          if (effect === undefined) return
          if (effect.status === 'succeeded') {
            toast.success(`${names.session} resumed on ${names.machine}`)
            return
          }
          const why = effectShortfall(effect)
          if (why !== undefined) failed(why)
        },
        (error: unknown) => failed(error instanceof Error ? error.message : String(error)),
      )
    },
    [owner, pool],
  )
}
