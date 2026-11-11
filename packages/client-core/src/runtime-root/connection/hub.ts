/**
 * SOCKET HUB CONSTRUCTION (#262 [spec:SP-3fe2]): the SocketHub in metadata
 * delta mode, persisting after apply into the replica. Moved out of the old
 * engine wiring (POD-6681); the connection service (`./connection-service.ts`)
 * is its one caller.
 */

import type { PodiumClientApi } from '../../api'
import type { Replica } from '../../replica/kernel/facade'
import { type FeedSinkPort, SocketHub } from '../../socket-transport'

/** SocketHub construction seam — injectable so engine unit tests run a fake hub. */
export type CreateHub = (opts: ConstructorParameters<typeof SocketHub>[0]) => SocketHub

/** Expected cold-offline failures leave the persisted kernel slice mounted. */
export function isInitialConnectivityError(message: string): boolean {
  return (
    message === 'WebSocket connection failed' ||
    message === 'WebSocket connection closed before connecting'
  )
}

export function createEngineHub(args: {
  wsClientUrl: string
  api: PodiumClientApi
  replica: Replica
  onFatalError: (message: string) => void
  createHub?: CreateHub
  /** The platform replica owns catch-up and worker bootstrap over HTTP. */
  feed?: FeedSinkPort
  /** Liveness ping cadence, when the platform has an opinion (native: 10 s). */
  heartbeatIntervalMs?: number
  makeSocket?: import('../../socket-transport').SocketHubOptions['makeSocket']
}): SocketHub {
  const make: CreateHub = args.createHub ?? ((opts) => new SocketHub(opts))
  const heartbeat =
    args.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: args.heartbeatIntervalMs }
      : undefined
  return make({
    url: args.wsClientUrl,
    onError: (message) => {
      if (!isInitialConnectivityError(message)) args.onFatalError(message)
    },
    feed: args.feed,
    ...(args.makeSocket ? { makeSocket: args.makeSocket } : {}),
    ...heartbeat,
  })
}
