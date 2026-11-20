import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger, describeError } from '@podium/logger'
import { asMachineId, type MachineId } from '@podium/model'
import { validatePublicUrl } from '@podium/runtime/setup'
import { vaultCheckValue } from '@podium/runtime/vault-key'
import type { DaemonLinkKind } from '../../gateway/daemon-link-kind'
import type { HostMachine } from '../../host-machine'
import { afterCommit } from '../../store/executor/executor'
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
  type TransferVault,
} from './types'

const log = createLogger('server:server-transfer')

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
  /**
   * The target's daemon advertises `SERVER_MOVE_VAULT_KEY_CAPABILITY`: it can take
   * the vault's data key in promotion (epic Task 22). Absent reads as no.
   */
  vaultKeyHandover?: boolean
}

export interface ServerTransferDeps {
  stateRoot: string
  sourceInstanceId: string
  hostMachine: HostMachine
  sourceFeedIdentity: () =>
    | { feedId: string; feedEpoch: string }
    | Promise<{ feedId: string; feedEpoch: string }>
  sourceApplicationVersion: string
  sourceSchemaVersion: () => Promise<string>
  sourceWireSchemaDigest: string
  sourceCapable?(): Promise<boolean>
  rpc: ServerTransferRpc
  /** Direct endpoint control; absent only in narrow legacy unit seams. */
  endpointHandoff?: ServerEndpointHandoff
  targetState(machineId: MachineId): ServerTransferTargetState | Promise<ServerTransferTargetState>
  /** {@link targetState} for a whole fleet: ONE machines read, then a pure
   *  function answering for any id (POD-3257). Total by construction, so a
   *  caller in a loop never falls back to the per-machine form — which is the
   *  point, since that form is what re-read the table. */
  targetStateResolver():
    | ((machineId: MachineId) => ServerTransferTargetState | Promise<ServerTransferTargetState>)
    | Promise<
        (machineId: MachineId) => ServerTransferTargetState | Promise<ServerTransferTargetState>
      >
  localPromotedTransfer():
    | PromotedTargetMetadata
    | undefined
    | Promise<PromotedTargetMetadata | undefined>
  sourceHealthy(): Promise<void>
  checkpoint(): Promise<void>
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
  /**
   * The source vault (credential management design §7, "Moving the server"). Its
   * data key goes to the target in promotion, and its key file is deleted when the
   * transfer finalizes. Absent only in narrow legacy unit seams.
   */
  vault?: TransferVault
  /** How the target's daemon reaches this server, as the server judged it (§8). */
  targetLinkKind?(machineId: MachineId): DaemonLinkKind | undefined
  /** Deletes the source's key file at finalize. Default: remove it; absent is fine. */
  removeVaultKeyFile?(path: string): Promise<void>
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
  return { code: fallback, message: describeError(error) }
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

/** A key that was sent must come back proven; none sent, nothing to prove. */
function vaultCheckHolds(expected: string | undefined, observed: string | undefined): boolean {
  return expected === undefined || observed === expected
}

function pendingCleanup(
  ...parts: Array<{ result: 'pending'; detail: string } | undefined>
): { result: 'pending'; detail: string } | undefined {
  const details = parts.flatMap((part) => (part ? [part.detail] : []))
  return details.length > 0 ? { result: 'pending', detail: details.join('; ') } : undefined
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
  /**
   * Journal-record tick. PROMISE-TYPED BECAUSE IT WRITES THE STORE [POD-3820]:
   * the operation wiring persists the record and reports progress through the
   * operations engine. Typed `=> void` that wiring hid two dropped promises
   * behind a `void` signature — the POD-3802 shape. Handed to `afterCommit` at
   * both call sites so a per-chunk tick still does not block the upload and
   * never runs inside an open span.
   */
  onRecord?: (record: TransferRecord) => Promise<void>
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
    if (!this.deps.hostMachine)
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_UNSUPPORTED,
        'Server move is unavailable on this server: it has no host machine.',
      )
    return this.deps.hostMachine.id
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

