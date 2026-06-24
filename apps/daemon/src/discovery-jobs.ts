import { ConversationDiscoveryCache, scanAgentConversationsCached } from '@podium/agent-bridge'
import type { ConversationDiagnosticWire, ConversationSummaryWire } from '@podium/protocol'
import { diagnosticToWire, summaryToWire } from './conversation-wire.js'
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

export interface IndexRefreshJobInput {
  homeDir?: string
  cachePath?: string
  /** Declared for Task 11's targeted rescans; unused here — a full incremental pass runs. */
  paths?: string[]
}

/**
 * Worker-side conversation discovery: opens its OWN cache (the worker owns it,
 * keeping the daemon loop off the SQLite reads/writes), runs one incremental
 * scan, and maps the cache delta to wire types. Returns just what moved
 * (`changed`/`removed`) so callers forward a delta, not the full list.
 */
export async function runIndexRefreshJob(input: IndexRefreshJobInput): Promise<{
  changed: ConversationSummaryWire[]
  removed: string[]
  diagnostics: ConversationDiagnosticWire[]
}> {
  const cache = new ConversationDiscoveryCache(input.cachePath)
  const result = await scanAgentConversationsCached({
    cache,
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  })
  return {
    changed: result.changed.map(summaryToWire),
    removed: result.removed,
    diagnostics: result.diagnostics.map(diagnosticToWire),
  }
}
