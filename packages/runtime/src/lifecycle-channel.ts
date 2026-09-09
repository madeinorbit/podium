/**
 * The private line between a supervisor and each child it spawned (POD-3761).
 *
 * WHY A CHANNEL AND NOT A PID FILE OR A PORT. During a handover the old and
 * the new supervisor both exist, both have a server, and both used to identify
 * "their" server by the same pid file and the same port — so neither could tell
 * whose child had come up (POD-3752). This channel is the descriptor `spawn`
 * hands a child with `'ipc'` in its stdio: it exists ONLY between a process and
 * the child it started, cannot be named, connected to, or forged by anyone else,
 * and is closed by the kernel when either end dies. Identity is structural — a
 * child can reach exactly the parent that spawned it — so there is no token.
 *
 * What travels on it is LIFECYCLE ONLY:
 *   child → parent   ready {role, pid, version, digest?, port?}
 *                    degraded {reason} · heartbeat · stopping {reason}
 *   parent → child   identity {generation, machineId?, assignment?} at connect
 *                    stop {reason}
 * Fleet-plane facts (grants, update status, presence, build) stay on /machine.
 *
 * CONTAINMENT. Bun passes the channel by descriptor inheritance alone: it is
 * outside the default stdio set and there is no environment variable that
 * names it (POD-3760 measured this on all four platforms). A grandchild — an
 * agent session, a pty host, a detached successor — therefore cannot see it
 * unless a spawn explicitly asks for `'ipc'`, which nothing below the parent
 * does. Node's runtime DOES name its descriptor in `NODE_CHANNEL_FD`, so
 * {@link withoutLifecycleChannel} strips that too, the same way
 * `unsupervisedEnv` strips the desktop shell's pid.
 *
 * SUPERVISOR DEATH. On Linux and macOS the child's end sees `'disconnect'`
 * within milliseconds of the parent dying. On Windows it sees nothing, and the
 * CI evidence cannot separate "Windows tore the child down" from "the runner's
 * job object killed the orphan" (POD-3774). {@link supervisorDeathSignal} is the
 * seam that answer drops into: it decides whether channel close MEANS the
 * supervisor is gone, and nothing else in this module assumes either way.
 */
import { createLogger } from '@podium/logger'
import { z } from 'zod'
import type { IntervalScheduler } from './supervisor'

const log = createLogger('runtime:lifecycle-channel')

/** Stamped on every frame so an unrelated message on the same pipe is ignored. */
export const LIFECYCLE_PROTOCOL = 'podium-lifecycle/1'
/**
 * Heartbeat cadence, part of the contract: a parent that has not heard a beat
 * in a few multiples of this may call the child wedged. Five seconds is far
 * below any watchdog window and costs one small frame.
 */
export const LIFECYCLE_HEARTBEAT_MS = 5_000
/** Node names its IPC descriptor here; Bun names it nowhere. Stripped from grandchildren. */
export const NODE_CHANNEL_FD_ENV = 'NODE_CHANNEL_FD'

export const LifecycleRole = z.enum(['server', 'daemon'])
export type LifecycleRole = z.infer<typeof LifecycleRole>

export const ChildMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    role: LifecycleRole,
    pid: z.number().int().positive(),
    version: z.string(),
    digest: z.string().optional(),
    port: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('degraded'), reason: z.string() }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('stopping'), reason: z.string() }),
])
export type ChildMessage = z.infer<typeof ChildMessage>

export const ServiceAssignment = z.object({ server: z.boolean(), agentExecution: z.boolean() })
export type ServiceAssignment = z.infer<typeof ServiceAssignment>

/**
 * Who the parent is. `generation` orders supervisor incarnations on one
 * machine; the fence that mints it is POD-3752's, and until it lands the parent
 * supplies its own boot time, which orders correctly on one clock.
 */
export const ParentIdentity = z.object({
  generation: z.number().int().nonnegative(),
  machineId: z.string().optional(),
  assignment: ServiceAssignment.optional(),
})
export type ParentIdentity = z.infer<typeof ParentIdentity>

export const ParentMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('identity'), ...ParentIdentity.shape }),
  z.object({ type: z.literal('stop'), reason: z.string() }),
])
export type ParentMessage = z.infer<typeof ParentMessage>

export type LifecycleFrame<T> = T & { podium: typeof LIFECYCLE_PROTOCOL }

export function encodeLifecycle<T extends { type: string }>(message: T): LifecycleFrame<T> {
  return { podium: LIFECYCLE_PROTOCOL, ...message }
}

function stamped(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const frame = raw as Record<string, unknown>
  return frame.podium === LIFECYCLE_PROTOCOL ? frame : undefined
}

