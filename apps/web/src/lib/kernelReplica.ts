/** Web storage and cross-tab adapters for the shared replica assembly. */
import type { CreateEngineOutbox, CreateReplicaForPrincipal } from '@podium/client-core/engine'
import {
  browserFeedChannel,
  createFeedRelay,
  type FeedBroadcastChannel,
} from '@podium/client-core/live-connection'
import { type ClientPrincipal, memberFencedFetch } from '@podium/client-core/principal'
import { parseReplicaNamespaceKey, retainReplicaEntity } from '@podium/client-core/replica'
import type {
  LegacyIdentityEvidence,
  TranscriptDatabases,
} from '@podium/client-core/replica-assembly'
import { openReplicaAssembly } from '@podium/client-core/replica-assembly'
import type { FeedSinkPort } from '@podium/client-core/socket-transport'
import {
  openIndexedDbTranscriptBackend,
  type TranscriptIdbFactory,
  type TranscriptIdbKeyRange,
} from '@podium/client-core/transcript-store'
import { createLogger } from '@podium/logger'
import { type IdbFactoryLike, IndexedDbSyncStore } from '@podium/sync/adapters/indexeddb'
import type { Trpc } from '@/app/trpc'
import { expireSignedInRuntime } from './account-context'
import { type SyncProgressStore, WebSyncProgressStore } from './sync-progress'
import { workspaceFetch } from './workspace-request'

const log = createLogger('web:kernel-replica')
export const KERNEL_REPLICA_DB = 'podium-kernel-replica'
export const KERNEL_SIDE_CACHE_PREFIX = 'podium.kernel-replica'
const PERSIST_ASKED_KEY = 'podium.storage-persist-asked'

/** Chat history's own database for one user (POD-5801) — never `podium-kernel-replica`. */
export function transcriptDatabaseName(principal: string): string {
  return `podium-transcripts:${encodeURIComponent(principal)}`
}

/** Delete one user's chat history database. Resolves when it is gone. */
export function eraseTranscriptDatabase(
  principal: string,
  factory: IdbFactoryLike = globalThis.indexedDB as unknown as IdbFactoryLike,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(transcriptDatabaseName(principal))
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export function webTranscriptDatabases(
  factory: IdbFactoryLike = globalThis.indexedDB as unknown as IdbFactoryLike,
  keyRange: TranscriptIdbKeyRange = (globalThis as unknown as { IDBKeyRange: TranscriptIdbKeyRange })
    .IDBKeyRange,
): TranscriptDatabases {
  return {
    open: (principal) =>
      openIndexedDbTranscriptBackend({
        factory: factory as unknown as TranscriptIdbFactory,
        keyRange,
        databaseName: transcriptDatabaseName(principal),
      }),
    erase: (principal) => eraseTranscriptDatabase(principal, factory),
  }
}

/**
 * Ask the browser, once per browser profile, to keep this site's storage when
 * the device runs short of space. The browser counts every database of a site
 * together and would otherwise clear all of them at once; the 10 MB chat budget
 * itself is far below any site quota. Electron and the phone never evict.
 */
function askForPersistentStorageOnce(): void {
  try {
    if (globalThis.localStorage.getItem(PERSIST_ASKED_KEY) !== null) return
    const storage = (globalThis.navigator as { storage?: { persist?: () => Promise<boolean> } })
      ?.storage
    if (typeof storage?.persist !== 'function') return
    globalThis.localStorage.setItem(PERSIST_ASKED_KEY, '1')
    void storage.persist().catch(() => {})
  } catch {
    // A refused request leaves the default (best-effort) storage.
  }
}

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
  /** Chat history databases; defaults to IndexedDB over `factory`. */
  readonly transcripts?: TranscriptDatabases
}

export type KernelBroadcastChannel = FeedBroadcastChannel

export async function openKernelAssembly(
  options: OpenKernelAssemblyOptions,
): Promise<KernelAssembly> {
  const identity = parseReplicaNamespaceKey(options.principal)
  if (!identity) throw new Error('replica requires a server-authored boundary and member')
  const databaseName = options.databaseName ?? KERNEL_REPLICA_DB
  askForPersistentStorageOnce()
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
      // The member fence (POD-6292): the feed this assembly stores is only ever
      // read as the member it was opened for.
      streamingFetch: {
        fetch: memberFencedFetch(workspaceFetch, identity.memberId),
        credentials: 'include',
      },
    },
    onDegraded: (detail) => {
      options.onDegraded?.(detail)
      log.warn('kernel replica degradation', { detail })
    },
    transcripts: options.transcripts ?? webTranscriptDatabases(options.factory),
    onAuthExpired: () => expireSignedInRuntime(options.principal),
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
