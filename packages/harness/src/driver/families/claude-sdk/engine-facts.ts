// packages/harness/src/driver/families/claude-sdk/engine-facts.ts
//
// THE CLAUDE ENGINE'S FACTS (POD-4499; handed sections per POD-4494).
//
// Everything the claude engine host reads that varies per harness, read off
// the ADAPTER SECTIONS IT IS HANDED — never restated here, and never fetched
// from the registry by harness name. The composition root reads the registry
// once and hands this family its sections; the engine host receives these
// facts and never names the harness itself.
//
// TWO DELIBERATE DEVIATIONS FROM THE CODEX SHAPE. The claude-code adapter
// declares `runtime.server` UNSUPPORTED ("no server mode — the Agent SDK is
// in-process"), and changing that declaration would flip selection, the
// support matrix and daemon routing — a product decision owned elsewhere
// (POD-4497 moves whatever routing remains). So this family reads only
// `kind` + `inventory` (executable name, credential strip list) and owns the
// rest itself: the stream-json spawn stem lives in ./protocol.js next to the
// client that speaks it, and the scope token is a family constant. The token
// only namespaces durable labels across families on one machine
// (`podium-cl-…` beside `podium-cx-…`); nothing else reads it.

import type { HarnessAgent } from '@podium/model'
import { type AgentManifest } from '../../../manifest.js'

/** The claude engine's per-harness facts, read off its adapter sections. */
export interface ClaudeEngineFacts {
  /** Value passed as the engine child's harness identity (env composition). */
  harnessKind: HarnessAgent
  /** The engine command: the bare executable name (`claude`), resolved to a
   *  path by the supervisor's inventory. Per-turn stream-json args compose in
   *  ./protocol.js, which owns the wire the client speaks. */
  command: string
  /** Env vars that override the stored login and must not reach the child. */
  stripEnv: readonly string[]
  /** `podium-<token>-<sessionId>`: the durable label fragment. A family
   *  constant (see above) — the adapter declares no server section to read
   *  a client-terminal token from. */
  scopeToken: string
  /** The binding-journal namespace: durable metadata, keyed per family. */
  journalNamespace: string
  /** The attach-target kind for the stock client terminal. */
  attachKind: string
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`claude adapter does not declare ${what}`)
  return value
}

/** Read the claude engine facts off the HANDED adapter sections. Throws
 *  honestly when the sections stop declaring what the engine host needs. */
export function claudeEngineFacts(
  sections: Pick<AgentManifest, 'kind' | 'inventory'>,
): ClaudeEngineFacts {
  const command = required(
    sections.inventory.executable.names[0],
    'inventory.executable.names[0]',
  )
  return {
    harnessKind: sections.kind,
    command,
    stripEnv: sections.inventory.foreignCredentialEnv,
    scopeToken: 'cl',
    journalNamespace: 'claude-engines',
    attachKind: 'claude-code',
  }
}

/** The `podium-<token>-<sessionId>` durable label, so the supervisor's
 *  `spawnHeadless` adopt finds the same engine after a daemon restart.
 *  Derived from the Podium session id, never trusted from the journal. */
export const claudeEngineProcessKey = (facts: ClaudeEngineFacts, sessionId: string): string =>
  `podium-${facts.scopeToken}-${String(sessionId)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(-48)}`
