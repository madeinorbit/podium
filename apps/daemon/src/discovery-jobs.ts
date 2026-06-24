import {
  attributeMemory,
  type MemoryAttribution,
  type SessionProcessHint,
  snapshotProcesses,
} from './memory-breakdown'

export interface MemoryBreakdownJobInput {
  sessions: SessionProcessHint[]
  roots: string[]
  selfPid: number
  procRoot?: string
}

/** Pure: the /proc walk + attribution, runnable on a worker thread or inline. */
export function runMemoryBreakdownJob(input: MemoryBreakdownJobInput): MemoryAttribution {
  return attributeMemory(
    snapshotProcesses(input.procRoot ?? '/proc'),
    input.sessions,
    input.roots,
    { selfPid: input.selfPid },
  )
}