  async publicStatus(machines: ReadonlyArray<{ id: string }>) {
    const entry = this.journal.read()
    const promoted = entry ? undefined : await this.deps.localPromotedTransfer()
    const promotedSourceConnected = promoted
      ? (await this.deps.targetState(promoted.sourceMachineId)).online
      : false
    // ONE machines read for the whole fleet (POD-3257). `targetState` reads the
    // WHOLE machines table to find one row, so asking it per machine inside the
    // map below was a full-table scan per machine — quadratic in fleet size, and
    // a round trip per machine on a networked backend.
    const targetOf = await this.deps.targetStateResolver()
    return {
      sourceMachineId: promoted?.sourceMachineId ?? this.deps.hostMachine?.id ?? null,
      targetEligibility: await Promise.all(
        machines.map(async ({ id }) => {
          if (!this.deps.hostMachine)
            return { targetMachineId: id, eligible: false, reason: 'unsupported' } as const
          if (id === this.deps.hostMachine.id) {
            return { targetMachineId: id, eligible: false, reason: 'current-server' } as const
          }
          const target = await targetOf(asMachineId(id))
          // Structural before live, the canonical ordering of POD-2700 §3.2.
          if (!target.hasDaemon) {
            return { targetMachineId: id, eligible: false, reason: 'no-daemon' } as const
          }
          if (!target.online) {
            return { targetMachineId: id, eligible: false, reason: 'offline' } as const
          }
          if (!target.capable) {
            return { targetMachineId: id, eligible: false, reason: 'unsupported' } as const
          }
          return { targetMachineId: id, eligible: true } as const
        }),
      ),
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
        return await this.inspectUncertain(existing.record, authorization)
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
        sourceMachineId: this.sourceMachineId(),
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

      /**
       * THE ONE HAND-OFF for `hooks.onRecord` [POD-3820].
       *
       * The dep persists the record and reports progress through the operations
       * engine — both store writes. It is called from a per-chunk upload tick,
       * so it must not be awaited there: that would serialise a journal write
       * and an engine write into the copy loop. `afterCommit` is the honest
       * middle: with a span open the tick waits for its COMMIT and runs at the
       * root, so the write can never JOIN the caller's span as a savepoint (the
       * POD-3802 refusal); with no span open it runs now, as before. The
       * rejection is caught here rather than left to surface from the drain,
       * because a progress tick must not fail a transfer.
       */
      const emitRecord = (tick: TransferRecord): void => {
        const onRecord = hooks.onRecord
        if (!onRecord) return
        afterCommit(async () => {
          try {
            await onRecord(tick)
          } catch (err) {
            log.warn('server transfer record hook failed', { err, operationId })
          }
        }, 'server-transfer-record')
      }
      let prepared: { transferId: string; manifestDigest: string } | undefined
      let fenceHeld = false
      let promoteNotSent = false
      const persistProgress = (bytesCopied: number, totalBytes: number) => {
        if (hooks.canceled?.()) {
          throw fail(TRANSFER_FAILURE_CODES.INTERNAL, 'server move canceled')
        }
        record = { ...record, phase: 'copying', bytesCopied, totalBytes }
        this.journal.updateRecord(record)
        emitRecord(record)
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
          emitRecord(record)
        }
        prepared = {
          transferId: initialManifest.transferId,
          manifestDigest: initialManifest.digest,
        }

        if (this.journal.read()?.state === 'preparing') {
          await authorization.reauthorize('stage')
          await this.assertTarget(input.targetMachineId)
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
          await this.assertTarget(input.targetMachineId)
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
        await this.deps.endpointHandoff?.prepareClientRelocations(record.operationId)
        await authorization.reauthorize('fence')
        await hooks.beforeFence?.(record)
        await hooks.crash?.('after-seal')
        await this.assertTarget(input.targetMachineId)
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
          await this.assertTarget(input.targetMachineId)
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
          await this.assertTarget(input.targetMachineId)
          await this.validate(finalManifest, input.targetMachineId)
        }

        record = { ...record, manifest: finalManifest, phase: 'switching', targetProof: true }
        this.journal.updateRecord(record)

        record = await this.prepareEndpointHandoff(record, finalManifest)

        await authorization.reauthorize('commit')
        await this.assertTarget(input.targetMachineId)
        this.journal.transition('committing')
        await hooks.crash?.('after-committing')
        const vault = this.vaultFields(finalManifest.transferId)
        const promoted = await this.deps.rpc.serverTransferPromote(
          {
            transferId: finalManifest.transferId,
            manifestDigest: finalManifest.digest,
            publicUrl,
            bindHost,
            port,
            targetMode: 'server',
            idempotencyKey: record.idempotencyKey,
            ...vault,
          },
          input.targetMachineId,
        )
        if (!promoted.ok && promoted.notSent === true) {
          // Refused at the send, never queued: the target saw no promote and no key,
          // so the commit never began and the transfer aborts.
          promoteNotSent = true
          throw fail(TRANSFER_FAILURE_CODES.TARGET_UNREACHABLE, promoted.error.detail)
        }
        if (
          !promoted.ok &&
          vault.vaultCheck !== undefined &&
          promoted.state === 'validated' &&
          promoted.vaultCheck !== undefined &&
          promoted.vaultCheck !== vault.vaultCheck
        ) {
          // The target refused before changing anything: the commit never began.
          throw fail(
            TRANSFER_FAILURE_CODES.VAULT_CHECK_FAILED,
            'the target could not open the vault key it was given, so the server stays here',
          )
        }
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
        if (!vaultCheckHolds(vault.vaultCheck, promoted.vaultCheck)) {
          throw fail(
            TRANSFER_FAILURE_CODES.COMMIT_UNCERTAIN,
            'the promoted target did not prove it holds the vault key',
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
        const keyFileCleanup = await this.retireVaultKeyFile()
        await hooks.crash?.('after-commit')
        fenceHeld = false
        const acknowledgementCleanup = this.persistAcknowledgementCleanup(
          pendingCleanup(
            await this.acknowledgePromotedWithinDeadline(finalManifest, input.targetMachineId),
            keyFileCleanup,
          ),
        )
        this.deps.afterCommitted?.({ serverUrl: publicUrl })
        return this.outcome(record, true, 'committed', undefined, acknowledgementCleanup)
      } catch (error) {
        const current = this.journal.read()
        const detail = classified(error)
        const refusedPromotion =
          current?.state === 'committing' &&
          (promoteNotSent ||
            (error instanceof ServerTransferError &&
              error.code === TRANSFER_FAILURE_CODES.VAULT_CHECK_FAILED))
        if (current?.state === 'committing' && !refusedPromotion) {
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
        await this.deps.endpointHandoff?.cancelClientRelocations(record.operationId)
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
        if (refusedPromotion) this.journal.abortRefusedPromotion(detail, cleanup)
        else this.journal.abort(detail, cleanup)
        return this.outcome(record, false, 'aborted', detail, cleanup)
      }
    } finally {
      await this.lock.release()
    }
  }

  private async snapshot(record: TransferRecord, packageDir: string) {
    const identity = await this.deps.sourceFeedIdentity()
    return await createPortableSnapshot({
      stateRoot: this.deps.stateRoot,
      packageDir,
      operationId: record.operationId,
      transferId: record.transferId,
      sourceInstanceId: this.deps.sourceInstanceId,
      sourceMachineId: this.sourceMachineId(),
      targetMachineId: record.targetMachineId,
      sourceFeedId: identity.feedId,
      sourceFeedEpoch: identity.feedEpoch,
      sourceApplicationVersion: this.deps.sourceApplicationVersion,
      sourceSchemaVersion: await this.deps.sourceSchemaVersion(),
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
        sourceMachineId: this.sourceMachineId(),
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
    const registered = (await endpoint.registeredMachineIds()).filter(
      (id) => id !== record.sourceMachineId && id !== record.targetMachineId,
    )
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
    this.sourceMachineId()
    // AWAITED. With a bare call this reads a Promise, which is never `=== false`,
    // so the refusal could never fire and an incapable source would proceed.
    if ((await this.deps.sourceCapable?.()) === false) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_UNSUPPORTED,
        'update this machine to the same Podium version as the target first',
      )
    }
    await this.assertTarget(input.targetMachineId)
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

  private async assertTarget(targetMachineId: MachineId): Promise<void> {
    if (targetMachineId === this.sourceMachineId()) {
      throw fail(TRANSFER_FAILURE_CODES.TARGET_IS_SOURCE, 'target machine is the current server')
    }
    const target = await this.deps.targetState(targetMachineId)
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
    // The server judged this link itself; nothing the daemon says about it counts.
    if (this.deps.targetLinkKind?.(targetMachineId) === 'plain') {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_LINK_NOT_ENCRYPTED,
        "the target machine's connection to this server is not encrypted, so the server and its stored credentials do not move to it. Connect it over wss, or declare its network trusted.",
      )
    }
    if (this.deps.vault?.state() === 'ready' && target.vaultKeyHandover !== true) {
      throw fail(
        TRANSFER_FAILURE_CODES.TARGET_UNSUPPORTED,
        'the target cannot take over the key to the stored credentials; update Podium on it first',
      )
    }
  }

  /**
   * The vault fields of one promote request (credential management design §7).
   * The data key is read for this request only and wiped here; the base64 copy
   * lives in the request alone, never in the record or the journal.
   */
  private vaultFields(transferId: string): { vaultDataKey?: string | null; vaultCheck?: string } {
    const vault = this.deps.vault
    if (!vault) return {}
    const dataKey = vault.exportDataKey()
    if (!dataKey) return { vaultDataKey: null }
    try {
      return {
        vaultDataKey: dataKey.toString('base64'),
        vaultCheck: vaultCheckValue(dataKey, transferId),
      }
    } finally {
      dataKey.fill(0)
    }
  }

  /**
   * The old server keeps no way into the vault: once the transfer is committed,
   * its key file goes. One it cannot delete (a mounted secret) is reported and
   * does not fail the transfer. A locked vault's file opens nothing and stays.
   */
  private async retireVaultKeyFile(): Promise<{ result: 'pending'; detail: string } | undefined> {
    const vault = this.deps.vault
    if (!vault) return undefined
    try {
      if (vault.state() === 'locked') return undefined
      const path = vault.status().keyPath
      try {
        await (this.deps.removeVaultKeyFile ?? ((file) => rm(file, { force: true })))(path)
        return undefined
      } catch (error) {
        const reason = describeError(error)
        log.warn('server transfer could not delete the vault key file', { path, reason })
        return {
          result: 'pending',
          detail: `the vault key file ${path} could not be deleted (${reason}); this machine no longer needs it, delete it by hand`,
        }
      }
    } catch (error) {
      return {
        result: 'pending',
        detail: `the vault key file was not checked: ${describeError(error)}`,
      }
    }
  }

  private async inspectUncertain(
    record: TransferRecord,
    authorization: ServerTransferAuthorization,
  ): Promise<ServerTransferOutcome> {
    await authorization.reauthorize('commit')
    if (record.manifest) {
      const vault = this.vaultFields(record.transferId)
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
              ...vault,
            },
            record.targetMachineId,
          )
          if (
            replay.ok &&
            replay.state === 'promoted' &&
            vaultCheckHolds(vault.vaultCheck, replay.vaultCheck) &&
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
          vaultCheckHolds(vault.vaultCheck, status.vaultCheck) &&
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
    const keyFileCleanup = await this.retireVaultKeyFile()
    this.persistAcknowledgementCleanup(
      pendingCleanup(
        await this.acknowledgePromotedWithinDeadline(record.manifest, record.targetMachineId),
        keyFileCleanup,
      ),
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
