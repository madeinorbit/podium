import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { MachineId } from '@podium/model'
import { validatePublicUrl } from '@podium/runtime/setup'
import { isActiveTransfer, TransferJournal } from './journal'
import { TransferLock } from './lock'
import {
  assertSnapshotCapacity,
  createPortableSnapshot,
  estimatePortableBytes,
  MAX_TRANSFER_BYTES,
  manifestWithDigest,
  TRANSFER_SPACE_MARGIN_BYTES,
} from './snapshot'
import {
  type PromotedTargetMetadata,
  SERVER_TRANSFER_CONFIRMATION,
  type ServerEndpointHandoff,
  type ServerTransferAuthorization,
  type ServerTransferInput,
  type ServerTransferManifest,
  type ServerTransferOutcome,
  type ServerTransferRpc,
  type TargetHealthProof,
  TRANSFER_FAILURE_CODES,
  type TransferFailureCode,
  type TransferProof,
  type TransferRecord,
} from './types'

const CHUNK_BYTES = 512 * 1024
const TARGET_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000

export interface ServerTransferTargetState {
  exists: boolean
  online: boolean
  capable: boolean
  /**
   * The target durably runs a Podium daemon (POD-2700). A transfer drives the
   * promotion THROUGH the target's daemon, so a row without one can never
   * become the server — and reporting that as `offline` would offer "wait for
   * it" as the fix. Supplied by the composition root from the machine's
   * recorded components.
   */
  hasDaemon: boolean
}

export interface ServerTransferDeps {
  stateRoot: string
  sourceInstanceId: string
  sourceMachineId: MachineId
  sourceFeedIdentity: () => { feedId: string; feedEpoch: string }
  sourceApplicationVersion: string
  sourceSchemaVersion: () => string
  sourceWireSchemaDigest: string
  sourceCapable?(): boolean
  rpc: ServerTransferRpc
  /** Direct endpoint control; absent only in narrow legacy unit seams. */
  endpointHandoff?: ServerEndpointHandoff
  targetState(machineId: MachineId): ServerTransferTargetState
  localPromotedTransfer():
    | PromotedTargetMetadata
    | undefined
    | Promise<PromotedTargetMetadata | undefined>
  sourceHealthy(): void | Promise<void>
  checkpoint(): void | Promise<void>
  /** Covers SQLite and every durable portable-file writer. */
  fence(): void | Promise<void>
  releaseFence(): void | Promise<void>
  /** Persist daemon mode/config without exiting the source process. */
  demoteSource(input: {
    transferId: string
    targetMachineId: MachineId
    publicUrl: string
  }): void | Promise<void>
  /** Called immediately after the committed journal has been fsync'd. */
  afterJournalCommitted?(): void
  /** Called only after the committed journal has been fsync'd. */
  afterCommitted?(input: { serverUrl: string }): void
  /** Bounds target cleanup before the committed source retires. */
  acknowledgementTimeoutMs?: number
  /** Restarts a recovery-only source after a proven pre-promotion abort. */
  afterRecoveredAbort?(): void
  snapshotAvailableBytes?: () => number | Promise<number>
  now?: () => Date
  uuid?: () => string
}

export class ServerTransferError extends Error {
  constructor(
    readonly code: TransferFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'ServerTransferError'
  }
}

const fail = (code: TransferFailureCode, message: string): ServerTransferError =>
  new ServerTransferError(code, message)

function classified(
  error: unknown,
  fallback: TransferFailureCode = TRANSFER_FAILURE_CODES.INTERNAL,
) {
  if (error instanceof ServerTransferError) return { code: error.code, message: error.message }
  return { code: fallback, message: error instanceof Error ? error.message : String(error) }
}

function proofMatches(
  proof: TransferProof | undefined,
  manifest: ServerTransferManifest,
  targetMachineId: MachineId,
): proof is TransferProof {
  return (
    proof !== undefined &&
    proof.operationId === manifest.operationId &&
    proof.transferId === manifest.transferId &&
    proof.manifestDigest === manifest.digest &&
    proof.targetMachineId === targetMachineId &&
    proof.feedId === manifest.sourceFeedId &&
    proof.feedEpoch === manifest.sourceFeedEpoch &&
    proof.schemaVersion === manifest.schemaVersion &&
    proof.buildVersion.length > 0
  )
}

