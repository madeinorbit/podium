import { ONBOARDING_VPS_KEY, requireReplicatedLayoutKey } from '@podium/client-core/ui-state'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  /** True after an authoritative layout.get or a confirmed write has settled. */
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
    throw new Error('The server did not confirm VPS activation progress. Transfer was not started.')
  }
  return confirmed
}

export async function readVpsActivation(
  trpc: Pick<Trpc, 'layout'>,
): Promise<VpsActivationState | null> {
  const snapshot = await trpc.layout.get.query()
  return parseVpsActivationValue(snapshot[VPS_LAYOUT_KEY])
}

export async function clearVpsActivation(trpc: Pick<Trpc, 'layout'>): Promise<void> {
  const snapshot = await trpc.layout.clear.mutate({ keys: [VPS_LAYOUT_KEY] })
  if (snapshot[VPS_LAYOUT_KEY] !== undefined) {
    throw new Error('The server did not confirm that VPS activation was complete.')
  }
}

/** The hard transfer fence: the mutation cannot run until the durable route write resolves. */
export async function startAfterVpsPersistence(
  persist: () => Promise<unknown>,
  startTransfer: () => Promise<void>,
): Promise<void> {
  await persist()
  await startTransfer()
}

/**
 * A server-confirmed state controller layered over the replicated UI-state read path.
 * Direct commands are serialized so a slower earlier route can never overwrite a later route.
 */
export function useConfirmedVpsActivation(trpc: Trpc): ConfirmedVpsActivation {
  const replicatedRaw = usePersistedUiValue(ONBOARDING_VPS_KEY, rawValue)
  const replicated = useMemo(() => parseVpsActivation(replicatedRaw), [replicatedRaw])
  const [authoritative, setAuthoritative] = useState<{
    value: VpsActivationState | null
    baselineRaw: string | null
  } | null>(null)
  const [override, setOverride] = useState<{ value: VpsActivationState | null } | null>(null)
  const [readyTransport, setReadyTransport] = useState<Trpc | null>(null)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const commandGeneration = useRef(0)
  const replicatedRawRef = useRef(replicatedRaw)
  replicatedRawRef.current = replicatedRaw

  // A replicated UI-state row may arrive after the activation URL. Read the server once before
  // deciding that an absent row means "start over", or a reload could overwrite transfer state.
  useEffect(() => {
    const generation = ++commandGeneration.current
    let cancelled = false
    setAuthoritative(null)
    setOverride(null)
    setReadyTransport(null)
    setError(null)
    void readVpsActivation(trpc).then(
      (value) => {
        if (cancelled || generation !== commandGeneration.current) return
        setAuthoritative({
          value,
          baselineRaw: replicatedRawRef.current,
        })
        setReadyTransport(trpc)
      },
      () => {
        if (cancelled || generation !== commandGeneration.current) return
        setError('Could not restore VPS activation progress. Reload to try again.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [trpc])

  useEffect(() => {
    if (!override) return
    const matches = override.value
      ? replicatedRaw === serializeVpsActivation(override.value)
      : replicatedRaw === null
    if (matches) setOverride(null)
  }, [override, replicatedRaw])

  useEffect(() => {
    if (!authoritative) return
    const matches = authoritative.value
      ? replicatedRaw === serializeVpsActivation(authoritative.value)
      : replicatedRaw === null
    if (matches || replicatedRaw !== authoritative.baselineRaw) setAuthoritative(null)
  }, [authoritative, replicatedRaw])

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
        commandGeneration.current += 1
        setPending((count) => count + 1)
        setError(null)
        try {
          const confirmed = await persistVpsActivation(trpc, next)
          setOverride({ value: confirmed })
          setAuthoritative(null)
          setReadyTransport(trpc)
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
        commandGeneration.current += 1
        setPending((count) => count + 1)
        setError(null)
        try {
          await clearVpsActivation(trpc)
          setOverride({ value: null })
          setAuthoritative(null)
          setReadyTransport(trpc)
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
    state:
      readyTransport === trpc
        ? override
          ? override.value
          : authoritative
            ? authoritative.value
            : replicated
        : null,
    ready: readyTransport === trpc,
    saving: pending > 0,
    error,
    persist,
    clear,
  }
}
