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
 *                    control-request {requestId, request}
 *   parent → child   identity {generation, machineId?, assignment?} at connect
 *                    stop {reason} · control-result {requestId, result}
 * Fleet-plane facts (grants, update status, presence, build) stay on /machine.
 *
 * REPORTS FLOW UP; ONE PAIR OF FRAMES FLOWS BOTH WAYS. `control-request` is a
 * child ASKING its supervisor to swap the bundle, hand over, or change which
 * children run — the asks that used to be a file plus a signal to a pid read off
 * disk (POD-3763). Its answer comes back on the same line as `control-result`,
 * correlated by `requestId`; there is deliberately no second transport and no
 * timeout, because a supervisor that dies mid-request closes the line and the
 * close rejects every request still in flight. The bodies stay opaque here —
 * parent-control.ts owns those shapes, and the transport should not have to know
 * what an update target is.
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
 * SUPERVISOR DEATH. Channel close means the supervisor is gone, on every
 * platform: Linux and macOS see `'disconnect'` 9-23 ms after the parent dies
 * (POD-3760), and Windows sees it at +20/19 ms (POD-3774) PROVIDED the child
 * was spawned detached. It is the spawn flag, not the platform, that used to
 * make Windows different — an attached Windows child is killed within ~250 ms
 * of the process that spawned it exiting, so it was already dead when the
 * disconnect would have arrived. `detachSupervisedChild` in parent-process.ts
 * sets that flag (POD-3790), and this module's contract rests on it.
 */
import { createLogger } from '@podium/logger'
import { z } from 'zod'
import { type ParentControlLink, parentControlLink, setParentControlLink } from './parent-control'
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
  z.object({
    type: z.literal('control-request'),
    /** Correlates this ask with the one `control-result` that answers it. */
    requestId: z.string().min(1),
    /** A `ParentRequest`. Opaque here on purpose — see the header. */
    request: z.record(z.unknown()),
  }),
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
  z.object({
    type: z.literal('control-result'),
    requestId: z.string().min(1),
    /** A `ParentResult`. Opaque here on purpose — see the header. */
    result: z.record(z.unknown()),
  }),
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
  /**
   * Method syntax on purpose: `ChildProcess.send` takes `Serializable`, and our
   * frames are objects. The callback is the FLUSH: it fires once the frame has
   * left this process, which is what lets a child report a control request as
   * posted even though the next thing that happens to it is being replaced.
   */
  send?(message: object, callback?: (error: Error | null) => void): boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'disconnect', listener: () => void): unknown
  removeListener(event: 'message', listener: (message: unknown) => void): unknown
  removeListener(event: 'disconnect', listener: () => void): unknown
}

function hasChannel(peer: ChannelPeer): boolean {
  return typeof peer.send === 'function' && peer.connected !== false
}

