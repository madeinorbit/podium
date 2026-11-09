/**
 * THE RUNTIME ROOT (POD-6681; detailed design 2.1).
 *
 * One object per signed-in user. It is created at sign-in, for ONE principal,
 * and disposed at sign-out; a different person is a new root over a new
 * replica, socket and queue, never a reset of this one. It holds:
 *
 * - the principal it serves;
 * - the replica opened for that principal (the platform's composition root
 *   builds it, and must refuse a principal it did not open for);
 * - the LiveStore (POD-5798) and the frame queue its writers share;
 * - the conversation cache;
 * - the services: `connection` (the socket, `./connection/`), `outbox` (the
 *   queue of unsent writes, `./outbox/`) and `topics` (the live feed).
 *
 * Services are never visible to components: React gets the root through
 * `RuntimeProvider`, and `useRuntime()` hands components only models and
 * readings (react/runtime-root.tsx).
 *
 * LIFECYCLE. `start()` arms the services and is idempotent. `stop()` releases
 * what `start()` armed and is reversible: it is React's effect cleanup, and a
 * StrictMode remount calls `start()` again on the same root without starting
 * anything twice. `dispose()` is the sign-out and irreversible: afterwards no
 * service writes a reading, reports an outcome or dials again.
 *
 * Until POD-5803 deletes the old store, `engine/runtime.ts` constructs the root
 * (`createClientRuntime`), drives this lifecycle, and its façade's `hub`,
 * `trpc`, `replica`, `httpOrigin` and `outbox` members read from here.
 */

import type { PodiumClientApi } from '../api'
import { ConversationCache, type ConversationCacheOptions } from '../conversation/cache'
import type { StoreNotices, StoreServerConfig } from '../engine/types'
import { LiveFrameQueue } from '../live/frame-queue'
import { LiveFeed } from '../live/live-feed'
import { LiveStore } from '../live/live-store'
import type { OnlineEvents } from '../outbox'
import { type ClientPrincipal, memberFencedSocketUrl } from '../principal'
import type { Replica } from '../replica/kernel/facade'
import type { FeedSinkPort, SocketHubOptions } from '../socket-transport'
import { ConnectionService } from './connection/connection-service'
import type { CreateHub } from './connection/hub'
import type { VisibilitySource } from './connection/visibility'
import { OutboxService } from './outbox/outbox-service'
import type { CreateEngineOutbox } from './outbox/wiring'

/**
 * The replica factory, PARAMETERIZED BY PRINCIPAL.
 *
 * It takes the principal rather than closing over one so that the question
 * "whose store is this?" is asked at every construction, by the composition root
 * that can actually answer it (POD-1239 established the root; POD-404 makes the
 * principal an argument to it). A root handed a principal it did not open for
 * must THROW rather than return the store it has — refusing is the fail-closed
 * answer; returning someone else's slice is the failure this whole seam exists
 * to make impossible.
 */
export type CreateReplicaForPrincipal = (principal: ClientPrincipal) => Replica

