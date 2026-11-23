import type { IssueId, MachineId } from '@podium/model/browser'
import { useMachineProcesses } from './use-machine-processes'

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

/** Kept as a narrow consumer port; the answer now arrives with machine processes. */
export function useReclaimInventory(
  _trpc: unknown,
  machineId?: MachineId,
): { inventory: ReclaimInventory | null; error: string | null } {
  const reading = useMachineProcesses(machineId)
  return { inventory: reading.inventory, error: reading.reclaimError }
}
