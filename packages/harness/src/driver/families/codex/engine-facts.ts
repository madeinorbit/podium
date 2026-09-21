// packages/harness/src/driver/families/codex/engine-facts.ts
//
// THE CODEX ENGINE'S FACTS (1.5, spec §5; handed sections per POD-4494).
//
// Everything the codex engine host reads that varies per harness, read off
// the ADAPTER SECTIONS IT IS HANDED — never restated here, and never fetched
// from the registry by harness name. The composition root reads the registry
// once and hands this family its sections; the engine host receives these
// facts and never names the harness itself. (Inside this directory a harness
// name is legal — the vendor boundary lint only gates code OUTSIDE
// packages/harness — but the mechanism still reads rather than hardcodes, so
// a second speaker of this protocol reuses the host with different facts.)
//
// The parameter is a Pick, not the whole Adapter (spec §4.1, ADR 10
// Decision A): the read restriction is the type. A full manifest is
// assignable, but callers hand exactly these keys.

import type { HarnessAgent } from '@podium/model'
import { declaredValue, type AgentManifest } from '../../../manifest.js'

/**
 * The harness kind these facts are read for, as a VALUE for the composition
 * root (same shape as `claudeSdkHarnessKind`): the daemon hands
 * `codexEngineFacts` the sections of THIS adapter without writing the name
 * itself — identifiers may flow as values, literals may not (vendor lint).
 */
export const codexHarnessKind = 'codex' as const

/** The codex engine's per-harness facts, read off its adapter sections. */
export interface CodexEngineFacts {
  /** Value passed as the engine child's harness identity (env composition). */
  harnessKind: HarnessAgent
  /** `runtime.server.spawn` stem: the command that starts the engine. */
  command: string
  serverArgs: string[]
  /** Bare executable name, resolved to a path by the supervisor's inventory. */
  executableName: string
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

/** Read the codex engine facts off the HANDED adapter sections. Throws honestly
 *  when the sections stop declaring what the engine host needs. */
export function codexEngineFacts(
  sections: Pick<AgentManifest, 'kind' | 'runtime' | 'inventory'>,
): CodexEngineFacts {
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
    journalNamespace: 'codex-app-servers',
    attachKind: 'codex',
  }
}
