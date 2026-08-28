import { randomUUID } from 'node:crypto'
import { createLogger } from '@podium/logger'
import { asMachineId } from '@podium/model'
import type { DaemonPtyOutputBatch } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { PARENT_HAS_SERVER_ENV } from '@podium/runtime/parent-process'
import { captureDaemonBootBuild } from './build-report'
import { createDaemonConnection, type DaemonConnection } from './connection-state'
import { disarmExitSeam } from './convergence'
import type { DaemonOptions } from './daemon-options'
import { createDetachedRestart, waitForDetachedRestartParent } from './detached-restart'
import { createDaemonHostRuntime } from './host-runtime'
import { bootstrapDaemonInstance } from './instance-bootstrap'
import type { PortableStateControl } from './portable-state-fence'
import { createQueueDrainOutbox } from './queue-drain-outbox'
import { createRuntimeEventOutbox } from './runtime-event-outbox'

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

const log = createLogger('daemon')

export interface DaemonHandle {
  readonly hookPort: number
  readonly hookSocketPath?: string
  readonly agentRelayPort: number
  /** Source-transfer seam for daemon-owned portable state in all-in-one composition. */
  readonly portableState: PortableStateControl
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
   * survive unless `reapSessions` is explicitly requested; that full-reap mode
   * also retires registered server-family children and their binding journals.
   */
  close(opts?: { reapSessions?: boolean }): Promise<void>
}

/**
 * Thin daemon composition root. Instance identity, host-control services,
 * application frame guards, self-update policy, and the reconnecting transport
 * each live in their owning modules; this function only wires their ports.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  await waitForDetachedRestartParent()
  const { build, installDir } = captureDaemonBootBuild(
    process.env,
    process.execPath,
    opts.sourceRoot,
  )
  log.info('daemon process start', {
    pid: process.pid,
    appVersion: build.appVersion,
    wireSchemaDigest: build.wireSchemaDigest,
    installKind: build.installKind,
    serverUrl: opts.serverUrl,
    topology: opts.localLink ? 'local-link' : 'remote-websocket',
    supervised: process.env.PODIUM_DESKTOP_SUPERVISED === '1',
    underParent: process.env.PODIUM_UNDER_PARENT === '1',
    stateDir: process.env.PODIUM_STATE_DIR,
    installDir,
  })
  /**
   * THE EXIT SEAM, DISARMED WHERE EXITING IS FATAL (POD-2210).
   *
   * `restartAfterUpdate` is the one call in this daemon whose default is
   * `process.exit(0)`, and it has two callers: the grant runner after a
   * convergence, and the protocol-mismatch self-update in `connection-state`.
   * The grant path is already refused before it can reach here
   * ({@link refuseConvergence}); disarming the seam itself is what makes that
   * refusal a property of the process rather than of one code path, so a future
   * third caller cannot reintroduce a silent stop of the server.
   */
  const detachedRestart = opts.restartAfterUpdate ?? createDetachedRestart()
  const options: DaemonOptions = disarmExitSeam({
    ...(detachedRestart ? { provided: detachedRestart } : {}),
    shape: { exitStopsServer: opts.exitStopsServer ?? false, env: process.env },
  })
    ? {
        ...opts,
        restartAfterUpdate: () =>
          log.warn(
            'not exiting to finish an update: this daemon shares its process with the podium ' +
              'server and nothing would restart it. Stop podium and start it again.',
          ),
      }
    : detachedRestart
      ? { ...opts, restartAfterUpdate: detachedRestart }
      : opts
  const instance = bootstrapDaemonInstance({
    settingsDir: opts.hooks?.settingsDir,
    socketPath: opts.hooks?.socketPath,
    receiptDir: opts.hooks?.receiptDir,
    acquireGuards: true,
  })
  const parentHostsUpdateParticipant =
    process.env.PODIUM_UNDER_PARENT === '1' && process.env[PARENT_HAS_SERVER_ENV] === '1'
  let connection: DaemonConnection | undefined
  const queueDrainOutbox = createQueueDrainOutbox(instance.runtimeDir)
  const runtimeEventOutbox = createRuntimeEventOutbox(instance.runtimeDir)
  const host = await createDaemonHostRuntime({
    options,
    instance,
    build,
    installDir,
    send: (message) => {
      if (message.type === 'runtimeEvent') {
        const durable = { ...message, deliveryId: message.deliveryId ?? randomUUID() }
        runtimeEventOutbox.enqueue(durable)
        connection?.send(durable)
        return
      }
      // The host exists briefly before its transport does. Persist the one frame
      // whose producer drops its only copy even in that bootstrap window;
      // connection.send repeats the idempotent enqueue once the transport exists.
      if (message.type === 'runtimeQueueDrainAbandoned') {
        if (!message.reportId) throw new Error('queue-drain abandonment requires reportId')
        queueDrainOutbox.enqueue({ ...message, reportId: message.reportId })
      }
      connection?.send(message)
    },
    sendOutput: (batch: DaemonPtyOutputBatch) => connection?.sendOutput(batch),
    acknowledgeQueueDrainReport: (reportId) => {
      if (connection) connection.acknowledgeQueueDrainReport(reportId)
      else queueDrainOutbox.acknowledge(reportId)
    },
    acknowledgeRuntimeEvent: (deliveryId) => {
      if (connection) connection.acknowledgeRuntimeEvent(deliveryId)
      else runtimeEventOutbox.acknowledge(deliveryId)
    },
  }).catch((error) => {
    instance.releaseGuards()
    throw error
  })
  connection = createDaemonConnection({
    options,
    build,
    reportUpdateIdentity: !parentHostsUpdateParticipant,
    machineId: asMachineId(host.machineId),
    identity: host.identity,
    receiveApplicationFrame: host.receive,
    receiveBinaryInput: host.receiveBinaryInput,
    sendApplicationFrame: (socket, message) =>
      host.frameGuard.send(socket as never, message as DaemonMessage),
    queueDrainOutbox,
    runtimeEventOutbox,
    onConnected: host.connected,
    onTerminal: host.close,
    restartAfterUpdate: options.restartAfterUpdate,
  })
  const startedAt = Date.now()
  log.info('daemon connection start', {
    pid: process.pid,
    serverUrl: options.serverUrl,
    topology: options.localLink ? 'local-link' : 'remote-websocket',
  })
  try {
    await connection.start()
    log.info('daemon connection start settled', {
      pid: process.pid,
      state: connection.state,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (error) {
    log.error('daemon connection start rejected', {
      pid: process.pid,
      state: connection.state,
      elapsedMs: Date.now() - startedAt,
      err: error,
    })
    await host.close({ reapSessions: true }).catch(() => {})
    instance.releaseGuards()
    throw error
  }

  return {
    hookPort: host.hookPort,
    ...(host.hookSocketPath ? { hookSocketPath: host.hookSocketPath } : {}),
    agentRelayPort: host.agentRelayPort,
    portableState: host.portableState,
    // A getter, not a snapshot: the link goes up and down over the process's
    // life, so a boolean captured here would be the same lie in a new place.
    get connected() {
      return connection?.state === 'connected'
    },
    async close(closeOpts) {
      try {
        await host.close(closeOpts)
        await connection?.close()
      } finally {
        instance.releaseGuards()
      }
    },
  }
}
