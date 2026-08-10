import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { validatePublicUrl } from '@podium/runtime/setup'
import { TransferJournal, isActiveTransfer } from './journal'
import { TransferLock } from './lock'
import {
  MAX_TRANSFER_BYTES,
  TRANSFER_SPACE_MARGIN_BYTES,
  assertSnapshotCapacity,
  createPortableSnapshot,
  estimatePortableBytes,
  manifestWithDigest,
} from './manifest'
import {
  SERVER_TRANSFER_CONFIRMATION,
  TRANSFER_FAILURE_CODES,
  type ServerTransferAuthorization,
  type PromotedTargetMetadata,
  type ServerTransferInput,
  type ServerTransferManifest,
  type ServerTransferOutcome,
  type ServerTransferRpc,
  type TargetHealthProof,
  type TransferFailureCode,
  type TransferProof,
  type TransferRecord,
} from './types'

const CHUNK_BYTES = 512 * 1024

export interface ServerTransferTargetState {
  exists: boolean
  online: boolean
  capable: boolean
}

export interface ServerTransferDeps {
  stateRoot: string
  sourceInstanceId: string
  sourceMachineId: string
  sourceFeedIdentity: () => { feedId: string; feedEpoch: string }
  sourceApplicationVersion: string
  sourceSchemaVersion: () => string
  sourceWireSchemaDigest: string
  rpc: ServerTransferRpc
  targetState(machineId: string): ServerTransferTargetState
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
    targetMachineId: string
    publicUrl: string
  }): void | Promise<void>
  /** Called only after the committed journal has been fsync'd. */
  afterCommitted?(input: { serverUrl: string }): void
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
  targetMachineId: string,
): proof is TransferProof {
  return (
    proof !== undefined &&
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
  targetMachineId: string,
  publicUrl: string,
): proof is TargetHealthProof {
  return (
    proofMatches(proof, manifest, targetMachineId) &&
    proof.health === 'serving' &&
    proof.publicUrl === publicUrl
  )
}

function normalizedPublicUrl(input: ServerTransferInput): string {
  if (input.confirmation !== SERVER_TRANSFER_CONFIRMATION) {
    throw fail(
      TRANSFER_FAILURE_CODES.INVALID_CONFIRMATION,
      'server transfer confirmation is invalid',
    )
  }
  const checked = validatePublicUrl(input.publicUrl.trim())
  if (!checked.ok) throw fail(TRANSFER_FAILURE_CODES.INVALID_URL, checked.error)
  const parsed = new URL(checked.normalized)
  if (input.port !== undefined) {
    const effectivePort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
    if (effectivePort !== input.port) {
      throw fail(
        TRANSFER_FAILURE_CODES.INVALID_URL,
        'the selected target port does not match the public URL',
      )
    }
  }
  return checked.normalized
}

async function uploadSnapshot(
  packageDir: string,
  manifest: ServerTransferManifest,
  targetMachineId: string,
  rpc: ServerTransferRpc,
  onProgress: (bytesCopied: number, totalBytes: number) => void,
): Promise<void> {
  let copied = 0
  for (let fileIndex = 0; fileIndex < manifest.files.length; fileIndex += 1) {
    const entry = manifest.files[fileIndex]
    if (!entry) throw fail(TRANSFER_FAILURE_CODES.INTERNAL, 'manifest file index is missing')
    let offset = 0
    for await (const part of createReadStream(join(packageDir, ...entry.path.split('/')), {
      highWaterMark: CHUNK_BYTES,
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

  status() {
    return this.journal.read()
  }

  async publicStatus(machines: ReadonlyArray<{ id: string }>) {
    const entry = this.journal.read()
    const promoted = entry ? undefined : await this.deps.localPromotedTransfer()
    const promotedSourceConnected = promoted
      ? this.deps.targetState(promoted.sourceMachineId).online
      : false
    return {
      sourceMachineId: promoted?.sourceMachineId ?? this.deps.sourceMachineId,
      targetEligibility: machines.map(({ id }) => {
        if (id === this.deps.sourceMachineId) {
          return { targetMachineId: id, eligible: false, reason: 'current-server' } as const
        }
        const target = this.deps.targetState(id)
        if (!target.online) {
          return { targetMachineId: id, eligible: false, reason: 'offline' } as const
        }
        if (!target.capable) {
          return { targetMachineId: id, eligible: false, reason: 'unsupported' } as const
        }
        return { targetMachineId: id, eligible: true } as const
      }),
      transfer: entry
        ? {
            transferId: entry.record.transferId,
            targetMachineId: entry.record.targetMachineId,
            publicUrl: entry.record.publicUrl,
            state: entry.state,
            sourceFenced:
              entry.state === 'source-fenced' ||
              entry.state === 'committing' ||
              entry.state === 'committed' ||
              entry.state === 'commit-uncertain',
            phase: entry.record.phase,
            bytesCopied: entry.record.bytesCopied,
            totalBytes: entry.record.totalBytes,
            targetProof: entry.record.targetProof,
            sourceConnected: entry.record.sourceConnected,
            ...(entry.error ? { error: entry.error } : {}),
            ...(entry.cleanup ? { cleanup: entry.cleanup } : {}),
          }
        : promoted
          ? {
              transferId: promoted.transferId,
              targetMachineId: promoted.targetMachineId,
              publicUrl: promoted.publicUrl,
              state: 'committed' as const,
              sourceFenced: true,
              phase: promotedSourceConnected ? ('connected' as const) : ('switching' as const),
              targetProof: true,
              sourceConnected: promotedSourceConnected,
            }
          : null,
    }
  }

  async transfer(
    input: ServerTransferInput,
    authorization: ServerTransferAuthorization,
  ): Promise<ServerTransferOutcome> {
    const publicUrl = normalizedPublicUrl(input)
    await this.lock.acquire()
    try {
      const existing = this.journal.read()
      if (existing?.state === 'committed') {
        if (
          existing.record.targetMachineId === input.targetMachineId &&
          existing.record.publicUrl === publicUrl
        ) {
          return this.outcome(existing.record, true, 'committed')
        }
        throw fail(
          TRANSFER_FAILURE_CODES.ACTIVE_TRANSFER,
          'the server was already transferred to another target',
        )
      }
      if (existing?.state === 'commit-uncertain') {
        return this.inspectUncertain(existing.record, authorization)
      }
      if (existing && isActiveTransfer(existing.state)) {
        throw fail(
          TRANSFER_FAILURE_CODES.ACTIVE_TRANSFER,
          `a server transfer is already ${existing.state}`,
        )
      }

      await authorization.reauthorize('prepare')
      await this.preflight(input)

      const operationId = this.uuid()
      const probeTransferId = this.uuid()
      const initialPackageDir = join(
        this.deps.stateRoot,
        '.server-transfer',
        'snapshots',
        operationId,
        'initial',
      )
      let record: TransferRecord = {
        operationId,
        phase: 'preparing',
        bytesCopied: 0,
        totalBytes: 0,
        transferId: probeTransferId,
        targetMachineId: input.targetMachineId,
        publicUrl,
        ...(input.port === undefined ? {} : { port: input.port }),
        sourceMachineId: this.deps.sourceMachineId,
        sourceInstanceId: this.deps.sourceInstanceId,
        packageDir: initialPackageDir,
        manifest: null,
        idempotencyKey: probeTransferId,
        targetProof: false,
        sourceConnected: false,
      }
      this.journal.begin(record)

      let prepared: { transferId: string; manifestDigest: string } | undefined
      let fenceHeld = false
      const persistProgress = (bytesCopied: number, totalBytes: number) => {
        record = { ...record, phase: 'copying', bytesCopied, totalBytes }
        this.journal.updateRecord(record)
      }
      try {
        const initialManifest = await this.snapshot(record, initialPackageDir)
        record = {
          ...record,
          manifest: initialManifest,
          phase: 'copying',
          bytesCopied: 0,
          totalBytes: initialManifest.packageBytes,
        }
        this.journal.updateRecord(record)

        await authorization.reauthorize('stage')
        this.assertTarget(input.targetMachineId)
        prepared = {
          transferId: initialManifest.transferId,
          manifestDigest: initialManifest.digest,
        }
        await this.stage(initialManifest, initialPackageDir, input.targetMachineId, persistProgress)
        this.journal.transition('staged')
        record = { ...record, phase: 'validating' }
        this.journal.updateRecord(record)

        await authorization.reauthorize('validate')
        this.assertTarget(input.targetMachineId)
        await this.validate(initialManifest, input.targetMachineId)
        this.journal.transition('validated')

        await authorization.reauthorize('fence')
        this.assertTarget(input.targetMachineId)
        record = { ...record, phase: 'switching' }
        this.journal.updateRecord(record)
        // Persist fence intent first. A crash after this write must not reopen a
        // writable source even if the in-memory gate was not fully installed.
        this.journal.transition('source-fenced')
        await this.deps.fence()
        fenceHeld = true

        const finalPackageDir = join(
          this.deps.stateRoot,
          '.server-transfer',
          'snapshots',
          operationId,
          'final',
        )
        let finalManifest = await this.snapshot(record, finalPackageDir)
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
          await this.stage(finalManifest, finalPackageDir, input.targetMachineId, persistProgress)
          record = { ...record, phase: 'validating' }
          this.journal.updateRecord(record)
          await authorization.reauthorize('validate')
          this.assertTarget(input.targetMachineId)
          await this.validate(finalManifest, input.targetMachineId)
        }

        record = { ...record, manifest: finalManifest, phase: 'switching', targetProof: true }
        this.journal.updateRecord(record)

        await authorization.reauthorize('commit')
        this.assertTarget(input.targetMachineId)
        this.journal.transition('committing')
        const promoted = await this.deps.rpc.serverTransferPromote(
          {
            transferId: finalManifest.transferId,
            manifestDigest: finalManifest.digest,
            publicUrl,
            ...(input.port === undefined ? {} : { port: input.port }),
            targetMode: 'server',
            idempotencyKey: record.idempotencyKey,
          },
          input.targetMachineId,
        )
        if (
          !promoted.ok ||
          promoted.state !== 'promoted' ||
          !healthProofMatches(promoted.proof, finalManifest, input.targetMachineId, publicUrl)
        ) {
          throw fail(
            TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN,
            promoted.ok ? 'target promotion proof is missing' : promoted.error.detail,
          )
        }

        const acknowledgementCleanup = await this.acknowledgePromoted(
          finalManifest,
          input.targetMachineId,
        )

        await this.deps.demoteSource({
          transferId: finalManifest.transferId,
          targetMachineId: input.targetMachineId,
          publicUrl,
        })
        record = { ...record, targetProof: true, sourceConnected: false }
        this.journal.commit(record, acknowledgementCleanup)
        fenceHeld = false
        this.deps.afterCommitted?.({ serverUrl: publicUrl })
        return this.outcome(
          record,
          true,
          'committed',
          undefined,
          acknowledgementCleanup,
        )
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
    targetMachineId: string,
    onProgress: (bytesCopied: number, totalBytes: number) => void,
  ): Promise<void> {
    const result = await this.deps.rpc.serverTransferPrepare(
      {
        transferId: manifest.transferId,
        sourceMachineId: this.deps.sourceMachineId,
        manifest,
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
    await uploadSnapshot(packageDir, manifest, targetMachineId, this.deps.rpc, onProgress)
  }

  private async validate(
    manifest: ServerTransferManifest,
    targetMachineId: string,
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
    targetMachineId: string,
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

  private async abortPrepared(
    prepared: { transferId: string; manifestDigest: string },
    targetMachineId: string,
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

  private async preflight(input: ServerTransferInput): Promise<void> {
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

  private assertTarget(targetMachineId: string): void {
    if (targetMachineId === this.deps.sourceMachineId) {
      throw fail(TRANSFER_FAILURE_CODES.TARGET_IS_SOURCE, 'target machine is the current server')
    }
    const target = this.deps.targetState(targetMachineId)
    if (!target.exists)
      throw fail(TRANSFER_FAILURE_CODES.TARGET_NOT_FOUND, 'target machine is unavailable')
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
        const status = await this.deps.rpc.serverTransferStatus(
          { transferId: record.transferId, manifestDigest: record.manifest.digest },
          record.targetMachineId,
        )
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
          )
        ) {
          const acknowledgementCleanup = await this.acknowledgePromoted(
            record.manifest,
            record.targetMachineId,
          )
          await this.deps.demoteSource({
            transferId: record.transferId,
            targetMachineId: record.targetMachineId,
            publicUrl: record.publicUrl,
          })
          const committed = {
            ...record,
            phase: 'switching' as const,
            targetProof: true,
            sourceConnected: false,
          }
          this.journal.resolveCommitted(committed, acknowledgementCleanup)
          this.deps.afterCommitted?.({ serverUrl: record.publicUrl })
          return this.outcome(
            committed,
            true,
            'committed',
            undefined,
            acknowledgementCleanup,
          )
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
