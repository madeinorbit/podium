import { ONBOARDING_VPS_KEY, requireReplicatedLayoutKey } from '@podium/client-core/ui-state'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { usePersistedUiValue } from '@/lib/use-persisted-ui-state'
import {
  parseVpsActivation,
  parseVpsActivationValue,
  serializeVpsActivation,
  type VpsActivationState,
} from './vps-activation'

const VPS_LAYOUT_KEY = requireReplicatedLayoutKey(ONBOARDING_VPS_KEY)
const rawValue = (raw: string | null): string | null => raw

export interface ConfirmedVpsActivation {
  state: VpsActivationState | null
  /** True once the signed-in pool has attached its synced records. */
  ready: boolean
  saving: boolean
  error: string | null
  /** Resolves only after layout.set returns a snapshot containing this exact versioned value. */
  persist: (next: VpsActivationState) => Promise<VpsActivationState>
  /** Resolves only after layout.clear returns a snapshot without the VPS key. */
  clear: () => Promise<void>
}

export async function persistVpsActivation(
  trpc: Pick<Trpc, 'layout'>,
  next: VpsActivationState,
): Promise<VpsActivationState> {
  const serialized = serializeVpsActivation(next)
  const snapshot = await trpc.layout.set.mutate({ values: { [VPS_LAYOUT_KEY]: serialized } })
  const confirmed = parseVpsActivationValue(snapshot[VPS_LAYOUT_KEY])
  if (!confirmed || serializeVpsActivation(confirmed) !== serialized) {
    throw new Error('The server did not confirm VPS setup progress.')
  }
  return confirmed
}

export async function clearVpsActivation(trpc: Pick<Trpc, 'layout'>): Promise<void> {
  const snapshot = await trpc.layout.clear.mutate({ keys: [VPS_LAYOUT_KEY] })
  if (snapshot[VPS_LAYOUT_KEY] !== undefined) {
    throw new Error('The server did not confirm that VPS activation was complete.')
  }
}

/**
 * A server-confirmed state controller layered over the replicated UI-state read path.
 * Direct commands are serialized so a slower earlier route can never overwrite a later route.
 */
export function useConfirmedVpsActivation(trpc: Trpc): ConfirmedVpsActivation {
  const replicatedRaw = usePersistedUiValue(ONBOARDING_VPS_KEY, rawValue)
  const replicated = useMemo(() => parseVpsActivation(replicatedRaw), [replicatedRaw])
  const ready = useWorklistPoolProjection((pool) => pool.layoutReady(VPS_LAYOUT_KEY), false)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const serializeCommand = useCallback(<T>(command: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(command, command)
    queue.current = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }, [])

  const persist = useCallback(
    (next: VpsActivationState): Promise<VpsActivationState> =>
      serializeCommand(async () => {
        setPending((count) => count + 1)
        setError(null)
        try {
          const confirmed = await persistVpsActivation(trpc, next)
          return confirmed
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message)
          throw cause
        } finally {
          setPending((count) => count - 1)
        }
      }),
    [serializeCommand, trpc],
  )

  const clear = useCallback(
    (): Promise<void> =>
      serializeCommand(async () => {
        setPending((count) => count + 1)
        setError(null)
        try {
          await clearVpsActivation(trpc)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message)
          throw cause
        } finally {
          setPending((count) => count - 1)
        }
      }),
    [serializeCommand, trpc],
  )

  return {
    state: ready ? replicated : null,
    ready,
    saving: pending > 0,
    error,
    persist,
    clear,
  }
}
