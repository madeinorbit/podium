// packages/harness/src/driver/families/grok-acp/engine-facts.ts
//
// THE GROK ENGINE'S FACTS (1.5, spec §5; handed sections per POD-4494). Same
// shape and same rule as ../codex/engine-facts.ts: read off the HANDED
// adapter sections, never restated, never fetched from the registry by name.
// A second ACP speaker reuses the engine host with different facts.

import type { HarnessAgent } from '@podium/model'
import { declaredValue, type AgentManifest } from '../../../manifest.js'

/**
 * The harness kind these facts are read for, as a VALUE for the composition
 * root (same shape as `claudeSdkHarnessKind`): the daemon hands
 * `grokEngineFacts` the sections of THIS adapter without writing the name
 * itself — identifiers may flow as values, literals may not (vendor lint).
 */
export const grokHarnessKind = 'grok' as const

/** The grok engine's per-harness facts, read off its adapter sections. */
export interface GrokEngineFacts {
  /** Value passed as the engine child's harness identity (env composition). */
  harnessKind: HarnessAgent
  /** `runtime.server.spawn` stem: the command that starts the engine. */
  command: string
  serverArgs: string[]
  /** Bare executable name, resolved to a path by the supervisor's inventory. */
  executableName: string
  /** Env vars that override the stored login and must not reach the child. */
  stripEnv: readonly string[]
  /** `podium-<token>-<sessionId>` (sanitized): the scope label, from the
   *  client-terminal section's label token. */
  scopeToken: string
  /** The binding-journal namespace: durable metadata, keyed per family. */
  journalNamespace: string
  /** The attach-target kind for the stock client terminal. */
  attachKind: string
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`grok adapter does not declare ${what}`)
  return value
}

/** Read the grok engine facts off the HANDED adapter sections. Throws honestly
 *  when the sections stop declaring what the engine host needs. */
export function grokEngineFacts(
  sections: Pick<AgentManifest, 'kind' | 'runtime' | 'inventory'>,
): GrokEngineFacts {
  const server = required(declaredValue(sections.runtime.server), 'runtime.server')
  const [command, ...serverArgs] = server.spawn
  const executableName =
    sections.inventory.executable.names[0] ?? required(command, 'runtime.server.spawn[0]')
  const clientTerminal = required(
    declaredValue(server.clientTerminal),
    'runtime.server.clientTerminal',
  )
  return {
    harnessKind: sections.kind,
    command: required(command, 'runtime.server.spawn[0]'),
    serverArgs,
    executableName,
    stripEnv: sections.inventory.foreignCredentialEnv,
    scopeToken: clientTerminal.labelToken,
    journalNamespace: 'grok-acp-servers',
    attachKind: 'grok',
  }
}