export interface RuntimeRootInit<TApi extends PodiumClientApi = PodiumClientApi> {
  /**
   * WHOSE CLIENT THIS IS. Supplied by the provider from the authenticated
   * transport (ADR 3 D7) — never from the URL, storage, a payload or a name the
   * user typed. See `src/principal.ts`.
   */
  principal: ClientPrincipal
  config: StoreServerConfig
  /** The app's typed tRPC client (web: AppRouter-typed; mobile: MobileTrpc). */
  api: TApi
  onFatalError: (message: string) => void
  /** App-flavored error formatting (web: formatAppError). */
  formatError: (error: unknown, fallback: string) => string
  /** UI notices (web: sonner toasts). */
  notices: StoreNotices
  /**
   * Replica factory — mobile injects the AsyncStorage-backed one, web the
   * IndexedDB kernel assembly. Called ONCE, with this root's principal.
   *
   * REQUIRED since POD-1239: a client that can build its own replica is a
   * construction site outside every composition root, and the flag-off browser
   * client used to adopt whatever ambient `localStorage` held.
   */
  createReplicaFn: CreateReplicaForPrincipal
  /** Test seam: replaces SocketHub construction (unit tests inject a fake). */
  createHub?: CreateHub
  /**
   * WIRE v2 / kernel replica (POD-1223). Supplied together with a
   * `createReplicaFn` that returns the kernel-backed facade: the platform layer
   * builds the whole assembly (store, kernel Replica, feed sink) for ONE
   * principal and hands the root its two ends. Absent ⇒ the shipped v1 path.
   */
  feed?: FeedSinkPort
  /** Platform queue factory. Web injects the real kernel Outbox opened over IndexedDB. */
  createOutboxFn?: CreateEngineOutbox
  /**
   * PLATFORM SEAMS (POD-2055 WP-C). Each has a browser default and each of
   * those defaults is wrong on React Native, where `document` is missing,
   * `window` has no DOM events and `navigator.onLine` does not exist. The
   * composition root that knows the platform supplies the real ones.
   */
  /** Where visibility comes from. Default: `document.visibilityState`. */
  visibility?: VisibilitySource
  /** Connectivity transitions for the outbox. Default: the window's `online`. */
  onlineEvents?: OnlineEvents
  /** Connectivity probe for the outbox. Default: `navigator.onLine`. */
  isOnline?: () => boolean
  /** Liveness ping cadence. Default: the hub's own (2.5 s). Native passes 10 s. */
  heartbeatIntervalMs?: number
  /** Login carriage supplied by the authenticated platform owner. */
  makeSocket?: SocketHubOptions['makeSocket']
  /** Open the local runtime without contacting the configured authority. */
  networkEnabled?: boolean
}

/** The root's services. None of them is visible to components. */
export interface RuntimeServices {
  readonly connection: ConnectionService
  readonly outbox: OutboxService
  readonly topics: LiveFeed
}

export class RuntimeRoot<TApi extends PodiumClientApi = PodiumClientApi> {
  /** The one principal this root serves. Read-only for its whole lifetime. */
  readonly principal: ClientPrincipal
  /** The app's typed tRPC client. */
  readonly api: TApi
  readonly httpOrigin: string
  /** The replica opened for {@link principal}. */
  readonly replica: Replica
  /**
   * THE LIVESTORE (POD-5798): this user's conditions (connection, machine online
   * and load, quota and usage, unsent writes). Never saved; disposed at
   * sign-out. Models and screens read it; only the services write it.
   */
  readonly live: LiveStore
  readonly services: RuntimeServices

  private readonly frames: LiveFrameQueue
  private readonly networkEnabled: boolean
  private conversationCache: ConversationCache | undefined
  private started = false
  private disposed = false

