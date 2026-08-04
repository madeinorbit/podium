import { asMachineId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { createDaemonConnection, type DaemonConnection } from './connection-state'
import type { DaemonOptions } from './daemon-options'
import { createDaemonHostRuntime } from './host-runtime'
import { bootstrapDaemonInstance } from './instance-bootstrap'

export type { DurableBackend } from './control/context'
export { sessionRelayEnv } from './control/session'
export { normalizeAgentKind } from './control/transcripts'
export type {
  DaemonDiscoveryOptions,
  DaemonHooksOptions,
  DaemonMetricsOptions,
  DaemonOptions,
  ReconnectTimers,
} from './daemon-options'
export {
  noDurableBackendWarning,
  resolveDurableBackend,
} from './durable-backend'
export { controlFrameByteLength, payloadRejectionReply } from './frame-guards'
export { createLimiter, createReattachGates } from './reattach-gates'

export interface DaemonHandle {
  readonly hookPort: number
  readonly hookSocketPath?: string
  readonly agentRelayPort: number
  /**
   * Whether the server link is ACTUALLY established right now (POD-1585).
   *
   * `startDaemon` resolves on first connect OR after a ~10s grace, because an
   * offline server must not block boot. That makes the resolved handle a claim
   * about BOOT, not about connectivity — and an entrypoint that prints
   * "connected to <url>" on the strength of it is asserting something it never
   * checked. It cost a pre-merge blocker: a daemon whose server had died logged
   * "podium daemon up: connected to ws://…", and the machine it never registered
   * read offline in the UI, so working code was reported as broken. Read this
   * before saying the word "connected".
   */
  readonly connected: boolean
  /**
   * Detach from live sessions and close the server connection. Durable masters
   * survive unless `reapSessions` is explicitly requested.
   */
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

/**
 * Thin daemon composition root. Instance identity, host-control services,
 * application frame guards, self-update policy, and the reconnecting transport
 * each live in their owning modules; this function only wires their ports.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const instance = bootstrapDaemonInstance({
    settingsDir: opts.hooks?.settingsDir,
    socketPath: opts.hooks?.socketPath,
    receiptDir: opts.hooks?.receiptDir,
  })
  let connection: DaemonConnection | undefined
  const host = await createDaemonHostRuntime({
    options: opts,
    instance,
    send: (message) => connection?.send(message),
  })
  connection = createDaemonConnection({
    options: opts,
    machineId: asMachineId(host.machineId),
    identity: host.identity,
    receiveApplicationFrame: host.receive,
    sendApplicationFrame: (socket, message) =>
      host.frameGuard.send(socket as never, message as DaemonMessage),
    onConnected: host.connected,
    onTerminal: host.close,
    restartAfterUpdate: opts.restartAfterUpdate,
  })
  await connection.start()

  return {
    hookPort: host.hookPort,
    ...(host.hookSocketPath ? { hookSocketPath: host.hookSocketPath } : {}),
    agentRelayPort: host.agentRelayPort,
    // A getter, not a snapshot: the link goes up and down over the process's
    // life, so a boolean captured here would be the same lie in a new place.
    get connected() {
      return connection?.state === 'connected'
    },
    async close(closeOpts) {
      await host.close(closeOpts)
      await connection?.close()
    },
  }
}