/** Send one frame; a closed pipe is a `false`, never a throw into the caller. */
function trySend(
  peer: ChannelPeer,
  frame: object,
  onFlush?: (error: Error | null) => void,
): boolean {
  const send = peer.send
  if (typeof send !== 'function' || peer.connected === false) return false
  try {
    return send.call(peer, frame, onFlush) !== false
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
  /**
   * Record that the line is gone, for a caller that learns it some other way.
   * `disconnect` is NOT ordered against the child's `exit`: when `exit` wins,
   * the owner detaches this channel before `disconnect` is ever delivered, and
   * a report left saying `open` would outlive the child forever. Idempotent, so
   * whichever of the two arrives first is the one that dates the close.
   */
  close(): void
  /** Stop listening. The pipe itself closes with the process. */
  detach(): void
}

export interface AttachChildChannelOptions {
  identity: ParentIdentity
  now?: () => number
  /** Every change to the report, for the parent to fold into its snapshot. */
  onReport?: (report: ChildLifecycleReport) => void
  onMessage?: (message: ChildMessage) => void
  /**
   * This child ASKING the supervisor to do something (POD-3763). `respond` puts
   * the answer back on this child's own line, correlated for the caller; it
   * returns `false` when the line has since closed, and may be left uncalled for
   * a request that has no answer (a handover replaces the asking process). A
   * supervisor that declares no handler simply never hears the ask, which is the
   * right behaviour for a parent built without an update-swap capability.
   */
  onControlRequest?: (
    request: Record<string, unknown>,
    respond: (result: Record<string, unknown>) => boolean,
  ) => void
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
    return { report: () => report, stop: () => false, close: () => {}, detach: () => {} }
  }
  let report: ChildLifecycleReport = { channel: 'open' }
  const update = (next: ChildLifecycleReport): void => {
    report = next
    options.onReport?.(report)
  }
  const onMessage = (raw: unknown): void => {
    const message = decodeChildMessage(raw)
    if (!message) return
    if (message.type === 'control-request') {
      // NOT a lifecycle report: it changes nothing about how this child is
      // doing, so it never touches `report`. It is an ask, and the only thing
      // owed back is the answer.
      const { requestId } = message
      options.onControlRequest?.(message.request, (result) =>
        trySend(peer, encodeLifecycle({ type: 'control-result', requestId, result })),
      )
      return
    }
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
  const close = (): void => {
    if (report.channel !== 'open') return
    update({ ...report, channel: 'closed', closedAtMs: now() })
  }
  const onDisconnect = (): void => close()
  peer.on('message', onMessage)
  peer.on('disconnect', onDisconnect)
  trySend(peer, encodeLifecycle({ type: 'identity', ...options.identity }))
  return {
    report: () => report,
    stop: (reason) =>
      report.channel === 'open' && trySend(peer, encodeLifecycle({ type: 'stop', reason })),
    close,
    detach: () => {
      peer.removeListener('message', onMessage)
      peer.removeListener('disconnect', onDisconnect)
    },
  }
}

// ---------------------------------------------------------------------------
// Child end
// ---------------------------------------------------------------------------

export interface LifecycleClient {
  ready(extra?: { port?: number }): boolean
  degraded(reason: string): boolean
  stopping(reason: string): boolean
  /** True while this process still holds its line to the supervisor that spawned it. */
  open(): boolean
  /**
   * Ask the supervisor for something and DO NOT wait for an answer. Resolves
   * when the frame has flushed out of this process — which is the strongest
   * thing a handover can be told, because succeeding at a handover means this
   * process is replaced and there is nobody left to answer. Rejects when the
   * line will not take the frame.
   */
  postControl(requestId: string, request: Record<string, unknown>): Promise<void>
  /**
   * Ask the supervisor for something and wait for its answer on this same line.
   * There is no timeout on purpose: a supervisor that dies mid-request closes
   * the line, and the close rejects this promise at once (POD-3790/POD-3793 made
   * that close uniform and trustworthy on every platform).
   */
  requestControl(
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  /** The parent's identity, once it has arrived. */
  identity(): ParentIdentity | undefined
  onIdentity(listener: (identity: ParentIdentity) => void): void
  onStop(listener: (reason: string) => void): void
  /** Fires at most once. */
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
  const pid = options.pid ?? process.pid
  let identity: ParentIdentity | undefined
  const identityListeners: Array<(identity: ParentIdentity) => void> = []
  const stopListeners: Array<(reason: string) => void> = []
  const goneListeners: Array<() => void> = []
  let closed = false
  let goneFired = false
  /** In-flight control requests, by id. A close rejects every one of them. */
  const pending = new Map<
    string,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >()

  const send = (message: ChildMessage): boolean => trySend(transport, encodeLifecycle(message))

  const onMessage = (raw: unknown): void => {
    const message = decodeParentMessage(raw)
    if (!message) return
    if (message.type === 'control-result') {
      const waiter = pending.get(message.requestId)
      // An answer to a request this process is not waiting for is not an error
      // worth throwing: a retried supervisor, or an ask already rejected by a
      // close, both land here and both are simply nothing left to do.
      if (!waiter) return
      pending.delete(message.requestId)
      waiter.resolve(message.result)
      return
    }
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
    // Only if this process's link is still ours: a later `connect` (a test
    // sharing one process across cases) has replaced it, and clearing it then
    // would take away a line that is still open.
    if (parentControlLink() === link) setParentControlLink(undefined)
    // THE CLOSE IS THE FAILURE SIGNAL. Every ask still waiting is answered now,
    // with the reason, rather than waiting for a reply that cannot come.
    for (const [, waiter] of [...pending]) {
      waiter.reject(new Error('the supervising parent closed the line before answering'))
    }
    pending.clear()
  }
  const onDisconnect = (): void => {
    // There is nobody left to heartbeat to.
    close()
    if (goneFired) return
    goneFired = true
    log.warn('supervisor channel closed — treating the supervisor as gone', { role: options.role })
    for (const listener of goneListeners) listener()
  }
  transport.on('message', onMessage)
  transport.on('disconnect', onDisconnect)

  const open = (): boolean => !closed && transport.connected !== false

  const postControl = (requestId: string, request: Record<string, unknown>): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!open()) {
        reject(new Error('there is no open line to a supervising parent'))
        return
      }
      const accepted = trySend(
        transport,
        encodeLifecycle({ type: 'control-request', requestId, request }),
        (error) => (error ? reject(error) : resolve()),
      )
      if (!accepted) reject(new Error('the line to the supervising parent refused the request'))
    })

  const requestControl = async (
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
    })
    try {
      await postControl(requestId, request)
    } catch (error) {
      pending.delete(requestId)
      throw error
    }
    return await answer
  }

  const link: ParentControlLink = { open, post: postControl, request: requestControl }
  /**
   * THIS PROCESS'S ONE LINE TO ITS SUPERVISOR, where the code that asks can
   * reach it. `parent-control.ts` is called from deep inside the server's update
   * step and the daemon's grant runner, neither of which is handed the client;
   * threading it through every one of those signatures would be a wide change to
   * say a thing that is true process-wide — a process has exactly one supervisor.
   */
  setParentControlLink(link)

  return {
    open,
    postControl,
    requestControl,
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
