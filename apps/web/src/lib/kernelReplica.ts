/** Web storage and cross-tab adapters for the shared replica assembly. */
import type { CreateEngineOutbox, CreateReplicaForPrincipal } from '@podium/client-core/engine'
import {
  browserFeedChannel,
  createFeedRelay,
  type FeedBroadcastChannel,
} from '@podium/client-core/live-connection'
import type { ClientPrincipal } from '@podium/client-core/principal'
import { parseReplicaNamespaceKey, retainReplicaEntity } from '@podium/client-core/replica'
import { openReplicaAssembly } from '@podium/client-core/replica-assembly'
import type { FeedSinkPort } from '@podium/client-core/socket-transport'
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

export type KernelBroadcastChannel = FeedBroadcastChannel

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
  let relay: ReturnType<typeof createFeedRelay>
  try {
    relay = createFeedRelay(assembly.feed, {
      principal: options.principal,
      channelName: `podium.kernel-replica.feed.v1:${databaseName}`,
      createChannel: options.broadcastChannelFactory ?? browserFeedChannel(),
    })
  } catch (error) {
    await assembly.dispose()
    throw error
  }
  return {
    ...assembly,
    feed: relay.feed,
    erasePrincipalData: async () => {
      relay.dispose()
      await assembly.erasePrincipalData()
    },
    dispose: async () => {
      relay.dispose()
      await assembly.dispose()
    },
  }
}
