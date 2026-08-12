/**
 * `logs.setLevel` — THE OPERATOR REACHING A RUNNING CLIENT (POD-1920, chunk 7 of
 * [spec:2026-08-11-logging-strategy-design]).
 *
 * Everything else in this epic built the pipe: the logger, the three client
 * sinks, ingestion, the per-origin files. This is the valve. Its whole job is to
 * turn "raise this one user's client to `debug`" into frames on the connections
 * that are open right now.
 *
 * ---------------------------------------------------------------------------
 * IT PUSHES DOWN THE CHANNEL THAT ALREADY EXISTS
 * ---------------------------------------------------------------------------
 * The `/client` socket already carries server-initiated commands — the
 * browser-open family is a daemon→server→client request, not an RPC — so a raise
 * is one more `ServerMessage` through `ClientRegistry.deliver`, which is the
 * narrow waist every write to a client socket goes through. There is no second
 * channel here and there must not be one.
 *
 * ---------------------------------------------------------------------------
 * NO STATE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * This remembers nothing. A raise is delivered to the connections that match it
 * and is then the CLIENT's, held under the client's own TTL. Two things follow,
 * and both are the design rather than a gap:
 *
 *   - a client that reconnects (or reloads) is at its default again, and nobody
 *     has to remember to put it back;
 *   - a client that was offline during the call was not raised, which the reply
 *     says by not listing it.
 *
 * A server-side "clients that should be at debug" table would give the operator
 * a raise that survives a reload — and, with it, the one failure mode this whole
 * feature is written to avoid: a client stuck at `debug` because the row outlived
 * everyone's memory of why it was written.
 *
 * ---------------------------------------------------------------------------
 * THE REPLY IS THE DISCOVERY MECHANISM
 * ---------------------------------------------------------------------------
 * There is no separate "list connected clients" query. The reply names every
 * connection the command reached, with the self-description that connection sent
 * in `hello` — the same role/version/machine tuple the server files its forwarded
 * records under. So an operator with no idea what is connected raises everything,
 * reads who that was, and narrows on the next call. One command, and no surface
 * that exists only to be looked at.
 */

import type { LogsSetLevelInput } from '@podium/commands'
import { createLogger } from '@podium/logger'
import type { ClientLogOrigin, ServerMessage } from '@podium/protocol'

const log = createLogger('server:logs')

/**
 * The connection set, narrowed to what a raise needs: who is connected, and how
 * to hand one of them a frame.
 *
 * A PORT rather than the gateway's `ClientRegistry` because this module is a
 * feature and the registry is the gateway's (POD-390). The registry satisfies
 * this structurally; the feature says which connections a message is for, and
 * the gateway remains the only thing that touches a socket.
 */
export interface ClientConnectionsPort {
  values(): IterableIterator<{ id: string; origin?: ClientLogOrigin }>
  deliver(conn: { id: string }, msg: ServerMessage): void
}

/** One connection a raise reached, as the operator needs to see it. */
export interface RaisedClient {
  clientId: string
  role?: string
  v?: string
  machineId?: string
}

export interface SetLevelResult {
  /** What the level now is on the clients below; `null` means "their default". */
  level: LogsSetLevelInput['level']
  /** Every connection the command reached, in registry order. */
  clients: RaisedClient[]
}

/** Does this connection match the selector? Absent selector fields do not
 *  constrain, so an empty selector matches every connection — see the contract's
 *  `logLevelTarget`. A field that IS given must match, and a connection with no
 *  `origin` at all therefore cannot match a `role` or `machineId` selector: it
 *  never told us, and guessing would raise the wrong client. */
function matches(
  conn: { id: string; origin?: ClientLogOrigin },
  target: NonNullable<LogsSetLevelInput['target']> | undefined,
): boolean {
  if (!target) return true
  if (target.clientId !== undefined && target.clientId !== conn.id) return false
  if (target.role !== undefined && target.role !== conn.origin?.role) return false
  if (target.machineId !== undefined && target.machineId !== conn.origin?.machineId) return false
  return true
}

export class ClientLogLevelDirector {
  constructor(private readonly clients: ClientConnectionsPort) {}

  setLevel(input: LogsSetLevelInput): SetLevelResult {
    const message: ServerMessage = {
      type: 'setLogLevel',
      level: input.level,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    }
    const reached: RaisedClient[] = []
    for (const conn of this.clients.values()) {
      if (!matches(conn, input.target)) continue
      this.clients.deliver(conn, message)
      reached.push({
        clientId: conn.id,
        ...(conn.origin?.role !== undefined ? { role: conn.origin.role } : {}),
        ...(conn.origin?.v !== undefined ? { v: conn.origin.v } : {}),
        ...(conn.origin?.machineId !== undefined ? { machineId: conn.origin.machineId } : {}),
      })
    }
    // The server's own record of an act performed on somebody else's client, at
    // a level the server's default (`info`) shows. An operator asking later why
    // a client was verbose for half an hour should find the answer here rather
    // than only in the client's own file.
    // `to`, not `level`: the record shape owns `level` and DROPS a caller field
    // of that name, so this would otherwise report an act without its content.
    log.info('client log level command', {
      to: input.level,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      reached: reached.length,
    })
    return { level: input.level, clients: reached }
  }
}
