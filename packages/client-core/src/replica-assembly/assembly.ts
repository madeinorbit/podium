import { asUserId } from '@podium/model'
import type { OutboxStorePort } from '@podium/sync/outbox'
import {
  Replica as KernelReplica,
  type ReplicaCacheStore,
  type SyncUnitOfWork,
} from '@podium/sync/replica'
import type { PodiumClientApi } from '../api'
import { asClientPrincipal, type ClientPrincipal } from '../principal'
import {
  createKernelReplica,
  createSideCache,
  eraseLegacyTranscriptKeys,
  FeedSink,
  parseReplicaNamespaceKey,
  preparePrincipalNamespace,
  type Replica,
  type StorageApi,
} from '../replica'
import {
  type CreateEngineOutbox,
  type CreateReplicaForPrincipal,
  openKernelEngineOutbox,
} from '../runtime-root'
import type { FeedSinkPort } from '../socket-transport'
import {
  createSyncTransferTelemetry,
  HttpBootstrapSource,
  HttpDeltaSource,
  type HttpSyncSourceDeps,
  SyncAuthExpiredError,
  SyncCancelledError,
  SyncNetworkError,
} from '../sync-stream'
import {
  createStoreTranscriptCache,
  createTranscriptStore,
  type StoreTranscriptCache,
  type TranscriptStore,
  type TranscriptStoreBackend,
} from '../transcript-store'
import { decideLegacyAdoption, type LegacyIdentityEvidence } from './adoption'
import { ReplicaGateError } from './failure'
import { SyncProgressStore } from './progress'

export const STORE_REFRESH_NOTICE = 'Refreshing your data after the upgrade — this happens once.'

/** Both IndexedDbSyncStore and SqliteSyncStore implement this boundary. */
export interface ReplicaDataStore {
  viewFor(principal: string): { cache: ReplicaCacheStore; outbox: OutboxStorePort }
  erasePrincipal(principal: string): Promise<void>
  readonly unitOfWork: SyncUnitOfWork
  durability(): 'durable' | 'degraded-memory' | 'unavailable'
  settled(): Promise<void>
  close(): void
}

export interface ReplicaSettings {
  readonly storage: StorageApi
  readonly basePrefix: string
  enumerateKeys(): string[]
  /** Rejects if the bridge could not persist its writes. */
  flush?(): Promise<void>
  readonly storageEventApi?: Parameters<typeof createSideCache>[0]['storageEventApi']
}

export type ReplicaDegradation = { kind: 'store-not-adopted'; reason: string }

/**
 * Chat history's own database, per signed-in user (POD-5801): IndexedDB on web and
 * desktop, an expo-sqlite file on the phone. Never the entity store.
 */
export interface TranscriptDatabases {
  open(principal: string): Promise<TranscriptStoreBackend>
  /** Delete a user's database without opening it (sign-out, eviction). */
  erase(principal: string): Promise<void>
  /** Run the age/size sweep once the app is idle after startup. Defaults to a
   *  timer followed by `requestIdleCallback` where the host has one. */
  whenIdle?(run: () => void): () => void
}

export interface OpenReplicaAssemblyOptions<T extends ReplicaDataStore> {
  readonly openStore: (onDegraded: (detail: unknown) => void) => Promise<T>
  readonly settings: ReplicaSettings
  readonly api: PodiumClientApi
  readonly principal: string
  /** Compatibility callers can explicitly name the member of a legacy namespace. */
  readonly clientPrincipal?: string
  readonly evidence?: LegacyIdentityEvidence
  readonly httpSync: Pick<HttpSyncSourceDeps, 'origin' | 'streamingFetch'>
  readonly pendingPrincipalCleanups?: readonly { principal: string; complete(): Promise<void> }[]
  readonly onDegraded?: (detail: unknown) => void
  readonly onAuthExpired?: () => void
  readonly now?: () => number
  /** An app may keep its own event-to-phase mapping on the shared store. */
  readonly createProgress?: (now: () => number) => SyncProgressStore
  /** Absent: chats keep no history on the device and read the server. */
  readonly transcripts?: TranscriptDatabases
}

