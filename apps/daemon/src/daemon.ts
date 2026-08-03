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
  })
  await connection.start()

  return {
    hookPort: host.hookPort,
    ...(host.hookSocketPath ? { hookSocketPath: host.hookSocketPath } : {}),
    agentRelayPort: host.agentRelayPort,
    async close(closeOpts) {
      await host.close(closeOpts)
      await connection?.close()
    },
  }
}
