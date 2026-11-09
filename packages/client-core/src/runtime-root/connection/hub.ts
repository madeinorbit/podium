/**
 * SOCKET HUB CONSTRUCTION (#262 [spec:SP-3fe2]): the SocketHub in metadata
 * delta mode, persisting after apply into the replica. Moved out of the old
 * engine wiring (POD-6681); the connection service (`./connection-service.ts`)
 * is its one caller.
 */

import type { PodiumClientApi } from '../../api'
import type { Replica } from '../../replica/kernel/facade'
import { applyLegacyMetadataState } from '../../replica/legacy-wire-v1-binding'
import { LegacyWireV1Feed } from '../../replica/legacy-wire-v1-feed'
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
  /**
   * WIRE v2 (POD-1223): when supplied, this hub advertises wire 2 and hands
   * every frame to the kernel Replica's consumer.
   *
   * The two feed ports are mutually exclusive. Canonical v2 envelopes go to
   * the supplied Replica sink; wire-v1 gets a Replica-owned compatibility sink.
   */
  feed?: FeedSinkPort
  /** Liveness ping cadence, when the platform has an opinion (native: 10 s). */
  heartbeatIntervalMs?: number
  makeSocket?: import('../../socket-transport').SocketHubOptions['makeSocket']
}): SocketHub {
  const { api, replica } = args
  const make: CreateHub = args.createHub ?? ((opts) => new SocketHub(opts))
  const heartbeat =
    args.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: args.heartbeatIntervalMs }
      : undefined
  if (args.feed !== undefined) {
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
  return make({
    url: args.wsClientUrl,
    onError: (message) => args.onFatalError(message),
    ...heartbeat,
    issuesNormalized: true,
    ...(args.makeSocket ? { makeSocket: args.makeSocket } : {}),
    legacyFeed: new LegacyWireV1Feed({
      fetchChangesSince: (cursor) => api.sync.changesSince.query({ cursor }),
      initialCursor: replica.getCursor(),
      applied: (state) => applyLegacyMetadataState(replica, state),
    }),
  })
}