export function decodeChildMessage(raw: unknown): ChildMessage | undefined {
  const frame = stamped(raw)
  if (!frame) return undefined
  const parsed = ChildMessage.safeParse(frame)
  return parsed.success ? parsed.data : undefined
}

export function decodeParentMessage(raw: unknown): ParentMessage | undefined {
  const frame = stamped(raw)
  if (!frame) return undefined
  const parsed = ParentMessage.safeParse(frame)
  return parsed.success ? parsed.data : undefined
}

/**
 * The part of a `ChildProcess` (parent end) or `process` (child end) the
 * channel uses. `send` is absent on a peer spawned without `'ipc'`, which is how
 * "no channel" is detected — the same test the runtime itself uses.
 */
export interface ChannelPeer {
  connected?: boolean
  /** Method syntax on purpose: `ChildProcess.send` takes `Serializable`, and our frames are objects. */
  send?(message: object): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  removeListener(event: 'message', listener: (message: unknown) => void): unknown
  removeListener(event: 'disconnect', listener: () => void): unknown
}

function hasChannel(peer: ChannelPeer): boolean {
  return typeof peer.send === 'function' && peer.connected !== false
}

/** Send one frame; a closed pipe is a `false`, never a throw into the caller. */
function trySend(peer: ChannelPeer, frame: object): boolean {
  const send = peer.send
  if (typeof send !== 'function' || peer.connected === false) return false
  try {
    return send.call(peer, frame) !== false
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Parent end
// ---------------------------------------------------------------------------

/** Everything a child has said on its line, with when it said it. */
export interface ChildLifecycleReport {
  /** `none`: spawned without a channel. `closed`: the child's end went away. */
  channel: 'open' | 'closed' | 'none'
  ready?: {
    role: LifecycleRole
    pid: number
    version: string
    digest?: string
    port?: number
    atMs: number
  }
  degraded?: { reason: string; atMs: number }
  stopping?: { reason: string; atMs: number }
  lastHeartbeatMs?: number
  closedAtMs?: number
}

export interface ChildChannel {
  report(): ChildLifecycleReport
  /** Ask the child to shut down. `false` when there is no open channel to ask on. */
  stop(reason: string): boolean
  /** Stop listening. The pipe itself closes with the process. */
  detach(): void
}

export interface AttachChildChannelOptions {
  identity: ParentIdentity
  now?: () => number
  /** Every change to the report, for the parent to fold into its snapshot. */
  onReport?: (report: ChildLifecycleReport) => void
  onMessage?: (message: ChildMessage) => void
}

/**
 * The parent's end of one child's line. Sends `identity` immediately — the
 * child never has to ask who spawned it — and records what the child reports.
 */
export function attachChildChannel(
  peer: ChannelPeer,
  options: AttachChildChannelOptions,
): ChildChannel {
  const now = options.now ?? Date.now
  if (!hasChannel(peer)) {
    const report: ChildLifecycleReport = { channel: 'none' }
    return { report: () => report, stop: () => false, detach: () => {} }
  }
  let report: ChildLifecycleReport = { channel: 'open' }
  const update = (next: ChildLifecycleReport): void => {
    report = next
    options.onReport?.(report)
  }
  const onMessage = (raw: unknown): void => {
    const message = decodeChildMessage(raw)
    if (!message) return
    const atMs = now()
    switch (message.type) {
      case 'ready': {
        const { type: _type, ...ready } = message
        update({ ...report, ready: { ...ready, atMs } })
        break
      }
      case 'degraded':
        update({ ...report, degraded: { reason: message.reason, atMs } })
        break
      case 'heartbeat':
        update({ ...report, lastHeartbeatMs: atMs })
        break
      case 'stopping':
        update({ ...report, stopping: { reason: message.reason, atMs } })
        break
    }
    options.onMessage?.(message)
  }
  const onDisconnect = (): void => {
    update({ ...report, channel: 'closed', closedAtMs: now() })
  }
  peer.on('message', onMessage)
  peer.on('disconnect', onDisconnect)
  trySend(peer, encodeLifecycle({ type: 'identity', ...options.identity }))
  return {
    report: () => report,
    stop: (reason) =>
      report.channel === 'open' && trySend(peer, encodeLifecycle({ type: 'stop', reason })),
    detach: () => {
      peer.removeListener('message', onMessage)
      peer.removeListener('disconnect', onDisconnect)
    },
  }
}

// ---------------------------------------------------------------------------
// Child end
// ---------------------------------------------------------------------------

/**
 * Does the channel closing mean the supervisor is gone?
 *
 * POSIX: yes, and within milliseconds (POD-3760 measured 9–23 ms). Windows: the
 * channel fires no disconnect when the supervisor vanishes, and whether the child
 * survives at all is unknown outside CI (POD-3774). Until a real Windows desktop
 * answers, the child there is told nothing by this seam and keeps the pid-based
 * watch it already has.
 */
export type SupervisorDeathSignal = 'disconnect' | 'none'
export function supervisorDeathSignal(platform: string = process.platform): SupervisorDeathSignal {
  return platform === 'win32' ? 'none' : 'disconnect'
}

export interface LifecycleClient {
  ready(extra?: { port?: number }): boolean
  degraded(reason: string): boolean
  stopping(reason: string): boolean
  /** The parent's identity, once it has arrived. */
  identity(): ParentIdentity | undefined
  onIdentity(listener: (identity: ParentIdentity) => void): void
  onStop(listener: (reason: string) => void): void
  /** Fires at most once, and only when {@link supervisorDeathSignal} allows. */
  onSupervisorGone(listener: () => void): void
  /** Stop the heartbeat and listening. Safe to call twice. */
  close(): void
}

export interface LifecycleClientOptions {
  role: LifecycleRole
  version: string
  digest?: string
  /** Default `process.pid`. */
  pid?: number
  /** Default `process`. */
  transport?: ChannelPeer
  heartbeatMs?: number
  scheduler?: IntervalScheduler
  deathSignal?: SupervisorDeathSignal
}

const realScheduler: IntervalScheduler = {
  every: (ms, callback) => {
    const timer = setInterval(callback, ms)
    // A heartbeat must never be what keeps a process alive.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  },
}

/**
 * Open this process's end of the line to the supervisor that spawned it, or
 * `undefined` when there is none — a foreground `podium server`, a test, a
 * process under a shell that is not the parent. Starts the heartbeat at once.
 */
export function connectLifecycleChannel(
  options: LifecycleClientOptions,
): LifecycleClient | undefined {
  const transport: ChannelPeer = options.transport ?? (process as unknown as ChannelPeer)
  if (!hasChannel(transport)) return undefined
  const scheduler = options.scheduler ?? realScheduler
  const deathSignal = options.deathSignal ?? supervisorDeathSignal()
  const pid = options.pid ?? process.pid
  let identity: ParentIdentity | undefined
  const identityListeners: Array<(identity: ParentIdentity) => void> = []
  const stopListeners: Array<(reason: string) => void> = []
  const goneListeners: Array<() => void> = []
  let closed = false
  let goneFired = false

  const send = (message: ChildMessage): boolean => trySend(transport, encodeLifecycle(message))

  const onMessage = (raw: unknown): void => {
    const message = decodeParentMessage(raw)
    if (!message) return
    if (message.type === 'identity') {
      const { type: _type, ...received } = message
      identity = received
      log.info('supervisor identity received', { role: options.role, ...received })
      for (const listener of identityListeners) listener(received)
      return
    }
    log.info('supervisor asked us to stop', { role: options.role, reason: message.reason })
    for (const listener of stopListeners) listener(message.reason)
  }
  const stopHeartbeat = scheduler.every(options.heartbeatMs ?? LIFECYCLE_HEARTBEAT_MS, () => {
    send({ type: 'heartbeat' })
  })
  const close = (): void => {
    if (closed) return
    closed = true
    stopHeartbeat()
    transport.removeListener('message', onMessage)
    transport.removeListener('disconnect', onDisconnect)
  }
  const onDisconnect = (): void => {
    // Whatever the seam says, there is nobody left to heartbeat to.
    close()
    if (deathSignal !== 'disconnect' || goneFired) return
    goneFired = true
    log.warn('supervisor channel closed — treating the supervisor as gone', { role: options.role })
    for (const listener of goneListeners) listener()
  }
  transport.on('message', onMessage)
  transport.on('disconnect', onDisconnect)

  return {
    ready: (extra = {}) =>
      send({
        type: 'ready',
        role: options.role,
        pid,
        version: options.version,
        ...(options.digest !== undefined ? { digest: options.digest } : {}),
        ...(extra.port !== undefined ? { port: extra.port } : {}),
      }),
    degraded: (reason) => send({ type: 'degraded', reason }),
    stopping: (reason) => send({ type: 'stopping', reason }),
    identity: () => identity,
    onIdentity: (listener) => {
      identityListeners.push(listener)
    },
    onStop: (listener) => {
      stopListeners.push(listener)
    },
    onSupervisorGone: (listener) => {
      goneListeners.push(listener)
    },
    close,
  }
}

/**
 * A copy of `env` with the runtime's channel-descriptor variable removed, for
 * any spawn that must not reach the supervisor: every grandchild. Bun sets no
 * such variable, so under the compiled binary this is a no-op by construction;
 * under Node it is the difference between a contained agent session and one
 * that can write `ready` to the supervisor.
 */
export function withoutLifecycleChannel<T extends Record<string, string | undefined>>(env: T): T {
  const copy = { ...env }
  delete copy[NODE_CHANNEL_FD_ENV]
  return copy
}
