import type { MachineWire } from '@podium/model'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Store } from '@/app/store'

export const SERVER_TRANSFER_CONFIRMATION = 'TRANSFER SERVER'

export type ServerTransferStatusSnapshot = Awaited<
  ReturnType<Store['trpc']['machines']['serverTransferStatus']['query']>
>
export type ServerTransfer = ServerTransferStatusSnapshot['transfer']
export type ServerTransferDisplayState =
  | 'preparing'
  | 'copying'
  | 'validating'
  | 'switching'
  | 'connected'
  | 'aborted'
  | 'commit-uncertain'

export interface ServerTransferStatusController {
  snapshot: ServerTransferStatusSnapshot | null
  error: string | null
  refresh: () => Promise<ServerTransferStatusSnapshot | null>
}

export interface ServerTransferController {
  publicUrl: string
  setPublicUrl: (value: string) => void
  confirmation: string
  setConfirmation: (value: string) => void
  awaitingStatus: boolean
  checkingTarget: boolean
  error: string | null
  transfer: ServerTransfer
  displayState: ServerTransferDisplayState | null
  showProgress: boolean
  urlIsValid: boolean
  canStart: boolean
  start: () => Promise<void>
  checkTarget: () => Promise<void>
}

const SERVER_TRANSFER_POLL_MIN_MS = 1_000
const SERVER_TRANSFER_POLL_MAX_MS = 5_000

export function transferDisplayState(transfer: ServerTransfer): ServerTransferDisplayState | null {
  if (!transfer) return null
  if (transfer.state === 'commit-uncertain' || transfer.phase === 'commit-uncertain') {
    return 'commit-uncertain'
  }
  if (transfer.state === 'aborted' || transfer.phase === 'aborted') return 'aborted'
  if (transfer.state === 'committed' || transfer.phase === 'connected') {
    return transfer.targetProof && transfer.sourceConnected ? 'connected' : 'switching'
  }
  return transfer.phase
}

export function transferErrorMessage(transfer: ServerTransfer): string | undefined {
  return transfer && 'error' in transfer ? transfer.error?.message : undefined
}

/**
 * True only when a target has a new journal entry or the existing entry has
 * durably moved. A freshly allocated transfer id is the strongest signal; the
 * remaining fields cover recovery transitions within one journal entry.
 */
export function isNewOrAdvancedTransfer(
  previous: ServerTransfer,
  latest: ServerTransfer,
  targetMachineId: MachineWire['id'],
): boolean {
  if (!latest || latest.targetMachineId !== targetMachineId) return false
  if (!previous || previous.targetMachineId !== targetMachineId) return true
  return (
    latest.transferId !== previous.transferId ||
    latest.state !== previous.state ||
    latest.phase !== previous.phase ||
    latest.sourceFenced !== previous.sourceFenced ||
    latest.targetProof !== previous.targetProof ||
    latest.sourceConnected !== previous.sourceConnected
  )
}

export function isValidServerTransferUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== ''
  } catch {
    return false
  }
}

function serverTransferPollDelay(
  snapshot: ServerTransferStatusSnapshot | null,
  failures: number,
): number {
  if (failures > 0) {
    return Math.min(
      SERVER_TRANSFER_POLL_MAX_MS,
      SERVER_TRANSFER_POLL_MIN_MS * 2 ** Math.min(failures, 3),
    )
  }
  if (!snapshot?.transfer) return SERVER_TRANSFER_POLL_MAX_MS
  const state = transferDisplayState(snapshot.transfer)
  return state === 'connected' || state === 'aborted'
    ? SERVER_TRANSFER_POLL_MAX_MS
    : SERVER_TRANSFER_POLL_MIN_MS
}

