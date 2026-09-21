// packages/harness/src/driver/families/opencode/engine-facts.ts
//
// THE OPENCODE ENGINE'S FACTS (1.5, spec §5). Same rule as
// ../codex/engine-facts.ts, with one extra row: this protocol has TWO
// speakers — the stable server and the 2 preview server — so the facts come
// in two flavors. The v1 flavor reads off the opencode adapter's sections;
// the v2 flavor reads the adapter's `serverAlternatives[0]` where a section
// exists (spawn stem, label token) and declares the preview's own deployment
// facts beside it. Either way the engine host takes facts, never names.
//
// That is also the spec's genericity test in miniature: the same engine host
// drives both speakers with no edits, differing only in the facts object.

import type { AgentKind } from '@podium/model'
import { declaredValue } from '../../../manifest.js'
import { manifestFor } from '../../../registry.js'

/** One speaker of the opencode HTTP protocol. */
export interface OpencodeEngineFlavor {
  driverId: 'opencode-server' | 'opencode2-server'
  /** Value passed as the engine child's harness identity (env composition). */
  harnessKind: AgentKind
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

/** The stable speaker, read off the opencode adapter's sections. */
export function opencodeFlavor(): OpencodeEngineFlavor {
  const manifest = manifestFor('opencode')
  if (!manifest) throw new Error("no harness adapter for 'opencode'")
  const server = required(declaredValue(manifest.runtime.server), 'runtime.server')
  const clientTerminal = required(
    declaredValue(server.clientTerminal),
    'runtime.server.clientTerminal',
  )
  return {
    driverId: 'opencode-server',
    harnessKind: manifest.kind,
    executableName:
      manifest.inventory.executable.names[0] ?? required(server.spawn[0], 'runtime.server.spawn[0]'),
    serveArgs: serveArgsFromStem(server.spawn),
    username: 'podium',
    healthPath: '/global/health',
    stripEnv: manifest.inventory.foreignCredentialEnv,
    scopeToken: clientTerminal.labelToken,
    journalNamespace: 'opencode-servers',
    attachKind: 'opencode',
    extraEnv: () => ({}),
  }
}

/** The preview speaker: the adapter's `serverAlternatives[0]` where a section
 *  exists, preview deployment facts otherwise. */
export function opencode2Flavor(): OpencodeEngineFlavor {
  const manifest = manifestFor('opencode')
  if (!manifest) throw new Error("no harness adapter for 'opencode'")
  const alternative = manifest.runtime.serverAlternatives?.find(
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
    harnessKind: manifest.kind,
    executableName: required(executable, 'serverAlternatives[0].spawn[0]'),
    serveArgs: serveArgsFromStem(alternative.spawn),
    username: 'opencode',
    healthPath: '/api/health',
    stripEnv: manifest.inventory.foreignCredentialEnv,
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
