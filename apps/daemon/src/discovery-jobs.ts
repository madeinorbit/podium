import {
  type ConversationDiscoveryCache,
  scanAgentConversationsCached,
  summarizePaths,
} from '@podium/agent-bridge'
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
  /**
   * Targeted rescan: when set, re-summarize ONLY these transcript file paths (the
   * daemon's event-driven active refresh, fired off a LOADED session's transcript
   * tail). A paths-flush returns just those summaries as `changed` and NEVER prunes
   * (`removed` is always empty) — see `summarizePaths`. `full` is ignored in this mode.
   */
  paths?: string[]
  /**
   * When true, emit the FULL conversation list as `changed` (not just the cache
   * delta). The connect-time + on-demand paths set this so a full snapshot upserts
   * everything — that repopulates a cold server index (fresh/reset `podium.db`)
   * even when the daemon's warm `discovery.db` cache reports nothing as "changed".
   * The periodic loop leaves it unset and forwards only the delta.
   */
  full?: boolean
}

/**
 * Worker-side conversation discovery: runs one incremental scan against a
 * caller-owned cache, and maps either the full list or the cache delta to wire
 * types. With `full` unset it returns just what moved (`changed`/`removed`) so
 * callers forward a delta, not the full list; with `full: true` it returns the
 * entire current conversation list as `changed` so a snapshot upserts everything.
 *
 * The `cache` is injected (not opened per call) so the long-lived worker can hold
 * ONE cache across the every-15s `indexRefresh` ticks — opening a fresh
 * `ConversationDiscoveryCache(cachePath)` here each pass would leak a SQLite
 * connection (and re-run migrate()) on every tick of a long-running daemon.
 */
export async function runIndexRefreshJob(
  input: IndexRefreshJobInput,
  cache: ConversationDiscoveryCache,
): Promise<{
  changed: ConversationSummaryWire[]
  removed: string[]
  diagnostics: ConversationDiagnosticWire[]
}> {
  // Paths-mode: a targeted refresh of just the dirty files (no prune). We run the
  // SAME full provider listing filtered to those paths rather than a bare per-file
  // summarize, so per-provider listing state (e.g. codex's sibling-derived
  // title/parent metadata) is preserved instead of summarized out of context.
  const result =
    input.paths && input.paths.length > 0
      ? await summarizePaths(input.paths, {
          cache,
          ...(input.homeDir ? { homeDir: input.homeDir } : {}),
        })
      : await scanAgentConversationsCached({
          cache,
          ...(input.homeDir ? { homeDir: input.homeDir } : {}),
        })
  // Paths-mode is always a delta of the dirty files (`full` is ignored); otherwise
  // `full` snapshot → the entire current list (repopulates a cold server index even
  // off a warm cache), and unset → just the cache-miss delta.
  const inPathsMode = Boolean(input.paths && input.paths.length > 0)
  return {
    changed: (!inPathsMode && input.full ? result.conversations : result.changed).map(
      summaryToWire,
    ),
    removed: result.removed,
    diagnostics: result.diagnostics.map(diagnosticToWire),
  }
}
