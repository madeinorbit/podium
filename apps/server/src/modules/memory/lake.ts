import type { AgentKind, ResumeRef, TranscriptItem } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { MirrorService } from '@podium/sync'
import { fileChainSource, fileIdFor } from '@podium/transcript'
import { transcriptRecordMapperFor } from '../../harness-manifest'
import type { ConversationsRepository } from '../../store/conversations'
import { TranscriptIndexer } from './transcript-indexer'

const READ_TIMEOUT_MS = 10_000

export interface LakeReadSession {
  machineId: string
  agentKind: AgentKind
  resume?: ResumeRef | undefined
}

export interface TranscriptLakeDeps {
  store: ConversationsRepository
  now(): number
  daemonRequest<T>(
    pending: Map<string, (result: T) => void>,
    prefix: string,
    timeoutMs: number,
    onTimeout: () => T,
    buildMessage: (requestId: string) => ControlMessage,
    machineId?: string,
  ): Promise<T>
}

/**
 * Transcript lake + byte-verbatim mirror. MirrorService's watchdog pacing is
 * consumed unchanged; this owner only supplies its repositories and hooks.
 */
export class TranscriptLake {
  private readonly pendingReads = new Map<
    string,
    (result: { data: string; fileSize: number; eof: boolean; error?: string }) => void
  >()
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
    this.indexer?.backfillMachine(machineId, (nativeId) =>
      this.mirror?.lakePath(machineId, nativeId) ?? '',
    )
  }

  pathHint(machineId: string, nativeId: string): { pathHint: string } | undefined {
    const path = this.deps.store.registry.segmentPath(machineId, nativeId)
    return path ? { pathHint: path } : undefined
  }

  async readWindow(
    session: LakeReadSession,
    input: { anchor?: string; direction: 'before' | 'after'; limit: number },
  ): Promise<{ items: TranscriptItem[]; head?: string; tail?: string; hasMore: boolean } | undefined> {
    const nativeId = session.resume?.value
    if (!this.mirror || !nativeId) return undefined
    if (this.deps.store.mirror.mirrorCursor(session.machineId, nativeId) <= 0) return undefined
    const path = this.mirror.lakePath(session.machineId, nativeId)
    const recordToItems = transcriptRecordMapperFor(session.agentKind)
    if (!recordToItems) return undefined
    const slice = await fileChainSource([{ path, fileId: fileIdFor(path) }], recordToItems).readSlice({
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
    return this.deps.daemonRequest(
      this.pendingReads,
      'mr',
      READ_TIMEOUT_MS,
      () => ({ data: '', fileSize: 0, eof: false, error: 'timeout' }),
      (requestId) => ({
        type: 'transcriptMirrorRead',
        requestId,
        path: request.path,
        offset: request.offset,
        maxBytes: request.maxBytes,
      }),
      machineId,
    )
  }

  onMirrorResult(message: {
    requestId: string
    data: string
    fileSize: number
    eof: boolean
    error?: string
  }): void {
    const resolve = this.pendingReads.get(message.requestId)
    if (!resolve) return
    this.pendingReads.delete(message.requestId)
    resolve({
      data: message.data,
      fileSize: message.fileSize,
      eof: message.eof,
      ...(message.error !== undefined ? { error: message.error } : {}),
    })
  }
}