function healthProofMatches(
  proof: TargetHealthProof | undefined,
  manifest: ServerTransferManifest,
  targetMachineId: MachineId,
  publicUrl: string,
  bindHost: '127.0.0.1' | '0.0.0.0',
  port: number,
): proof is TargetHealthProof {
  return (
    proofMatches(proof, manifest, targetMachineId) &&
    proof.health === 'serving' &&
    proof.publicUrl === publicUrl &&
    proof.bindHost === bindHost &&
    proof.port === port
  )
}

export function normalizedPublicUrl(input: ServerTransferInput): string {
  if (input.confirmation !== SERVER_TRANSFER_CONFIRMATION) {
    throw fail(
      TRANSFER_FAILURE_CODES.INVALID_CONFIRMATION,
      'server transfer confirmation is invalid',
    )
  }
  const checked = validatePublicUrl(input.publicUrl.trim())
  if (!checked.ok) throw fail(TRANSFER_FAILURE_CODES.INVALID_URL, checked.error)
  return checked.normalized
}

export function resolvedTransferPort(input: ServerTransferInput, publicUrl: string): number {
  if (input.port !== undefined) return input.port
  const parsed = new URL(publicUrl)
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
}

async function uploadSnapshot(
  packageDir: string,
  manifest: ServerTransferManifest,
  targetMachineId: MachineId,
  rpc: ServerTransferRpc,
  onProgress: (bytesCopied: number, totalBytes: number) => void,
  resumeBytes = 0,
): Promise<void> {
  if (resumeBytes > manifest.packageBytes) {
    throw fail(TRANSFER_FAILURE_CODES.TARGET_REJECTED, 'target resume offset exceeds the snapshot')
  }
  let copied = 0
  let remainingResume = resumeBytes
  for (let fileIndex = 0; fileIndex < manifest.files.length; fileIndex += 1) {
    const entry = manifest.files[fileIndex]
    if (!entry) throw fail(TRANSFER_FAILURE_CODES.INTERNAL, 'manifest file index is missing')
    let offset = Math.min(remainingResume, entry.size)
    remainingResume -= offset
    copied += offset
    if (offset === entry.size) continue
    for await (const part of createReadStream(join(packageDir, ...entry.path.split('/')), {
      highWaterMark: CHUNK_BYTES,
      start: offset,
    })) {
      const data = Buffer.isBuffer(part) ? part : Buffer.from(part)
      const result = await rpc.serverTransferChunk(
        {
          transferId: manifest.transferId,
          manifestDigest: manifest.digest,
          fileIndex,
          offset,
          expectedLength: data.length,
          data,
        },
        targetMachineId,
      )
      if (
        !result.ok ||
        result.state !== 'staging' ||
        result.manifestDigest !== manifest.digest ||
        result.path !== entry.path ||
        result.offset !== offset ||
        result.receivedBytes !== data.length
      ) {
        throw fail(
          TRANSFER_FAILURE_CODES.TARGET_REJECTED,
          result.ok ? 'target returned an invalid chunk acknowledgement' : result.error.detail,
        )
      }
      offset += data.length
      copied += data.length
      onProgress(copied, manifest.packageBytes)
    }
    if (offset !== entry.size) {
      throw fail(TRANSFER_FAILURE_CODES.SNAPSHOT_FAILED, 'snapshot size changed during upload')
    }
  }
}

export type ServerTransferCrashPoint =
  | 'after-seal'
  | 'after-fence-pending'
  | 'after-physical-fence'
  | 'after-source-fenced'
  | 'after-final-snapshot'
  | 'after-committing'
  | 'after-promote'
  | 'after-demote'
  | 'after-commit'

export interface ServerTransferHooks {
  operationId?: string
  transferId?: string
  onRecord?: (record: TransferRecord) => void
  onPhase?: (
    phase: 'preflight' | 'stage' | 'validate',
    state: 'running' | 'done',
    record: TransferRecord,
  ) => void
  beforeFence?: (record: TransferRecord) => void | Promise<void>
  canceled?: () => boolean
  crash?: (point: ServerTransferCrashPoint) => void | Promise<void>
}

export class ServerTransferService {
  private readonly journal: TransferJournal
  private readonly lock: TransferLock
  private readonly uuid: () => string

  constructor(private readonly deps: ServerTransferDeps) {
    const transferRoot = join(deps.stateRoot, '.server-transfer')
    this.journal = new TransferJournal(transferRoot, deps.now)
    this.lock = new TransferLock(join(transferRoot, 'source.lock'), deps.now)
    this.uuid = deps.uuid ?? randomUUID
  }

  sourceMachineId(): MachineId {
    return this.deps.sourceMachineId
  }

  mintTransferId(): string {
    return this.uuid()
  }