/** Polls the server-owned transfer journal; mutation acknowledgements never become UI truth. */
export function useServerTransferStatus(trpc: Store['trpc']): ServerTransferStatusController {
  const [snapshot, setSnapshot] = useState<ServerTransferStatusSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reads = useRef({
    trpc,
    generation: 0,
    sequence: 0,
    mounted: true,
  })

  // Invalidate the previous transport during render, before either tree can
  // start effects. Its in-flight reads may finish, but cannot publish here.
  if (reads.current.trpc !== trpc) {
    reads.current.trpc = trpc
    reads.current.generation += 1
    reads.current.mounted = true
  }

  const refresh = useCallback(async (): Promise<ServerTransferStatusSnapshot | null> => {
    const generation = reads.current.generation
    if (!reads.current.mounted) return null
    const sequence = ++reads.current.sequence
    try {
      const next = await trpc.machines.serverTransferStatus.query()
      if (
        !reads.current.mounted ||
        reads.current.generation !== generation ||
        reads.current.sequence !== sequence
      ) {
        return null
      }
      setSnapshot(next)
      setError(null)
      return next
    } catch (cause) {
      if (
        !reads.current.mounted ||
        reads.current.generation !== generation ||
        reads.current.sequence !== sequence
      ) {
        return null
      }
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [trpc])

  useEffect(() => {
    const generation = reads.current.generation
    reads.current.mounted = true
    setSnapshot(null)
    setError(null)
    return () => {
      if (reads.current.generation === generation) {
        reads.current.mounted = false
        reads.current.generation += 1
      }
    }
  }, [trpc])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (failures: number): Promise<void> => {
      const next = await refresh()
      if (cancelled) return
      const nextFailures = next ? 0 : failures + 1
      timer = setTimeout(() => void poll(nextFailures), serverTransferPollDelay(next, nextFailures))
    }
    void poll(0)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  return { snapshot, error, refresh }
}

/**
 * Controls one transfer target while deriving every durable phase from status.
 * A lost mutation reply is reconciled through status before it is shown as an error.
 */
export function useServerTransfer({
  trpc,
  targetMachineId,
  status,
  active = true,
}: {
  trpc: Store['trpc']
  targetMachineId: MachineWire['id']
  status: ServerTransferStatusController
  active?: boolean
}): ServerTransferController {
  const [publicUrl, setPublicUrl] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [awaitingStatus, setAwaitingStatus] = useState(false)
  const [checkingTarget, setCheckingTarget] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targetLifecycle = useRef({ targetMachineId, active, generation: 0, mounted: active })
  const pendingStart = useRef<{ baseline: ServerTransfer } | undefined>(undefined)
  const errorContext = useRef<{ kind: 'start' | 'check'; baseline: ServerTransfer } | undefined>(
    undefined,
  )

  // Invalidate callbacks from the old target or a closed surface during render.
  // They may finish, but cannot refresh or publish into a later reopen.
  if (targetLifecycle.current.targetMachineId !== targetMachineId) {
    targetLifecycle.current.targetMachineId = targetMachineId
    targetLifecycle.current.generation += 1
    targetLifecycle.current.mounted = active
  }
  if (targetLifecycle.current.active !== active) {
    targetLifecycle.current.active = active
    if (!active) targetLifecycle.current.generation += 1
    targetLifecycle.current.mounted = active
  }

  const durableTransfer =
    status.snapshot?.transfer?.targetMachineId === targetMachineId ? status.snapshot.transfer : null
  const pendingStartHasAdvanced = pendingStart.current
    ? isNewOrAdvancedTransfer(pendingStart.current.baseline, durableTransfer, targetMachineId)
    : true
  // During an aborted retry, the previous journal entry is a baseline rather
  // than the current attempt. Mask it until a new id or durable field proves
  // progress so presentation cannot show "aborted" beneath an active retry.
  const transfer = pendingStartHasAdvanced ? durableTransfer : null
  const displayState = transferDisplayState(transfer)
  const effectiveAwaitingStatus = active && awaitingStatus && !pendingStartHasAdvanced
  const showProgress =
    (displayState !== null && displayState !== 'aborted') || effectiveAwaitingStatus
  const urlIsValid = isValidServerTransferUrl(publicUrl)

  const resetTransientState = useCallback((): void => {
    setPublicUrl('')
    setConfirmation('')
    setAwaitingStatus(false)
    setError(null)
    setCheckingTarget(false)
    pendingStart.current = undefined
    errorContext.current = undefined
  }, [])

  useEffect(() => {
    const generation = targetLifecycle.current.generation
    targetLifecycle.current.mounted = active
    resetTransientState()
    return () => {
      if (targetLifecycle.current.generation === generation) {
        targetLifecycle.current.mounted = false
        targetLifecycle.current.generation += 1
      }
    }
  }, [active, resetTransientState, targetMachineId])

  useEffect(() => {
    if (!active || pendingStart.current || durableTransfer?.state !== 'aborted') return
    resetTransientState()
  }, [active, durableTransfer?.state, resetTransientState])

  // Only a genuinely new or advanced journal entry replaces a retry's baseline
  // and clears its optimistic waiting marker. It also clears mutation-reply
  // errors when durable state proves progress or resolution.
  useEffect(() => {
    if (pendingStart.current && pendingStartHasAdvanced) {
      if (durableTransfer?.state === 'aborted') {
        resetTransientState()
      } else {
        pendingStart.current = undefined
        setAwaitingStatus(false)
      }
    }
    const context = errorContext.current
    if (!context || !isNewOrAdvancedTransfer(context.baseline, durableTransfer, targetMachineId)) {
      return
    }
    if (context.kind === 'check' && transferDisplayState(durableTransfer) === 'commit-uncertain') {
      return
    }
    errorContext.current = undefined
    setError(null)
  }, [durableTransfer, pendingStartHasAdvanced, resetTransientState, targetMachineId])

  const start = useCallback(async (): Promise<void> => {
    const url = publicUrl.trim()
    if (!urlIsValid || confirmation !== SERVER_TRANSFER_CONFIRMATION) return
    const generation = targetLifecycle.current.generation
    const baseline = durableTransfer
    pendingStart.current = { baseline }
    setAwaitingStatus(true)
    setError(null)
    errorContext.current = undefined
    try {
      await trpc.machines.transferServer.mutate({
        targetMachineId,
        publicUrl: url,
        confirmation: SERVER_TRANSFER_CONFIRMATION,
      })
      if (!targetLifecycle.current.mounted || targetLifecycle.current.generation !== generation) {
        return
      }
      await status.refresh()
    } catch (cause) {
      if (!targetLifecycle.current.mounted || targetLifecycle.current.generation !== generation) {
        return
      }
      const latest = await status.refresh()
      if (!targetLifecycle.current.mounted || targetLifecycle.current.generation !== generation) {
        return
      }
      const latestTransfer =
        latest?.transfer?.targetMachineId === targetMachineId ? latest.transfer : null
      if (isNewOrAdvancedTransfer(baseline, latestTransfer, targetMachineId)) {
        errorContext.current = undefined
      } else {
        pendingStart.current = undefined
        setAwaitingStatus(false)
        setError(cause instanceof Error ? cause.message : String(cause))
        errorContext.current = { kind: 'start', baseline }
      }
    }
  }, [confirmation, durableTransfer, publicUrl, status, targetMachineId, trpc, urlIsValid])

  const checkTarget = useCallback(async (): Promise<void> => {
    if (!transfer || displayState !== 'commit-uncertain' || checkingTarget) return
    const generation = targetLifecycle.current.generation
    const baseline = transfer
    let failure: unknown
    setCheckingTarget(true)
    setError(null)
    errorContext.current = undefined
    try {
      await trpc.machines.transferServer.mutate({
        targetMachineId,
        publicUrl: transfer.publicUrl,
        confirmation: SERVER_TRANSFER_CONFIRMATION,
      })
    } catch (cause) {
      failure = cause
    }
    if (!targetLifecycle.current.mounted || targetLifecycle.current.generation !== generation) {
      return
    }
    const latest = await status.refresh()
    if (!targetLifecycle.current.mounted || targetLifecycle.current.generation !== generation) {
      return
    }
    const latestTransfer =
      latest?.transfer?.targetMachineId === targetMachineId ? latest.transfer : null
    const resolved =
      isNewOrAdvancedTransfer(baseline, latestTransfer, targetMachineId) &&
      transferDisplayState(latestTransfer) !== 'commit-uncertain'
    if (failure && !resolved) {
      setError(failure instanceof Error ? failure.message : String(failure))
      errorContext.current = { kind: 'check', baseline }
    } else {
      setError(null)
      errorContext.current = undefined
    }
    setCheckingTarget(false)
  }, [checkingTarget, displayState, status, targetMachineId, transfer, trpc])

  return {
    publicUrl,
    setPublicUrl,
    confirmation,
    setConfirmation,
    awaitingStatus: effectiveAwaitingStatus,
    checkingTarget: active && checkingTarget,
    error,
    transfer,
    displayState,
    showProgress,
    urlIsValid,
    canStart: urlIsValid && confirmation === SERVER_TRANSFER_CONFIRMATION,
    start,
    checkTarget,
  }
}