  constructor(init: RuntimeRootInit<TApi>) {
    this.principal = init.principal
    this.api = init.api
    this.httpOrigin = init.config.httpOrigin
    this.networkEnabled = init.networkEnabled ?? true
    // The runtime type is only half the guard — an untyped caller omitting the
    // factory must fail LOUDLY here rather than quietly adopt ambient storage.
    if (typeof init.createReplicaFn !== 'function') {
      throw new Error(
        'a client runtime requires createReplicaFn: the platform composition root builds the ' +
          'replica for a NAMED principal and is responsible for establishing that its persisted ' +
          'store belongs to that principal (POD-307 / POD-1239 / POD-404).',
      )
    }
    // Persistent local replica (docs/spec/thin-client-replica.md), opened for
    // THIS principal. Constructed synchronously so its persisted cursor can seed
    // the hub's first changesSince; entity hydration happens async in start().
    this.replica = init.createReplicaFn(init.principal)
    this.frames = new LiveFrameQueue()
    // The store's metrics demand reaches the feed it was built before.
    let topics: LiveFeed | undefined
    this.live = new LiveStore({
      onMetricsDemand: (id, watched) => topics?.watchMetrics(id, watched),
      onUsageDemand: (watched) => topics?.watchUsage(watched),
    })
    const connection = new ConnectionService({
      // The member fence (POD-6292): this socket is this principal's, and the
      // server refuses it if the shared cookie jar now holds someone else's.
      wsClientUrl: memberFencedSocketUrl(init.config.wsClientUrl, init.principal.userId),
      api: init.api,
      replica: this.replica,
      live: this.live,
      frames: this.frames,
      onFatalError: (m) => init.onFatalError(m),
      formatError: (e, f) => init.formatError(e, f),
      networkEnabled: this.networkEnabled,
      ...(init.visibility !== undefined ? { visibility: init.visibility } : {}),
      ...(init.createHub !== undefined ? { createHub: init.createHub } : {}),
      ...(init.feed !== undefined ? { feed: init.feed } : {}),
      ...(init.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: init.heartbeatIntervalMs }
        : {}),
      ...(init.makeSocket !== undefined ? { makeSocket: init.makeSocket } : {}),
    })
    const replica = this.replica
    topics = new LiveFeed({
      hub: connection.hub,
      // The machines whose condition is held: the `machine` records (POD-6644).
      machines: {
        ids: () => replica.rows('machines').map((machine) => String(machine.id)),
        subscribe: (changed) =>
          replica.subscribeAddressedBatch?.((batch) => {
            if (batch.type === 'replace' || batch.rows.some((row) => row.kind === 'machines')) {
              changed()
            }
          }) ?? (() => {}),
      },
      live: this.live,
      userId: init.principal.userId,
      frames: this.frames,
    })
    const outbox = new OutboxService({
      api: init.api,
      replica: this.replica,
      live: this.live,
      frames: this.frames,
      notices: init.notices,
      connection,
      networkEnabled: this.networkEnabled,
      ...(init.createOutboxFn !== undefined ? { createOutboxFn: init.createOutboxFn } : {}),
      ...(init.onlineEvents !== undefined ? { onlineEvents: init.onlineEvents } : {}),
      ...(init.isOnline !== undefined ? { isOnline: init.isOnline } : {}),
    })
    this.services = { connection, outbox, topics }
  }

  /** The conversation cache, once the pool supplied its ports; undefined before. */
  get conversations(): ConversationCache | undefined {
    return this.conversationCache
  }

  /** The provider supplies addressed pool ports once, for this principal. */
  readonly ownConversations = (options: ConversationCacheOptions): ConversationCache => {
    if (this.disposed) throw new Error('The conversation owner has changed')
    this.conversationCache ??= new ConversationCache(options)
    return this.conversationCache
  }

  /**
   * The first step of sign-out: the conversations go before anything else the
   * user's session holds. {@link dispose} calls it too; the old store calls it
   * first so its own teardown keeps its order (POD-5803 folds the two).
   */
  releaseConversations(): void {
    this.conversationCache?.dispose()
    this.conversationCache = undefined
  }

  /**
   * Arm the services: the queue follows its counts and starts draining, the
   * topics follow the server, and the socket dials. Idempotent; re-arms after
   * {@link stop}. A disposed root never starts again: its principal is gone.
   */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    const { connection, outbox, topics } = this.services
    outbox.start()
    // A root without network has no topics, so every reading stays unknown (and
    // a fixture may write them itself). The outbox counts reach the store either way.
    if (this.networkEnabled) topics.start()
    connection.start()
  }

  /** Release what {@link start} armed: topics, the queue's drain and the socket.
   *  Reversible (React's effect cleanup; StrictMode re-starts the same root). */
  stop(): void {
    this.started = false
    const { connection, outbox, topics } = this.services
    topics.stop()
    outbox.stop()
    connection.stop()
  }

  /**
   * THE SIGN-OUT. Irreversible. Stops every service, releases the
   * conversations, forgets every reading, and refuses to start again. The
   * replica stays open for the platform's assembly, which owns its storage.
   */
  async dispose(): Promise<void> {
    this.disposeNow()
  }

  /** The synchronous body of {@link dispose}, for the old store's synchronous destroy. */
  disposeNow(): void {
    if (this.disposed) return
    this.releaseConversations()
    this.stop()
    this.disposed = true
    const { connection, outbox, topics } = this.services
    outbox.dispose()
    topics.dispose()
    connection.dispose()
    this.frames.dispose()
    this.live.dispose()
  }

  get isDisposed(): boolean {
    return this.disposed
  }
}

/**
 * Construct the runtime root for ONE principal. Until POD-5803 its only caller
 * is `createClientRuntime` (engine/runtime.ts), which the provider calls; the
 * phase-2 client audit (item 5) fails on a second construction site.
 */
export function createRuntimeRoot<TApi extends PodiumClientApi = PodiumClientApi>(
  init: RuntimeRootInit<TApi>,
): RuntimeRoot<TApi> {
  return new RuntimeRoot(init)
}
