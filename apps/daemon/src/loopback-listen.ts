import type { Server } from 'node:http'
import { createLogger } from '@podium/logger'

const log = createLogger('daemon')

/**
 * Loopback bind for the daemon's two agent-facing endpoints (hook ingest and
 * agent relay), and the policy for what happens when the port they want is
 * already taken.
 *
 * WHY THESE PORTS MAY MOVE AND THE SERVER PORT MAY NOT (POD-1229). The server
 * port is dialed from OUTSIDE Podium — by a browser, by another machine, by an
 * operator's bookmark — so binding a different one serves nobody and
 * `startServer` rightly refuses. These two are dialed only by processes Podium
 * itself launches, and it writes the address into their settings/env at spawn.
 * A moved port therefore costs only the sessions spawned BEFORE the move, and
 * those are lost anyway: whatever else answers on the old port is not this
 * daemon. Refusing to start instead costs the entire daemon host — machine
 * registration, folder browsing, session control — which is how a hook-port
 * collision used to present as "MBP-Cofo.local is offline" with nothing
 * anywhere naming a port. Degrade the endpoint, never the host; then say so
 * loudly enough that the drift is not silent (see {@link StablePortConflict}).
 */
export interface StablePortConflict {
  /** The stable port the daemon asked for: env, config, or instance-derived. */
  preferredPort: number
  /** The ephemeral port it settled for. Not stable across daemon restarts. */
  boundPort: number
  /** The runtime's own listen failure text — Bun and Node word it differently. */
  detail: string
}

export function isAddressInUse(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRINUSE'
  )
}

/**
 * `listen` on loopback as a promise that ALWAYS settles.
 *
 * Both failure shapes end in one rejection: the `error` event (what Node and
 * Bun emit for EADDRINUSE today) and a synchronous throw out of `listen`
 * (which Bun's native server does, and which `startServer` already guards for
 * the same reason). An unguarded synchronous throw escapes the executor as an
 * uncaught exception, the process-safety net logs it as surviving, and the
 * promise it escaped from never settles — a daemon that hangs at boot forever
 * instead of failing.
 */
export function listenLoopback(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      server.off('error', fail)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    server.on('error', fail)
    try {
      server.listen(port, '127.0.0.1', () => {
        if (settled) return
        const addr = server.address()
        settled = true
        server.off('error', fail)
        if (addr === null || typeof addr === 'string') {
          reject(new Error(`listen on 127.0.0.1:${port} reported no port`))
          return
        }
        resolve(addr.port)
      })
    } catch (err) {
      fail(err)
    }
  })
}

/**
 * Bind the stable port; on a collision, bind an ephemeral one and report it.
 *
 * The conflict is returned rather than logged so the caller can put it where a
 * person will actually see it — the daemon turns it into a machine diagnostic,
 * not just a line in a log nobody opens when their machine reads offline.
 * `preferred: 0` is a caller asking for an ephemeral port outright (tests);
 * there is nothing to fall back from, so any failure is theirs.
 */
export async function listenStableLoopbackPort(
  server: Server,
  preferred: number,
  label = 'loopback endpoint',
): Promise<{ port: number; conflict?: StablePortConflict }> {
  const bound = await bindPreferredOrEphemeral(server, preferred)
  // Past the bind, an 'error' event with no listener is an uncaught exception,
  // and this server belongs to a daemon whose other work has nothing to do with
  // it. Nothing here can repair a socket-level failure, so record it and let
  // the daemon live rather than take the host down over one endpoint.
  server.on('error', (err) => log.warn(`${label} server error`, { err }))
  return bound
}

async function bindPreferredOrEphemeral(
  server: Server,
  preferred: number,
): Promise<{ port: number; conflict?: StablePortConflict }> {
  try {
    return { port: await listenLoopback(server, preferred) }
  } catch (err) {
    if (preferred === 0 || !isAddressInUse(err)) throw err
    const boundPort = await listenLoopback(server, 0)
    return {
      port: boundPort,
      conflict: {
        preferredPort: preferred,
        boundPort,
        detail: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

/** The endpoint-specific half of a conflict report: what it is, what moving it costs. */
export interface StablePortEndpoint {
  /** Diagnostic code stem, e.g. `hook-ingest` → `hook-ingest-port-conflict`. */
  code: string
  /** What an operator calls it: 'hook ingest', 'agent relay'. */
  name: string
  /** What a session spawned before the move loses, in a person's terms. */
  cost: string
  /** The override that pins this port. */
  envVar: string
  /** The `config.json` key that does the same. */
  configKey: string
}

export const HOOK_INGEST_ENDPOINT: StablePortEndpoint = {
  code: 'hook-ingest',
  name: 'hook ingest',
  cost: 'their run state stops updating — they read as idle whatever they are really doing',
  envVar: 'PODIUM_HOOK_PORT',
  configKey: 'hookPort',
}

export const AGENT_RELAY_ENDPOINT: StablePortEndpoint = {
  code: 'agent-relay',
  name: 'agent relay',
  cost: 'the `podium` CLI inside them can no longer reach this daemon',
  envVar: 'PODIUM_AGENT_RELAY_PORT',
  configKey: 'agentRelayPort',
}

/**
 * Turn a conflict into the machine diagnostic a person is shown.
 *
 * The whole point of the fallback is that the degradation is NAMED. Every field
 * here exists because the failure it replaces said nothing: the port, what
 * still works, what does not, and the two ways to pin the port for good.
 */
export function describePortConflict(
  endpoint: StablePortEndpoint,
  conflict: StablePortConflict,
  instanceId: string,
): { code: string; title: string; description: string; body: string } {
  return {
    code: `${endpoint.code}-port-conflict`,
    title: `Podium ${endpoint.name} port ${conflict.preferredPort} is already in use`,
    description:
      `Another program on this machine is already listening on the port this Podium ` +
      `daemon uses for its ${endpoint.name}, so it moved to a temporary one. Sessions ` +
      `started from now on are fine; sessions that were already running before it moved ` +
      `are not, and restarting them fixes those.`,
    body: [
      `The daemon could not bind 127.0.0.1:${conflict.preferredPort} (${conflict.detail}), ` +
        `so ${endpoint.name} is listening on 127.0.0.1:${conflict.boundPort} instead.`,
      `That port is ephemeral: it changes on every daemon restart. Sessions spawned from ` +
        `now on are given the bound port and work normally. Sessions spawned earlier still ` +
        `address ${conflict.preferredPort}, so ${endpoint.cost}. Restart those sessions to ` +
        `re-point them.`,
      `The usual cause is a second Podium instance, or an orphaned podium process, on this ` +
        `machine. Stop it, or give this instance a port of its own with ` +
        `${endpoint.envVar}=<port> (config key \`${endpoint.configKey}\`) and restart the ` +
        `daemon. Instance: '${instanceId}'.`,
    ].join('\n\n'),
  }
}
