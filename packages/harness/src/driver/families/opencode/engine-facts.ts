// packages/harness/src/driver/families/opencode/engine-facts.ts
//
// THE OPENCODE ENGINE'S FACTS (1.5, spec §5; handed sections per POD-4494).
// Same rule as ../codex/engine-facts.ts, with one extra row: this protocol
// has TWO speakers — the stable server and the 2 preview server — so the
// facts come in two flavors. The v1 flavor reads off the HANDED sections'
// server; the v2 flavor reads the handed sections' `serverAlternatives[0]`
// where a section exists (spawn stem, label token) and declares the preview's
// own deployment facts beside it. Either way the engine host takes facts,
// never names — and neither flavor fetches the registry by name.
//
// That is also the spec's genericity test in miniature: the same engine host
// drives both speakers with no edits, differing only in the facts object.

import type { HarnessAgent } from '@podium/model'
import { declaredValue, type AgentManifest } from '../../../manifest.js'

/**
 * The harness kind both flavors' facts are read for, as a VALUE for the
 * composition root (same shape as `claudeSdkHarnessKind`): the daemon hands
 * `opencodeFlavor`/`opencode2Flavor` the sections of THIS adapter without
 * writing the name itself — identifiers may flow as values, literals may not
 * (vendor lint).
 */
export const opencodeHarnessKind = 'opencode' as const

/** One speaker of the opencode HTTP protocol. */
export interface OpencodeEngineFlavor {
  driverId: 'opencode-server' | 'opencode2-server'
  /** Value passed as the engine child's harness identity (env composition). */
  harnessKind: HarnessAgent
  /** Bare executable name, resolved to a path by the supervisor's inventory. */
  executableName: string
  /** `runtime.server.spawn` stem with the resolved executable and the
   *  daemon-picked port substituted. */
  serveArgs: (executable: string, port: number) => string[]
  /** The account name the driver authenticates as. Constant because it is not
   *  a secret and not a principal — the password is the credential. */
  username: string
  healthPath: string
  /** Env vars that override the stored login and must not reach the child. */
  stripEnv: readonly string[]
  /** `podium-<token>-<sessionId>`: the scope label, from the client-terminal
   *  section's label token. */
  scopeToken: string
  /** The binding-journal namespace: durable metadata, keyed per flavor. */
  journalNamespace: string
  /** The attach-target kind for the stock client terminal. */
  attachKind: string
  /** QUESTION_TOOL and its friends ride the child's env; the preview needs
   *  extra deployment env (isolated database, frozen autoupdate), supplied by
   *  the supervisor alongside. */
  extraEnv(): Record<string, string>
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`opencode adapter does not declare ${what}`)
  return value
}

const DAEMON_PORT = '<daemon-picked>'

function serveArgsFromStem(stem: readonly string[]) {
  return (executable: string, port: number): string[] =>
    stem.map((token, i) => {
      if (i === 0) return executable
      return token === DAEMON_PORT ? String(port) : token
    })
}

/** The stable speaker, read off the HANDED adapter sections. */
export function opencodeFlavor(
  sections: Pick<AgentManifest, 'kind' | 'runtime' | 'inventory'>,
): OpencodeEngineFlavor {
  const server = required(declaredValue(sections.runtime.server), 'runtime.server')
  const clientTerminal = required(
    declaredValue(server.clientTerminal),
    'runtime.server.clientTerminal',
  )
  return {
    driverId: 'opencode-server',
    harnessKind: sections.kind,
    executableName:
      sections.inventory.executable.names[0] ??
      required(server.spawn[0], 'runtime.server.spawn[0]'),
    serveArgs: serveArgsFromStem(server.spawn),
    username: 'podium',
    healthPath: '/global/health',
    stripEnv: sections.inventory.foreignCredentialEnv,
    scopeToken: clientTerminal.labelToken,
    journalNamespace: 'opencode-servers',
    attachKind: 'opencode',
    extraEnv: () => ({}),
  }
}

/** The preview speaker: the HANDED sections' `serverAlternatives[0]` where a
 *  section exists, preview deployment facts otherwise. */
export function opencode2Flavor(
  sections: Pick<AgentManifest, 'kind' | 'runtime' | 'inventory'>,
): OpencodeEngineFlavor {
  const alternative = sections.runtime.serverAlternatives?.find(
    (server) => server.driverId === 'opencode2-server',
  )
  if (!alternative) throw new Error("opencode adapter declares no 'opencode2-server' alternative")
  const clientTerminal = required(
    declaredValue(alternative.clientTerminal),
    'runtime.serverAlternatives[0].clientTerminal',
  )
  const [executable] = alternative.spawn
  return {
    driverId: 'opencode2-server',
    harnessKind: sections.kind,
    executableName: required(executable, 'serverAlternatives[0].spawn[0]'),
    serveArgs: serveArgsFromStem(alternative.spawn),
    username: 'opencode',
    healthPath: '/api/health',
    stripEnv: sections.inventory.foreignCredentialEnv,
    scopeToken: clientTerminal.labelToken,
    journalNamespace: 'opencode2-servers',
    attachKind: 'opencode',
    // The preview migrates the stable CLI's default database to an
    // incompatible schema: isolate only the database so both still read the
    // instance's shared credentials and configuration. Preview servers
    // self-update in the background: freeze the admitted API build. The
    // database PATH is supervisor layout (state dir) and arrives via
    // flavorEnv; the flags are preview facts and live here.
    extraEnv: () => ({ OPENCODE_DISABLE_AUTOUPDATE: '1' }),
  }
}