export interface ReplicaAssembly<T extends ReplicaDataStore = ReplicaDataStore> {
  readonly principal: ClientPrincipal
  readonly replica: Replica
  readonly createReplicaFn: CreateReplicaForPrincipal
  readonly feed: FeedSinkPort
  readonly createOutboxFn: CreateEngineOutbox
  readonly store: T
  readonly progress: SyncProgressStore
  /** This user's chat history store, when the host provides one. */
  readonly transcripts?: TranscriptStore
  settled(): Promise<void>
  erasePrincipalData(): Promise<void>
  dispose(): Promise<void>
}

export async function openReplicaAssembly<T extends ReplicaDataStore>(
  options: OpenReplicaAssemblyOptions<T>,
): Promise<ReplicaAssembly<T>> {
  const identity = parseReplicaNamespaceKey(options.principal)
  const memberId = identity?.memberId ?? options.clientPrincipal
  if (!memberId || (identity && options.clientPrincipal && options.clientPrincipal !== memberId)) {
    throw new ReplicaGateError('replica requires a server-authored boundary and member', {
      kind: 'account-missing',
    })
  }
  const now = options.now ?? Date.now
  const settings = options.settings
  const flushSettings = async (): Promise<void> => {
    try {
      await settings.flush?.()
    } catch (error) {
      throw storageFailure(error)
    }
  }
  let store: T
  let unavailableCause: unknown
  try {
    store = await options.openStore((detail) => {
      const report = detail as { mode?: unknown; error?: unknown }
      if (report?.mode === 'unavailable') unavailableCause = report.error
      options.onDegraded?.(detail)
    })
  } catch (error) {
    throw storageFailure(error)
  }
  let side: ReturnType<typeof createSideCache> | undefined
  let kernel: KernelReplica | undefined
  let transcriptStore: TranscriptStore | undefined
  let transcriptCache: StoreTranscriptCache | undefined
  try {
    const eraseTranscripts = (principal: string): Promise<void> =>
      principal === options.principal && transcriptStore
        ? transcriptStore.erase()
        : (options.transcripts?.erase(principal) ?? Promise.resolve())
    const erasePrincipal = async (
      namespace: { keyPrefix: string; erase(): void },
      principal: string,
    ): Promise<void> => {
      try {
        namespace.erase()
        await Promise.all([
          store.erasePrincipal(principal),
          eraseTranscripts(principal),
          flushSettings(),
        ])
        if (settings.enumerateKeys().some((key) => key.startsWith(`${namespace.keyPrefix}.`))) {
          throw new Error('principal settings could not be erased')
        }
      } catch (error) {
        throw storageFailure(error)
      }
    }
    // Private data requires durable storage before the engine may start.
    if (store.durability() !== 'durable')
      throw storageFailure(
        unavailableCause instanceof Error
          ? unavailableCause
          : 'private replica storage is unavailable',
      )
    for (const cleanup of options.pendingPrincipalCleanups ?? []) {
      const stale = preparePrincipalNamespace({
        ...settings,
        principal: cleanup.principal,
        now,
        policy: {
          signOut: 'erase',
          maxRetainedPrincipals: Number.MAX_SAFE_INTEGER,
          maxInactiveMs: Number.MAX_SAFE_INTEGER,
        },
      })
      await erasePrincipal(stale, cleanup.principal)
      await cleanup.complete()
    }
    const namespace = preparePrincipalNamespace({ ...settings, principal: options.principal, now })
    for (const stalePrincipal of namespace.evictedPrincipals) {
      await store.erasePrincipal(stalePrincipal)
      await eraseTranscripts(stalePrincipal)
    }
    // Chat history left the shared key space; its old keys go, unread.
    eraseLegacyTranscriptKeys(settings.storage, safeKeys(settings))
    if (!namespace.durable) throw storageFailure('principal namespace marker is unavailable')
    await flushSettings()
    settings.storage.removeItem('podium-kernel-identity-ledger')
    const view = store.viewFor(options.principal)
    const evidence: LegacyIdentityEvidence = options.evidence ?? {
      kind: 'multi-user',
      signedInAs: options.principal,
      identitiesEverSignedIn: namespace.knownPrincipals,
    }
    const adoption = decideLegacyAdoption(evidence, {
      kind: 'principal-scoped',
      writtenUnder: [options.principal],
    })
    if (!adoption.adopt) {
      view.cache.discardCache()
      options.onDegraded?.({
        kind: 'store-not-adopted',
        reason: adoption.reason,
      } satisfies ReplicaDegradation)
    }
    const createOutboxFn = await openKernelEngineOutbox({
      store: view.outbox,
      principal: memberId,
      api: options.api,
      now,
      onDegraded: (detail) => options.onDegraded?.(detail),
      // Late-bound: the replica is built below, after the queue it confirms.
      confirmedThrough: () => kernel?.cursor ?? null,
    })
    side = createSideCache({
      ...settings,
      keyPrefix: namespace.keyPrefix,
      adoptLegacyOutbox: false,
      onDegraded: options.onDegraded,
    })
    if (options.transcripts) {
      const databases = options.transcripts
      transcriptStore = createTranscriptStore({
        backend: databases.open(options.principal),
        now,
        deleteDatabase: () => databases.erase(options.principal),
        onDegraded: (detail) => options.onDegraded?.(detail),
      })
      transcriptCache = createStoreTranscriptCache(transcriptStore)
    }
    const facade = createKernelReplica({
      cache: view.cache,
      side,
      exits: (entity, entityId) => kernel?.exitKind(entity, entityId),
      ...(transcriptCache ? { transcripts: transcriptCache } : {}),
    })
    const cancelSweep = transcriptStore
      ? (options.transcripts?.whenIdle ?? whenIdleAfterStartup)(() => {
          void transcriptStore?.sweep()
        })
      : undefined
    const progress = options.createProgress?.(now) ?? new SyncProgressStore(now)
    let stopped = false
    let disposed = false
    let erased = false
    const reportFailure = (error: unknown): void => {
      if (error instanceof SyncCancelledError || stopped) return
      const kind =
        error instanceof SyncAuthExpiredError
          ? 'auth'
          : error instanceof SyncNetworkError
            ? 'network'
            : 'format'
      progress.noteError(kind, error instanceof Error ? error.message : String(error))
      if (kind !== 'network') {
        stopped = true
        kernel?.disconnect()
      }
      if (kind === 'auth') options.onAuthExpired?.()
    }
    const syncTelemetry = createSyncTransferTelemetry()
    const sourceDeps = {
      ...options.httpSync,
      onMeta: (totalRows: number | undefined) => progress.noteMeta(totalRows),
      onChunk: (rows: number, bytes: number) => progress.noteReceived(rows, bytes),
      telemetry: syncTelemetry,
    }
    const bootstraps = new HttpBootstrapSource(sourceDeps)
    const deltas = new HttpDeltaSource(sourceDeps)
    const replicaKernel = new KernelReplica({
      store: view.cache,
      authority: {
        async *bootstrap(signal) {
          progress.beginAttempt()
          try {
            for await (const chunk of bootstraps.bootstrap(signal)) {
              if (chunk.last) progress.noteSaving()
              yield chunk
            }
          } catch (error) {
            reportFailure(error)
            throw error
          }
        },
        async changesRange(cursor, signal, onTarget) {
          progress.beginAttempt()
          try {
            const range = await deltas.changesRange(cursor, signal, onTarget)
            if ('kind' in range) return range
            return (async function* () {
              try {
                yield* range
              } catch (error) {
                reportFailure(error)
                throw error
              }
            })()
          } catch (error) {
            reportFailure(error)
            throw error
          }
        },
      },
      // WRITE CONFIRMATION (ADR 12, POD-6277). Every commit that covers an applied
      // entry — by the provenance on its rows, or a cursor reaching its receipt —
      // retires it in that same unit of work, with the rows and the cursor.
      overlay: createOutboxFn.overlay,
      unitOfWork: store.unitOfWork,
      onEvent: (event) => {
        syncTelemetry.noteReplicaEvent(event)
        progress.noteEvent(event)
        facade.onKernelEvent(event)
        // A reply recorded while this commit was in flight was not yet applied when
        // the commit decided what it covers. Its cursor is durable now, so ask again
        // (from memory; a commit that covers nothing writes nothing).
        if (event.type === 'cursor') {
          void createOutboxFn
            .confirmThrough(event.cursor)
            .catch((error: unknown) => options.onDegraded?.(error))
        }
      },
      batchEvents: (emitAll) => facade.batch(emitAll),
    })
    kernel = replicaKernel
    // AT REST: what the persisted cursor already covers retires before anything
    // paints — a receipt at or below it, and every applied entry without a receipt
    // that an older build left behind (the stranded nulldisk clear). What is ahead
    // of it keeps painting until the replica catches up.
    // A store that cannot take this write is reported, never a reason to refuse
    // the open: the entries stay, and the next commit confirms them.
    if (replicaKernel.cursor !== null) {
      try {
        await createOutboxFn.confirmThrough(replicaKernel.cursor)
      } catch (error) {
        options.onDegraded?.(error)
      }
    }
    progress.begin(replicaKernel.posture)
    const sink = new FeedSink({ replica: replicaKernel })
    progress.retry = () => {
      // An expired identity requires the app's credential gate, never another walk.
      if (disposed || erased || progress.getSnapshot().error === 'auth') return
      stopped = false
      replicaKernel.disconnect()
      replicaKernel.connect()
    }
    const feed: FeedSinkPort = {
      syncHttp: true,
      requestRebootstrap: () => {
        if (!stopped) sink.requestRebootstrap()
      },
      helloFields: () => sink.helloFields(),
      connected: () => {
        if (!stopped) sink.connected()
      },
      disconnected: () => sink.disconnected(),
      frame: (frame) => {
        if (!stopped) sink.frame(frame)
      },
    }
    const settled = async (): Promise<void> => {
      transcriptCache?.flush()
      await Promise.all([store.settled(), flushSettings(), transcriptStore?.settled()])
    }
    const stop = (): void => {
      stopped = true
      replicaKernel.disconnect()
      side?.dispose()
      cancelSweep?.()
      transcriptCache?.dispose()
    }
    return {
      principal: asClientPrincipal(asUserId(memberId), identity?.syncBoundaryId),
      replica: facade,
      createReplicaFn: (principal) => {
        if (
          principal.userId !== memberId ||
          principal.syncBoundaryId !== identity?.syncBoundaryId
        ) {
          throw new Error(
            `kernel replica assembly belongs to a different principal (opened for ${options.principal}); a new principal needs a new assembly, never this one`,
          )
        }
        return facade
      },
      feed,
      createOutboxFn,
      store,
      progress,
      ...(transcriptStore ? { transcripts: transcriptStore } : {}),
      settled,
      erasePrincipalData: async () => {
        erased = true
        stop()
        await erasePrincipal(namespace, options.principal)
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        stop()
        try {
          await settled()
        } finally {
          store.close()
          transcriptStore?.close()
        }
      },
    }
  } catch (error) {
    kernel?.disconnect()
    side?.dispose()
    transcriptCache?.dispose()
    transcriptStore?.close()
    store.close()
    throw error instanceof ReplicaGateError ? error : storageFailure(error)
  }
}

function storageFailure(error: unknown): ReplicaGateError {
  return new ReplicaGateError(error instanceof Error ? error.message : String(error), {
    kind: 'replica-blocked',
  })
}

function safeKeys(settings: ReplicaSettings): string[] {
  try {
    return settings.enumerateKeys()
  } catch {
    return []
  }
}

/** First paint first: wait a few seconds, then for an idle moment where the host has one. */
const SWEEP_DELAY_MS = 5_000

function whenIdleAfterStartup(run: () => void): () => void {
  let cancelled = false
  let idle: number | undefined
  const host = globalThis as {
    requestIdleCallback?: (cb: () => void) => number
    cancelIdleCallback?: (id: number) => void
  }
  const timer = setTimeout(() => {
    if (cancelled) return
    if (typeof host.requestIdleCallback === 'function') idle = host.requestIdleCallback(run)
    else run()
  }, SWEEP_DELAY_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    cancelled = true
    clearTimeout(timer)
    if (idle !== undefined) host.cancelIdleCallback?.(idle)
  }
}
