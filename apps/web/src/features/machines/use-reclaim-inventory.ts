import type { IssueId, MachineId } from '@podium/model/browser'
import { useEffect, useState } from 'react'

export interface ReclaimInventory {
  candidates: Array<{
    issueId: IssueId
    title: string
    worktreePath: string
    closedAt: string
    machineId: MachineId
    present: boolean
    protectedReason: string | null
  }>
  orphans: Array<{
    path: string
    branch: string | null
    headSha: string | null
    machineId: MachineId
    repoPath: string
  }>
  diagnostics: Array<{ repoPath: string; machineId: MachineId; reason: string }>
  estimate:
    | { status: 'unknown'; recoverableBytes: null; measuredAt: null; error?: string }
    | { status: 'measuring'; recoverableBytes: null; measuredAt: null }
    | { status: 'ready'; recoverableBytes: number; measuredAt: string }
}

const REFRESH_MS = 5_000

export function useReclaimInventory(
  trpc: {
    hosts: {
      reclaimInventory: {
        mutate(input?: { machineId?: MachineId }): Promise<ReclaimInventory>
      }
    }
  },
  machineId?: MachineId,
): { inventory: ReclaimInventory | null; error: string | null } {
  const [inventory, setInventory] = useState<ReclaimInventory | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await trpc.hosts.reclaimInventory.mutate(machineId ? { machineId } : undefined)
        if (!alive) return
        setInventory(next)
        setError(null)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [trpc, machineId])

  return { inventory, error }
}
