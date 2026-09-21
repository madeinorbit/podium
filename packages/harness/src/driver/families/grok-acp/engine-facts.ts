// packages/harness/src/driver/families/grok-acp/engine-facts.ts
//
// THE GROK ENGINE'S FACTS (1.5, spec §5). Same shape and same rule as
// ../codex/engine-facts.ts: read off the grok adapter's sections, never
// restated. A second ACP speaker reuses the engine host with different facts.

import type { AgentKind } from '@podium/model'
import { declaredValue } from '../../../manifest.js'
import { manifestFor } from '../../../registry.js'

/** The grok engine's per-harness facts, read off its adapter sections. */
export interface GrokEngineFacts {
  /** Value passed as the engine child's harness identity (env composition). */
  harnessKind: AgentKind
  /** `runtime.server.spawn` stem: the command that starts the engine. */
  command: string
  serverArgs: string[]
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

/** Read the grok engine facts off the grok adapter. Throws honestly when the
 *  adapter stops declaring what the engine host needs. */
export function grokEngineFacts(): GrokEngineFacts {
  const manifest = manifestFor('grok')
  if (!manifest) throw new Error("no harness adapter for 'grok'")
  const server = required(declaredValue(manifest.runtime.server), 'runtime.server')
  const [command, ...serverArgs] = server.spawn
  const clientTerminal = required(
    declaredValue(server.clientTerminal),
    'runtime.server.clientTerminal',
  )
  return {
    harnessKind: manifest.kind,
    command: required(command, 'runtime.server.spawn[0]'),
    serverArgs,
    stripEnv: manifest.inventory.foreignCredentialEnv,
    scopeToken: clientTerminal.labelToken,
    journalNamespace: 'grok-acp-servers',
    attachKind: 'grok',
  }
}