  status() {
    return this.journal.read()
  }

  async recover(): Promise<{
    outcome: 'resolved-committed' | 'resolved-aborted' | 'still-uncertain'
  }> {
    const entry = this.journal.read()
    if (!entry) return { outcome: 'still-uncertain' }
    if (entry.state === 'committed') return { outcome: 'resolved-committed' }
    if (entry.state === 'source-fenced') {
      const manifest = entry.record.manifest
      if (manifest) {
        await this.abortPrepared(
          { transferId: entry.record.transferId, manifestDigest: manifest.digest },
          entry.record.targetMachineId,
          'operator-recovery',
        )
      }
      await this.deps.releaseFence()
      this.journal.abort(
        { code: 'boot-recovery', message: 'the fenced move was safely aborted before promotion' },
        { result: 'cleaned' },
      )
      this.deps.afterRecoveredAbort?.()
      return { outcome: 'resolved-aborted' }
    }
    if (entry.state !== 'committing' && entry.state !== 'commit-uncertain') {
      return { outcome: 'still-uncertain' }
    }
    const result = await this.inspectUncertain(entry.record, { reauthorize: async () => {} })
    return { outcome: result.state === 'committed' ? 'resolved-committed' : 'still-uncertain' }
  }

  async transfer(
    input: ServerTransferInput,
    authorization: ServerTransferAuthorization,
    hooks: ServerTransferHooks = {},
  ): Promise<ServerTransferOutcome> {
    const publicUrl = normalizedPublicUrl(input)
    const bindHost = input.bindHost
    const port = resolvedTransferPort(input, publicUrl)
    await this.lock.acquire()
    try {
      const existing = this.journal.read()
      if (existing?.state === 'committed') {
        if (
          existing.record.targetMachineId === input.targetMachineId &&
          existing.record.publicUrl === publicUrl &&
          existing.record.bindHost === bindHost &&
          existing.record.port === port
        ) {
          return this.outcome(existing.record, true, 'committed')
        }
        throw fail(
          TRANSFER_FAILURE_CODES.ACTIVE_TRANSFER,
          'the server was already transferred to another target',
        )
      }
      if (existing?.state === 'commit-uncertain' || existing?.state === 'committing') {
        return this.inspectUncertain(existing.record, authorization)
      }
      const resumable =
        existing !== undefined &&
        ['preparing', 'staged', 'validated', 'fence-pending'].includes(existing.state) &&
        existing.record.operationId === hooks.operationId &&
        existing.record.targetMachineId === input.targetMachineId &&
        existing.record.publicUrl === publicUrl &&
        existing.record.bindHost === bindHost &&
        existing.record.port === port
          ? existing
          : undefined
      if (existing && isActiveTransfer(existing.state) && !resumable) {
        throw fail(
          TRANSFER_FAILURE_CODES.ACTIVE_TRANSFER,
          `a server transfer is already ${existing.state}`,
        )
      }

      await authorization.reauthorize('prepare')
      await this.preflight(input)
      if (hooks.canceled?.()) {
        throw fail(TRANSFER_FAILURE_CODES.INTERNAL, 'server move canceled')
      }

      const operationId = resumable?.record.operationId ?? hooks.operationId ?? this.uuid()
      const probeTransferId = resumable?.record.transferId ?? hooks.transferId ?? this.uuid()
      const initialPackageDir =
        resumable?.record.packageDir ??
        join(this.deps.stateRoot, '.server-transfer', 'snapshots', operationId, 'initial')
      let record: TransferRecord = resumable?.record ?? {
        operationId,
        phase: 'preparing',
        bytesCopied: 0,
        totalBytes: 0,
        transferId: probeTransferId,
        targetMachineId: input.targetMachineId,
        publicUrl,
        bindHost,
        port,
        sourceMachineId: this.deps.sourceMachineId,
        sourceInstanceId: this.deps.sourceInstanceId,
        packageDir: initialPackageDir,
        manifest: null,
        idempotencyKey: probeTransferId,
        targetProof: false,
        sourceConnected: false,
        reachabilityToken: this.uuid() + this.uuid(),
        quiescedMachineIds: [],
        endpointCommittedMachineIds: [],
        offlineMachineIds: [],
      }
      if (!resumable) this.journal.begin(record)
      hooks.onPhase?.('preflight', 'done', record)
      if (!resumable || resumable.state === 'preparing') {
        hooks.onPhase?.('stage', 'running', record)
      } else {
        hooks.onPhase?.('stage', 'done', record)
        if (resumable.state === 'staged') hooks.onPhase?.('validate', 'running', record)
        else hooks.onPhase?.('validate', 'done', record)
      }

      let prepared: { transferId: string; manifestDigest: string } | undefined
      let fenceHeld = false
      const persistProgress = (bytesCopied: number, totalBytes: number) => {
        if (hooks.canceled?.()) {
          throw fail(TRANSFER_FAILURE_CODES.INTERNAL, 'server move canceled')
        }
        record = { ...record, phase: 'copying', bytesCopied, totalBytes }
        this.journal.updateRecord(record)
        hooks.onRecord?.(record)
      }
      try {
        let initialManifest = record.manifest
        if (!initialManifest) {
          initialManifest = await this.snapshot(record, initialPackageDir)
          record = {
            ...record,
            manifest: initialManifest,
            phase: 'copying',
            bytesCopied: 0,
            totalBytes: initialManifest.packageBytes,
          }
          this.journal.updateRecord(record)
          hooks.onRecord?.(record)
        }
        prepared = {
          transferId: initialManifest.transferId,
          manifestDigest: initialManifest.digest,
        }

        if (this.journal.read()?.state === 'preparing') {
          await authorization.reauthorize('stage')
          this.assertTarget(input.targetMachineId)
          await this.stage(
            initialManifest,
            initialPackageDir,
            input.targetMachineId,
            publicUrl,
            bindHost,
            port,
            record.reachabilityToken ?? probeTransferId + probeTransferId,
            persistProgress,
          )
          if (hooks.canceled?.()) {
            throw fail(TRANSFER_FAILURE_CODES.INTERNAL, 'server move canceled')
          }
          this.journal.transition('staged')
          hooks.onPhase?.('stage', 'done', record)
        }

        if (this.journal.read()?.state === 'staged') {
          record = { ...record, phase: 'validating' }
          this.journal.updateRecord(record)
          hooks.onPhase?.('validate', 'running', record)
          await authorization.reauthorize('validate')
          this.assertTarget(input.targetMachineId)
          await this.validate(initialManifest, input.targetMachineId)
          this.journal.transition('validated')
          hooks.onPhase?.('validate', 'done', record)
        }

        if (hooks.canceled?.()) {
          throw fail(TRANSFER_FAILURE_CODES.INTERNAL, 'server move canceled')
        }
        record = await this.prepareEndpointHandoff(record, initialManifest)
        // The final snapshot must carry a claim hash for every browser connected
        // to the old origin. Mint while the source store is still writable.
        this.deps.endpointHandoff?.prepareClientRelocations(record.operationId)
        await authorization.reauthorize('fence')
        await hooks.beforeFence?.(record)
        await hooks.crash?.('after-seal')
        this.assertTarget(input.targetMachineId)
        record = { ...record, phase: 'switching' }
        this.journal.updateRecord(record)
        // The journal first records intent without claiming the physical fence
        // exists. Only the completed fence may advance to source-fenced.
        this.journal.transition('fence-pending')
        await hooks.crash?.('after-fence-pending')
        await this.deps.fence()
        await hooks.crash?.('after-physical-fence')
        fenceHeld = true
        this.journal.transition('source-fenced')
        await hooks.crash?.('after-source-fenced')

        const finalPackageDir = join(
          this.deps.stateRoot,
          '.server-transfer',
          'snapshots',
          operationId,
          'final',
        )
        let finalManifest = await this.snapshot(record, finalPackageDir)
        await hooks.crash?.('after-final-snapshot')
        if (finalManifest.digest !== initialManifest.digest) {
          await this.abortPrepared(prepared, input.targetMachineId, 'final-snapshot-changed')
          prepared = undefined

          const finalTransferId = this.uuid()
          finalManifest = manifestWithDigest({
            ...finalManifest,
            transferId: finalTransferId,
          })
          record = {
            ...record,
            phase: 'copying',
            bytesCopied: 0,
            totalBytes: finalManifest.packageBytes,
            transferId: finalTransferId,
            idempotencyKey: finalTransferId,
            packageDir: finalPackageDir,
            manifest: finalManifest,
            probe: {
              transferId: initialManifest.transferId,
              manifestDigest: initialManifest.digest,
            },
            targetProof: false,
          }
          this.journal.updateRecord(record)

          await authorization.reauthorize('stage')
          this.assertTarget(input.targetMachineId)
          prepared = {
            transferId: finalManifest.transferId,
            manifestDigest: finalManifest.digest,
          }
          await this.stage(
            finalManifest,
            finalPackageDir,
            input.targetMachineId,
            publicUrl,
            bindHost,
            port,
            record.reachabilityToken ?? finalTransferId + finalTransferId,
            persistProgress,
          )
          record = { ...record, phase: 'validating' }
          this.journal.updateRecord(record)
          await authorization.reauthorize('validate')
          this.assertTarget(input.targetMachineId)
          await this.validate(finalManifest, input.targetMachineId)
        }

        record = { ...record, manifest: finalManifest, phase: 'switching', targetProof: true }
        this.journal.updateRecord(record)

        record = await this.prepareEndpointHandoff(record, finalManifest)

        await authorization.reauthorize('commit')
        this.assertTarget(input.targetMachineId)
        this.journal.transition('committing')
        await hooks.crash?.('after-committing')
        const promoted = await this.deps.rpc.serverTransferPromote(
          {
            transferId: finalManifest.transferId,
            manifestDigest: finalManifest.digest,
            publicUrl,
            bindHost,
            port,
            targetMode: 'server',
            idempotencyKey: record.idempotencyKey,
          },
          input.targetMachineId,
        )
        if (
          !promoted.ok ||
          promoted.state !== 'promoted' ||
          !healthProofMatches(
            promoted.proof,
            finalManifest,
            input.targetMachineId,
            publicUrl,
            bindHost,
            port,
          )
        ) {
          throw fail(
            TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN,
            promoted.ok ? 'target promotion proof is missing' : promoted.error.detail,
          )
        }

        await hooks.crash?.('after-promote')
        record = await this.commitEndpointHandoff(record)
        await this.deps.demoteSource({
          transferId: finalManifest.transferId,
          targetMachineId: input.targetMachineId,
          publicUrl,
        })
        await hooks.crash?.('after-demote')
        record = { ...record, targetProof: true, sourceConnected: false }
        this.journal.commit(record)
        this.deps.afterJournalCommitted?.()
        await hooks.crash?.('after-commit')
        fenceHeld = false
        const acknowledgementCleanup = this.persistAcknowledgementCleanup(
          await this.acknowledgePromotedWithinDeadline(finalManifest, input.targetMachineId),
        )
        this.deps.afterCommitted?.({ serverUrl: publicUrl })
        return this.outcome(record, true, 'committed', undefined, acknowledgementCleanup)
      } catch (error) {
        const current = this.journal.read()
        const detail = classified(error)
        if (current?.state === 'committing') {
          this.journal.commitUncertain({
            code: TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN,
            message: detail.message,
          })
          return this.outcome(record, false, 'commit-uncertain', {
            code: TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN,
            message: detail.message,
          })
        }

        await this.resumeEndpointHandoff(record)
        this.deps.endpointHandoff?.cancelClientRelocations(record.operationId)
        let cleanup: { result: 'cleaned' | 'pending'; detail?: string } = { result: 'cleaned' }
        if (prepared) {
          try {
            await this.abortPrepared(prepared, input.targetMachineId, detail.code)
          } catch (abortError) {
            cleanup = { result: 'pending', detail: classified(abortError).message }
          }
        }
        if (fenceHeld) {
          try {
            await this.deps.releaseFence()
            fenceHeld = false
          } catch (releaseError) {
            cleanup = { result: 'pending', detail: classified(releaseError).message }
          }
        }
        this.journal.abort(detail, cleanup)
        return this.outcome(record, false, 'aborted', detail, cleanup)
      }
    } finally {
      await this.lock.release()
    }
  }

