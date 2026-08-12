import type { MachineWire } from '@podium/model'
import { useCallback, useEffect, useState } from 'react'
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

  const refresh = useCallback(async (): Promise<ServerTransferStatusSnapshot | null> => {
    try {
      const next = await trpc.machines.serverTransferStatus.query()
      setSnapshot(next)
      setError(null)
      return next
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
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
  const transfer =
    status.snapshot?.transfer?.targetMachineId === targetMachineId
      ? status.snapshot.transfer
      : null
  const transferState = transfer?.state
  const displayState = transferDisplayState(transfer)
  const showProgress = (displayState !== null && displayState !== 'aborted') || awaitingStatus
  const urlIsValid = isValidServerTransferUrl(publicUrl)

  useEffect(() => {
    if (!active || (transferState && transferState !== 'aborted')) return
    setPublicUrl('')
    setConfirmation('')
    setAwaitingStatus(false)
    setError(null)
    setCheckingTarget(false)
  }, [active, transferState])

  const start = useCallback(async (): Promise<void> => {
    const url = publicUrl.trim()
    if (!urlIsValid || confirmation !== SERVER_TRANSFER_CONFIRMATION) return
    setAwaitingStatus(true)
    setError(null)
    try {
      await trpc.machines.transferServer.mutate({
        targetMachineId,
        publicUrl: url,
        confirmation: SERVER_TRANSFER_CONFIRMATION,
      })
      await status.refresh()
    } catch (cause) {
      const latest = await status.refresh()
      const durable =
        latest?.transfer?.targetMachineId === targetMachineId ? latest.transfer : null
      if (!durable) {
        setAwaitingStatus(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }, [confirmation, publicUrl, status, targetMachineId, trpc, urlIsValid])

  const checkTarget = useCallback(async (): Promise<void> => {
    if (!transfer || displayState !== 'commit-uncertain' || checkingTarget) return
    setCheckingTarget(true)
    setError(null)
    try {
      await trpc.machines.transferServer.mutate({
        targetMachineId,
        publicUrl: transfer.publicUrl,
        confirmation: SERVER_TRANSFER_CONFIRMATION,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      await status.refresh()
      setCheckingTarget(false)
    }
  }, [checkingTarget, displayState, status, targetMachineId, transfer, trpc])

  return {
    publicUrl,
    setPublicUrl,
    confirmation,
    setConfirmation,
    awaitingStatus,
    checkingTarget,
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
