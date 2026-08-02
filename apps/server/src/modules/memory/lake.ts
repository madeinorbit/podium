import type { AgentKind, ResumeRef, TranscriptItem } from '@podium/model'
import { MirrorService } from '@podium/sync'
import { fileChainSource, fileIdFor } from '@podium/transcript'
import { transcriptRecordMapperFor } from '../../harness-manifest'
import type { ConversationsRepository } from '../../store/conversations'
import { type DaemonRequestPort, daemonRequestKind } from '../daemon-request'
import { TranscriptIndexer } from './transcript-indexer'

const READ_TIMEOUT_MS = 10_000

/** The mirror's ranged-read request family (POD-318). One prefix, one result
 *  type, one registry — see `modules/daemon-request.ts`. */
const MIRROR_READ = daemonRequestKind<{
  data: string
  fileSize: number
  eof: boolean
  error?: string
}>('mr')

export interface LakeReadSession {
  machineId: string
  agentKind: AgentKind
  resume?: ResumeRef | undefined
}

export interface TranscriptLakeDeps {
  store: ConversationsRepository
  now(): number
  /**
   * The ONE daemon-RPC correlator (POD-318), taken as the broker's own exported
   * port rather than re-declared here.
   *
   * This used to be a structural COPY of a six-argument `daemonRequest` function
   * type — the same port written out again in `hosts/service.ts` and implemented
   * a third time in `machines/rpc.ts` (inventory §6.5 rule 1). The copy is also
   * what forced the pending map below to exist: a function type that hands back
   * a resolver can only work if the caller owns the registry. Depending on the
   * port instead puts the registry, the timeout AND the answering-machine check
   * (POD-1175) in the broker, and leaves this owner with just the read.
   */
  daemonRequest: DaemonRequestPort
}

/**
 * Transcript lake + byte-verbatim mirror. MirrorService's watchdog pacing is
 * consumed unchanged; this owner only supplies its repositories and hooks.
 */
export class TranscriptLake {
  private readonly mirror?: MirrorService
  private readonly indexer?: TranscriptIndexer

  constructor(
    private readonly deps: TranscriptLakeDeps,
    options: { mirrorLakeDir?: string } = {},
  ) {
    if (!options.mirrorLakeDir) return
    const indexer = new TranscriptIndexer({
      mirror: deps.store.mirror,
      index: deps.store.transcriptIndex,
    })
    this.indexer = indexer
    this.mirror = new MirrorService(
      deps.store.mirror,
      options.mirrorLakeDir,
      (machineId, request) => this.read(machineId, request),
      deps.now,
      {
        onBytes: (machineId, nativeId, lakePath) => indexer.onBytes(machineId, nativeId, lakePath),
        onTruncate: (machineId, nativeId) => indexer.onTruncate(machineId, nativeId),
      },
    )
  }

  triggerSweep(machineId: string): void {
    if (!this.mirror) return
    this.mirror.enqueueDirty(machineId)
    this.indexer?.backfillMachine(
      machineId,
      (nativeId) => this.mirror?.lakePath(machineId, nativeId) ?? '',
    )
  }

  pathHint(machineId: string, nativeId: string): { pathHint: string } | undefined {
    const path = this.deps.store.registry.segmentPath(machineId, nativeId)
    return path ? { pathHint: path } : undefined
  }

  async readWindow(
    session: LakeReadSession,
    input: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ): Promise<
    { items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean } | undefined
  > {
    const nativeId = session.resume?.value
    if (!this.mirror || !nativeId) return undefined
    if (this.deps.store.mirror.mirrorCursor(session.machineId, nativeId) <= 0) return undefined
    const path = this.mirror.lakePath(session.machineId, nativeId)
    const recordToItems = transcriptRecordMapperFor(session.agentKind)
    if (!recordToItems) return undefined
    const slice = await fileChainSource(
      [{ path, fileId: fileIdFor(path) }],
      recordToItems,
    ).readSlice({
      ...(input.anchor ? { anchor: input.anchor } : {}),
      direction: input.direction,
      limit: input.limit,
      cached: true,
    })
    return slice.items.length > 0 ? slice : undefined
  }

  private read(
    machineId: string,
    request: { path: string; offset: number; maxBytes: number },
  ): Promise<{ data: string; fileSize: number; eof: boolean; error?: string }> {
    return this.deps.daemonRequest.request({
      kind: MIRROR_READ,
      timeoutMs: READ_TIMEOUT_MS,
      onTimeout: () => ({ data: '', fileSize: 0, eof: false, error: 'timeout' }),
      build: (requestId) => ({
        type: 'transcriptMirrorRead',
        requestId,
        path: request.path,
        offset: request.offset,
        maxBytes: request.maxBytes,
      }),
      machineId,
    })
  }

  /** The daemon's transcriptMirrorResult reply, settled through the one
   *  correlator. `machineId` is who ANSWERED: the broker drops a reply from a
   *  machine other than the one this ranged read was sent to (POD-1175). */
  onMirrorResult(
    machineId: string,
    message: {
      requestId: string
      data: string
      fileSize: number
      eof: boolean
      error?: string
    },
  ): void {
    this.deps.daemonRequest.settle(MIRROR_READ, message.requestId, machineId, {
      data: message.data,
      fileSize: message.fileSize,
      eof: message.eof,
      ...(message.error === undefined ? {} : { error: message.error }),
    })
  }
}
