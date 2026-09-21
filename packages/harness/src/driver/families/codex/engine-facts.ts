// packages/harness/src/driver/families/codex/engine-facts.ts
//
// THE CODEX ENGINE'S FACTS (1.5, spec §5).
//
// Everything the codex engine host reads that varies per harness, read off the
// codex adapter's sections — never restated here. The engine host receives
// these facts; it never names the harness itself. (Inside this directory a
// harness name is legal — the vendor boundary lint only gates code OUTSIDE
// packages/harness — but the mechanism still reads rather than hardcodes, so
// a second speaker of this protocol reuses the host with different facts.)

import type { AgentKind } from '@podium/model'
import { declaredValue } from '../../../manifest.js'
import { manifestFor } from '../../../registry.js'

/** The codex engine's per-harness facts, read off its adapter sections. */
export interface CodexEngineFacts {
  /** Value passed as the engine child's harness identity (env composition). */
  harnessKind: AgentKind
  /** `runtime.server.spawn` stem: the command that starts the engine. */
  command: string
  serverArgs: string[]
  /** Env vars that override the stored login and must not reach the child. */
  stripEnv: readonly string[]
  /** `podium-<token>-<sessionId>`: the scope label, from the client-terminal
   *  section's label token (same token the attach path uses). */
  scopeToken: string
  /** The binding-journal namespace: durable metadata, keyed per family. */
  journalNamespace: string
  /** The attach-target kind for the stock client terminal. */
  attachKind: string
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`codex adapter does not declare ${what}`)
  return value
}

/** Read the codex engine facts off the codex adapter. Throws honestly when the
 *  adapter stops declaring what the engine host needs. */
export function codexEngineFacts(): CodexEngineFacts {
  const manifest = manifestFor('codex')
  if (!manifest) throw new Error("no harness adapter for 'codex'")
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
    journalNamespace: 'codex-app-servers',
    attachKind: 'codex',
  }
}
