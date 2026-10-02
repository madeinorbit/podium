/** Web storage and cross-tab adapters for the shared replica assembly. */
import type { CreateEngineOutbox, CreateReplicaForPrincipal } from '@podium/client-core/engine'
import type { ClientPrincipal } from '@podium/client-core/principal'
import { parseReplicaNamespaceKey, retainReplicaEntity } from '@podium/client-core/replica'
import { openReplicaAssembly } from '@podium/client-core/replica-assembly'
import type { FeedServerFrame, FeedSinkPort } from '@podium/client-core/socket-transport'
import { createLogger } from '@podium/logger'
import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import type { LegacyIdentityEvidence } from '@podium/sync/adapters/legacy-replica'
import type { Trpc } from '@/app/trpc'
import { type SyncProgressStore, WebSyncProgressStore } from './sync-progress'
import { workspaceFetch } from './workspace-request'

export type { OutboxMigrationSummary as WebOutboxMigrationSummary } from '@podium/client-core/replica-assembly'
export { sideCacheQueueAsLegacy, summarizeMigrations } from '@podium/client-core/replica-assembly'

const log = createLogger('web:kernel-replica')
export const KERNEL_REPLICA_DB = 'podium-kernel-replica'
export const KERNEL_SIDE_CACHE_PREFIX = 'podium.kernel-replica'

export interface KernelAssembly {
  /** WHOSE ASSEMBLY THIS IS. The whole thing — IndexedDB region, side cache,
   *  outbox, cursor — was opened for exactly this principal and can serve no
   *  other (POD-404). */
  readonly principal: ClientPrincipal
  /**
   * Handed to the provider; called once, WITH the principal it is building for.
   *
   * It refuses rather than answers when that principal is not the one this
   * assembly was opened for. A silent answer would hand one person's slice and
   * cursor to another — the exact cross-principal adoption the namespace exists
   * to prevent — and the failure would be invisible, because a wrong slice
   * renders like a slice.
   */
  readonly createReplicaFn: CreateReplicaForPrincipal
  /** Handed to the engine; makes its hub advertise wire 2. */
  readonly feed: FeedSinkPort
  /** Real kernel Outbox over this assembly's IndexedDB store. */
  readonly createOutboxFn: CreateEngineOutbox
  readonly store: IndexedDbSyncStore
  /** HTTP receive counts and durable replica events, observed by cold and warm UI. */
  readonly progress: SyncProgressStore
  /** Fail-closed sign-out: erase this principal's IDB and side-cache namespace. */
  erasePrincipalData(): Promise<void>
  dispose(): Promise<void>
}

export interface OpenKernelAssemblyOptions {
  readonly trpc: Trpc
  readonly httpOrigin?: string
  readonly databaseName?: string
  readonly principal: string
  /** Injected by tests (fake-indexeddb); defaults to the browser's. */
  readonly factory?: IdbFactoryLike
  /** Surfaced rather than swallowed (ADR 6 D4). */
  readonly onDegraded?: (detail: unknown) => void
  /** Identity evidence for the pre-namespace legacy-adoption gate. The web boot
   * root derives multi-user evidence from existing principal namespace markers;
   * tests can inject unknown/foreign evidence to exercise fail-closed refusal. */
  readonly evidence: LegacyIdentityEvidence
  /** Test seam for the browser's same-origin cross-tab channel. */
  readonly broadcastChannelFactory?: (name: string) => KernelBroadcastChannel
}

export interface KernelBroadcastChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: unknown): void
  close(): void
}

type CrossTabFeedFrame = Extract<FeedServerFrame, { type: 'feedDelta' | 'feedRescope' }>

interface CrossTabFeedMessage {
  readonly kind: 'podium-kernel-feed'
  readonly version: 1
  readonly principal: string
  readonly frame: CrossTabFeedFrame
}

const CROSS_TAB_SEEN_LIMIT = 512

function crossTabFrameKey(frame: CrossTabFeedFrame): string {
  return frame.type === 'feedDelta'
    ? `${frame.type}\0${frame.feedId}\0${frame.epoch}\0${frame.fromSeq}\0${frame.seq}`
    : `${frame.type}\0${frame.feedId}\0${frame.epoch}\0${frame.seq}`
}

function isCrossTabFeedMessage(value: unknown, principal: string): value is CrossTabFeedMessage {
  if (value === null || typeof value !== 'object') return false
  const message = value as Partial<CrossTabFeedMessage>
  if (
    message.kind !== 'podium-kernel-feed' ||
    message.version !== 1 ||
    message.principal !== principal ||
    message.frame === null ||
    typeof message.frame !== 'object'
  ) {
    return false
  }
  return message.frame.type === 'feedDelta' || message.frame.type === 'feedRescope'
}

