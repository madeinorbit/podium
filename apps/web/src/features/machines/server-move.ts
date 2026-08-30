import type { MachineId } from '@podium/model'
import type { Operation } from '@podium/protocol'
import { parseOperation } from '@podium/protocol'
import { useCallback, useEffect, useState } from 'react'
import type { Store } from '@/app/store'
import { errorMessage, isMissingProcedure } from '@/features/updates/operations-client'

export const SERVER_MOVE_CONFIRMATION = 'TRANSFER SERVER'

const ACTIVE_POLL_MS = 1_000
const IDLE_POLL_MS = 10_000

export const SERVER_MOVE_ERROR_COPY: Readonly<Record<string, string>> = {
  'active-transfer': 'Another server move is already active.',
  'invalid-confirmation': 'Type the confirmation phrase exactly to move the server.',
  'invalid-url': 'Enter a valid public URL for the new server.',
  'target-not-found': 'The selected machine is no longer available.',
  'target-is-source': 'Choose a machine other than the current server.',
  'target-offline': 'Bring the selected machine online, then try again.',
  'target-unsupported': 'Update this machine to the same Podium version as the server first.',
  'source-unhealthy': 'The current server is not healthy enough to move.',
  'disk-full': 'Free space on the selected machine, then try again.',
  'snapshot-failed': 'Podium could not copy the server state.',
  'source-changed': 'Server state changed while it was being copied; try again.',
  'reauthorization-denied': 'Your permission to move the server was revoked.',
  'target-rejected': 'The selected machine rejected the server state.',
  'target-proof-missing': 'The selected machine could not prove the copied state.',
  'target-unreachable': 'The proposed target address is not reachable from every required machine.',
  'fleet-handoff-failed': 'At least one connected machine could not switch to the new server.',
  'source-config-failed': 'Podium could not safely retire the old server.',
  'commit-uncertain': 'The switch may have completed; check the new server.',
  'handoff-orphaned': 'The new server proof does not match this move.',
  'handoff-unsealed': 'The move stopped before its handoff was safely recorded.',
  'boot-recovery': 'Podium recovered an interrupted move during startup.',
  'recovery-refused': 'The move cannot be recovered from its current facts.',
  'legacy-transfer-in-progress':
    'Finish or clear the previous server transfer, then update this machine.',
  internal: 'The server move stopped because of an internal error.',
}

export function serverMoveErrorCopy(
  code: string | undefined,
  fallback?: string,
): string | undefined {
  if (!code) return fallback
  return SERVER_MOVE_ERROR_COPY[code] ?? fallback
}

export interface ServerMoveOperationsState {
  active: Operation | null
  history: Operation[]
  error: string | null
  refresh: () => void
}

/** Reads only the generic operations contract; the transfer journal is never public state. */
export function useServerMoveOperations(trpc: Store['trpc']): ServerMoveOperationsState {
  const [active, setActive] = useState<Operation | null>(null)
  const [history, setHistory] = useState<Operation[]>([])
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const read = async (): Promise<void> => {
      try {
        const raw = await trpc.operations.active.query({ group: 'lifecycle' })
        const operation = parseOperation(raw)
        const rows = await trpc.operations.history.query({ kind: 'server-move', limit: 20 })
        if (cancelled) return
        setActive(operation?.kind === 'server-move' ? operation : null)
        setHistory(
          rows.map((row) => parseOperation(row)).filter((row): row is Operation => row !== null),
        )
        setError(null)
        timer = window.setTimeout(read, operation ? ACTIVE_POLL_MS : IDLE_POLL_MS)
      } catch (cause) {
        if (cancelled) return
        setError(errorMessage(cause) ?? 'Server move status is unavailable.')
        timer = window.setTimeout(read, IDLE_POLL_MS)
      }
    }
    void read()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [nonce, trpc])

  return {
    active,
    history,
    error,
    refresh: useCallback(() => setNonce((value) => value + 1), []),
  }
}

export async function startServerMove(
  trpc: Store['trpc'],
  input: {
    targetMachineId: MachineId
    publicUrl: string
    bindHost: '127.0.0.1' | '0.0.0.0'
    port?: number
    confirmation: typeof SERVER_MOVE_CONFIRMATION
  },
): Promise<{ supported: boolean }> {
  try {
    await trpc.machines.moveServer.mutate(input)
    return { supported: true }
  } catch (cause) {
    if (isMissingProcedure(cause)) return { supported: false }
    throw cause
  }
}

export async function settleServerMoveRecovery(
  trpc: Store['trpc'],
  operationId: string,
): Promise<void> {
  await trpc.operations.settleAsk.mutate({
    id: operationId,
    actionId: 'server-move-recovery',
  })
}