  private async snapshot(record: TransferRecord, packageDir: string) {
    const identity = this.deps.sourceFeedIdentity()
    return createPortableSnapshot({
      stateRoot: this.deps.stateRoot,
      packageDir,
      operationId: record.operationId,
      transferId: record.transferId,
      sourceInstanceId: this.deps.sourceInstanceId,
      sourceMachineId: this.deps.sourceMachineId,
      targetMachineId: record.targetMachineId,
      sourceFeedId: identity.feedId,
      sourceFeedEpoch: identity.feedEpoch,
      sourceApplicationVersion: this.deps.sourceApplicationVersion,
      sourceSchemaVersion: this.deps.sourceSchemaVersion(),
      checkpoint: this.deps.checkpoint,
    })
  }

  private async stage(
    manifest: ServerTransferManifest,
    packageDir: string,
    targetMachineId: MachineId,
    publicUrl: string,
    bindHost: '127.0.0.1' | '0.0.0.0',
    port: number,
    reachabilityToken: string,
    onProgress: (bytesCopied: number, totalBytes: number) => void,
  ): Promise<void> {
    const result = await this.deps.rpc.serverTransferPrepare(
      {
        transferId: manifest.transferId,
        sourceMachineId: this.deps.sourceMachineId,
        manifest,
        publicUrl,
        bindHost,
        port,
        reachabilityToken,
        packageLimits: { totalBytes: manifest.packageBytes, maxChunkBytes: CHUNK_BYTES },
      },
      targetMachineId,
    )
    if (
      !result.ok ||
      result.state !== 'prepared' ||
      result.manifestDigest !== manifest.digest ||
      result.targetMachineId !== targetMachineId ||
      result.targetCapability !== 'server-only' ||
      result.wireSchemaDigest !== this.deps.sourceWireSchemaDigest ||
      result.buildVersion.length === 0
    ) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_UNSUPPORTED,
        result.ok ? 'target prepare proof is incomplete' : result.error.detail,
      )
    }
    if (
      !result.space.sufficient ||
      result.space.availableBytes < manifest.packageBytes * 2 + TRANSFER_SPACE_MARGIN_BYTES
    ) {
      throw fail(TRANSFER_FAILURE_CODES.DISK_FULL, 'target has insufficient transfer space')
    }
    await uploadSnapshot(
      packageDir,
      manifest,
      targetMachineId,
      this.deps.rpc,
      onProgress,
      result.receivedBytes,
    )
  }

  private async validate(
    manifest: ServerTransferManifest,
    targetMachineId: MachineId,
  ): Promise<TransferProof> {
    const result = await this.deps.rpc.serverTransferValidate(
      { transferId: manifest.transferId, manifestDigest: manifest.digest },
      targetMachineId,
    )
    if (
      !result.ok ||
      result.state !== 'validated' ||
      !proofMatches(result.proof, manifest, targetMachineId)
    ) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_PROOF_MISSING,
        result.ok ? 'target candidate proof is invalid' : result.error.detail,
      )
    }
    return result.proof
  }

  private async acknowledgePromoted(
    manifest: ServerTransferManifest,
    targetMachineId: MachineId,
  ): Promise<{ result: 'pending'; detail: string } | undefined> {
    try {
      const result = await this.deps.rpc.serverTransferAcknowledge(
        { transferId: manifest.transferId, manifestDigest: manifest.digest },
        targetMachineId,
      )
      if (
        result.ok &&
        result.state === 'promoted' &&
        result.transferId === manifest.transferId &&
        result.manifestDigest === manifest.digest &&
        result.acknowledged === true
      ) {
        return undefined
      }
      return {
        result: 'pending',
        detail: result.ok ? 'target acknowledgement was not confirmed' : result.error.detail,
      }
    } catch (error) {
      return { result: 'pending', detail: classified(error).message }
    }
  }

  private async acknowledgePromotedWithinDeadline(
    manifest: ServerTransferManifest,
    targetMachineId: MachineId,
  ): Promise<{ result: 'pending'; detail: string } | undefined> {
    const timeoutMs = Math.max(
      0,
      this.deps.acknowledgementTimeoutMs ?? TARGET_ACKNOWLEDGEMENT_TIMEOUT_MS,
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ result: 'pending'; detail: string }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            result: 'pending',
            detail: `target acknowledgement did not settle within ${timeoutMs}ms`,
          }),
        timeoutMs,
      )
    })
    const cleanup = await Promise.race([
      this.acknowledgePromoted(manifest, targetMachineId),
      timeout,
    ])
    if (timer) clearTimeout(timer)
    return cleanup
  }

  private persistAcknowledgementCleanup(
    cleanup: { result: 'pending'; detail: string } | undefined,
  ): { result: 'pending'; detail: string } | undefined {
    if (!cleanup) return undefined
    try {
      this.journal.recordCleanup(cleanup)
      return cleanup
    } catch (error) {
      return {
        result: 'pending',
        detail: `${cleanup.detail}; cleanup status could not be persisted: ${classified(error).message}`,
      }
    }
  }

  private async abortPrepared(
    prepared: { transferId: string; manifestDigest: string },
    targetMachineId: MachineId,
    reason: string,
  ): Promise<void> {
    const result = await this.deps.rpc.serverTransferAbort(
      {
        transferId: prepared.transferId,
        manifestDigest: prepared.manifestDigest,
        reason,
      },
      targetMachineId,
    )
    if (
      !result.ok ||
      result.state !== 'aborted' ||
      result.transferId !== prepared.transferId ||
      result.manifestDigest !== prepared.manifestDigest ||
      result.cleanup !== 'cleaned'
    ) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_REJECTED,
        result.ok ? 'target cleanup was not confirmed' : result.error.detail,
      )
    }
  }

  private async prepareEndpointHandoff(
    record: TransferRecord,
    manifest: ServerTransferManifest,
  ): Promise<TransferRecord> {
    const endpoint = this.deps.endpointHandoff
    if (!endpoint) return record
    const reachabilityToken = record.reachabilityToken
    if (!reachabilityToken)
      throw fail(TRANSFER_FAILURE_CODES.TARGET_UNREACHABLE, 'target reachability token is missing')
    const request = {
      transferId: manifest.transferId,
      manifestDigest: manifest.digest,
      publicUrl: record.publicUrl,
      reachabilityToken,
      targetMachineId: record.targetMachineId,
    }
    try {
      await endpoint.probeCandidate(request)
    } catch (error) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_UNREACHABLE,
        `the proposed target URL is not reachable from the server: ${classified(error).message}`,
      )
    }
    const registered = endpoint
      .registeredMachineIds()
      .filter((id) => id !== record.sourceMachineId && id !== record.targetMachineId)
    const online = new Set(endpoint.onlineMachineIds())
    const offlineMachineIds = registered.filter((id) => !online.has(id))
    const required = registered.filter((id) => online.has(id))
    const quiesced = new Set(record.quiescedMachineIds ?? [])
    record = { ...record, offlineMachineIds }
    this.journal.updateRecord(record)
    for (const machineId of required) {
      let result: { ok: boolean; error?: string }
      try {
        result = await endpoint.probeMachine(request, machineId)
      } catch (error) {
        await this.resumeEndpointHandoff({ ...record, quiescedMachineIds: [...quiesced] })
        throw fail(
          TRANSFER_FAILURE_CODES.TARGET_UNREACHABLE,
          `machine ${machineId} cannot reach the proposed target: ${classified(error).message}`,
        )
      }
      if (!result.ok) {
        await this.resumeEndpointHandoff({ ...record, quiescedMachineIds: [...quiesced] })
        throw fail(
          TRANSFER_FAILURE_CODES.TARGET_UNREACHABLE,
          `machine ${machineId} cannot reach the proposed target: ${result.error ?? 'probe failed'}`,
        )
      }
      quiesced.add(machineId)
      record = { ...record, quiescedMachineIds: [...quiesced] }
      this.journal.updateRecord(record)
    }
    return record
  }

  private async resumeEndpointHandoff(record: TransferRecord): Promise<void> {
    const endpoint = this.deps.endpointHandoff
    if (!endpoint) return
    await Promise.allSettled(
      (record.quiescedMachineIds ?? []).map((machineId) =>
        endpoint.resumeMachine(record.transferId, machineId),
      ),
    )
  }

  private async commitEndpointHandoff(record: TransferRecord): Promise<TransferRecord> {
    const endpoint = this.deps.endpointHandoff
    if (!endpoint) return record
    const committed = new Set(record.endpointCommittedMachineIds ?? [])
    for (const machineId of record.quiescedMachineIds ?? []) {
      if (committed.has(machineId)) continue
      const result = await endpoint.commitMachine(
        {
          transferId: record.transferId,
          publicUrl: record.publicUrl,
          targetMachineId: record.targetMachineId,
        },
        machineId,
      )
      if (!result.ok) {
        throw fail(
          TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN,
          `machine ${machineId} did not confirm the endpoint switch: ${result.error ?? 'commit failed'}`,
        )
      }
      committed.add(machineId)
      record = { ...record, endpointCommittedMachineIds: [...committed] }
      this.journal.updateRecord(record)
    }
    endpoint.relocateClients({
      transferId: record.transferId,
      publicUrl: record.publicUrl,
      operationId: record.operationId,
    })
    return record
  }

  private async preflight(input: ServerTransferInput): Promise<void> {
    if (this.deps.sourceCapable?.() === false) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_UNSUPPORTED,
        'update this machine to the same Podium version as the target first',
      )
    }
    this.assertTarget(input.targetMachineId)
    await this.deps.sourceHealthy()
    const portableBytes = await estimatePortableBytes(this.deps.stateRoot)
    if (portableBytes > MAX_TRANSFER_BYTES) {
      throw fail(
        TRANSFER_FAILURE_CODES.SNAPSHOT_FAILED,
        'portable state exceeds the transfer limit',
      )
    }
    const available = await this.deps.snapshotAvailableBytes?.()
    await assertSnapshotCapacity(this.deps.stateRoot, portableBytes, available)
  }

  private assertTarget(targetMachineId: MachineId): void {
    if (targetMachineId === this.deps.sourceMachineId) {
      throw fail(TRANSFER_FAILURE_CODES.TARGET_IS_SOURCE, 'target machine is the current server')
    }
    const target = this.deps.targetState(targetMachineId)
    if (!target.exists)
      throw fail(TRANSFER_FAILURE_CODES.TARGET_NOT_FOUND, 'target machine is unavailable')
    if (!target.hasDaemon) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_NO_DAEMON,
        'target machine runs no Podium daemon and cannot become the server',
      )
    }
    if (!target.online)
      throw fail(TRANSFER_FAILURE_CODES.TARGET_OFFLINE, 'target machine is offline')
    if (!target.capable) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_UNSUPPORTED,
        'target does not support server transfer',
      )
    }
  }

  private async inspectUncertain(
    record: TransferRecord,
    authorization: ServerTransferAuthorization,
  ): Promise<ServerTransferOutcome> {
    await authorization.reauthorize('commit')
    if (record.manifest) {
      try {
        const status = await this.deps.rpc.inspectServerTransfer(
          { transferId: record.transferId, manifestDigest: record.manifest.digest },
          record.targetMachineId,
        )
        if (
          status.ok &&
          (status.state === 'prepared' ||
            status.state === 'staging' ||
            status.state === 'validated') &&
          status.transferId === record.transferId &&
          status.manifestDigest === record.manifest.digest &&
          status.publicUrl === record.publicUrl &&
          status.port === record.port
        ) {
          const replay = await this.deps.rpc.serverTransferPromote(
            {
              transferId: record.transferId,
              manifestDigest: record.manifest.digest,
              publicUrl: record.publicUrl,
              bindHost: record.bindHost,
              port: record.port,
              targetMode: 'server',
              idempotencyKey: record.idempotencyKey,
            },
            record.targetMachineId,
          )
          if (
            replay.ok &&
            replay.state === 'promoted' &&
            healthProofMatches(
              replay.proof,
              record.manifest,
              record.targetMachineId,
              record.publicUrl,
              record.bindHost,
              record.port,
            )
          ) {
            await this.finishRecoveredCommit(record)
            return this.outcome(record, true, 'committed')
          }
        }
        if (
          status.ok &&
          status.state === 'promoted' &&
          status.transferId === record.transferId &&
          status.manifestDigest === record.manifest.digest &&
          healthProofMatches(
            status.proof,
            record.manifest,
            record.targetMachineId,
            record.publicUrl,
            record.bindHost,
            record.port,
          )
        ) {
          const committed = await this.finishRecoveredCommit(record)
          return this.outcome(committed, true, 'committed')
        }
      } catch {
        // A missing/mismatched proof or failed source cutover stays uncertain.
      }
    }
    return this.outcome(record, false, 'commit-uncertain', {
      code: TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN,
      message: 'target commit remains uncertain; operator recovery is required',
    })
  }

  private async finishRecoveredCommit(record: TransferRecord): Promise<TransferRecord> {
    if (!record.manifest) {
      throw fail(TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN, 'manifest proof is missing')
    }
    const endpointRecord = await this.commitEndpointHandoff(record)
    await this.deps.demoteSource({
      transferId: record.transferId,
      targetMachineId: record.targetMachineId,
      publicUrl: record.publicUrl,
    })
    const committed = {
      ...endpointRecord,
      phase: 'switching' as const,
      targetProof: true,
      sourceConnected: false,
    }
    this.journal.resolveCommitted(committed)
    this.deps.afterJournalCommitted?.()
    this.persistAcknowledgementCleanup(
      await this.acknowledgePromotedWithinDeadline(record.manifest, record.targetMachineId),
    )
    this.deps.afterCommitted?.({ serverUrl: record.publicUrl })
    return committed
  }

  private outcome(
    record: TransferRecord,
    ok: boolean,
    state: 'aborted' | 'committed' | 'commit-uncertain',
    error?: { code: string; message: string },
    cleanup?: { result: 'cleaned' | 'pending'; detail?: string },
  ): ServerTransferOutcome {
    return {
      ok,
      transferId: record.transferId,
      state,
      targetMachineId: record.targetMachineId,
      publicUrl: record.publicUrl,
      ...(error ? { error } : {}),
      ...(cleanup ? { cleanup } : {}),
    }
  }
}