export async function openKernelAssembly(
  options: OpenKernelAssemblyOptions,
): Promise<KernelAssembly> {
  if (!parseReplicaNamespaceKey(options.principal))
    throw new Error('replica requires a server-authored boundary and member')
  const databaseName = options.databaseName ?? KERNEL_REPLICA_DB
  const assembly = await openReplicaAssembly({
    api: options.trpc,
    principal: options.principal,
    evidence: options.evidence,
    openStore: (onDegraded) =>
      IndexedDbSyncStore.open({
        factory: options.factory ?? (globalThis.indexedDB as unknown as IdbFactoryLike),
        databaseName,
        retainEntity: retainReplicaEntity,
        onDegraded,
      }),
    settings: {
      storage: globalThis.localStorage,
      enumerateKeys: () => Object.keys(globalThis.localStorage),
      storageEventApi: globalThis.window,
      basePrefix: KERNEL_SIDE_CACHE_PREFIX,
    },
    httpSync: {
      origin: options.httpOrigin ?? '',
      streamingFetch: { fetch: workspaceFetch, credentials: 'include' },
    },
    onDegraded: (detail) => {
      options.onDegraded?.(detail)
      log.warn('kernel replica degradation', { detail })
    },
    onAuthExpired: () => window.dispatchEvent(new Event('podium:sync-auth-expired')),
    createProgress: (now) => new WebSyncProgressStore(now),
  })
  let stopped = false
  const createBroadcastChannel =
    options.broadcastChannelFactory ??
    (typeof globalThis.BroadcastChannel === 'function'
      ? (name: string) => new globalThis.BroadcastChannel(name)
      : undefined)
  let crossTab: KernelBroadcastChannel | undefined
  try {
    crossTab = createBroadcastChannel?.(`podium.kernel-replica.feed.v1:${databaseName}`)
  } catch (error) {
    await assembly.dispose()
    throw error
  }
  const seenFrames = new Map<string, undefined>()
  const remember = (key: string): boolean => {
    if (seenFrames.has(key)) return false
    seenFrames.set(key, undefined)
    if (seenFrames.size > CROSS_TAB_SEEN_LIMIT) {
      const oldest = seenFrames.keys().next().value
      if (oldest !== undefined) seenFrames.delete(oldest)
    }
    return true
  }
  const relayFrame = (frame: FeedServerFrame, fromSocket: boolean): void => {
    // HTTP snapshots never enter this relay. Socket bootstrap and resync
    // frames belong to this exact tab's state-machine walk. Ordered deltas and rescopes are the shared client-install
    // convergence path: either can advance the durable cursor before another
    // tab's socket delivery reaches its in-memory replica.
    if (frame.type !== 'feedDelta' && frame.type !== 'feedRescope') {
      if (fromSocket) {
        assembly.feed.frame(frame)
      }
      return
    }
    const key = crossTabFrameKey(frame)
    if (!remember(key)) return
    assembly.feed.frame(frame)
    if (fromSocket) {
      crossTab?.postMessage({
        kind: 'podium-kernel-feed',
        version: 1,
        principal: options.principal,
        frame,
      } satisfies CrossTabFeedMessage)
    }
  }
  if (crossTab !== undefined) {
    crossTab.onmessage = (event) => {
      if (isCrossTabFeedMessage(event.data, options.principal)) relayFrame(event.data.frame, false)
    }
  }
  const feed: FeedSinkPort = {
    // Straight through, both of them: the hub reads the position it sends and
    // reports back what that bought (POD-2061), and this assembly has no
    // business between the two — a cursor rewritten here would be a position
    // nothing in the replica holds.
    syncHttp: true,
    requestRebootstrap: () => {
      if (!stopped) assembly.feed.requestRebootstrap?.()
    },
    helloFields: () => assembly.feed.helloFields(),
    connected: (worldPromised) => {
      if (!stopped) assembly.feed.connected(worldPromised)
    },
    disconnected: () => assembly.feed.disconnected(),
    frame: (frame) => {
      if (!stopped) relayFrame(frame, true)
    },
  }

  return {
    ...assembly,
    feed,
    erasePrincipalData: async () => {
      stopped = true
      crossTab?.close()
      await assembly.erasePrincipalData()
    },
    dispose: async () => {
      stopped = true
      crossTab?.close()
      await assembly.dispose()
    },
  }
}
