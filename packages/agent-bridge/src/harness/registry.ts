import type { AgentKind, HarnessAgent } from '@podium/protocol'
import type { AgentStateProvider } from '../agent-state/types.js'
import type { HarnessAdapter } from './adapter.js'
import { claudeCodeAdapter } from './adapters/claude-code.js'
import { codexAdapter } from './adapters/codex.js'
import { cursorAdapter } from './adapters/cursor.js'
import { grokAdapter } from './adapters/grok.js'
import { opencodeAdapter } from './adapters/opencode.js'

/**
 * THE harness registry (#158): one adapter per driveable agent kind. The
 * exhaustive Record makes "new harness = one adapter file + one entry here"
 * a type-checked contract — a missing kind fails compilation, and the
 * registry test asserts every adapter declares every capability field.
 */
export const HARNESS_ADAPTERS: Record<HarnessAgent, HarnessAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
}

/** Adapter lookup over the wire kind; 'shell' (and unknown strings from old
 *  wires) have no harness — callers branch on undefined. */
export function harnessAdapterFor(kind: AgentKind | string): HarnessAdapter | undefined {
  return (HARNESS_ADAPTERS as Record<string, HarnessAdapter>)[kind]
}

/** The provider registry. Uninstrumented kinds return undefined → phase stays 'unknown'. */
export function agentStateProviderFor(kind: AgentKind): AgentStateProvider | undefined {
  return harnessAdapterFor(kind)?.state
}

/** Resolve a resume.kind ('grok-session', 'codex-thread', …) to its harness. */
export function harnessKindForResumeKind(resumeKind: string): HarnessAgent | undefined {
  for (const adapter of Object.values(HARNESS_ADAPTERS)) {
    if (adapter.resumeKind === resumeKind) return adapter.kind
  }
  return undefined
}
