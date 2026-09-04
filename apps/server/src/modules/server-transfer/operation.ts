import { existsSync, writeFileSync } from 'node:fs'
import type { MachineId } from '@podium/model'
import type { Operation as ProtocolOperation, ServerBindHost } from '@podium/protocol'
import type { ServerTransferOutcome, TransferJournalEntry, TransferRecord } from './types'
import type { OperationEngine } from '../operations/engine'
import { ADOPTION_DEFERRED, type OperationKindDefinition } from '../operations/kinds'
import { LIFECYCLE_EXCLUSION_GROUP } from '../operations/lifecycle'
import {
  type ServerTransferCrashPoint,
  ServerTransferError,
  type ServerTransferService,
} from './service'
import {
  type ServerTransferAuthorization,
  type ServerTransferInput,
  TRANSFER_FAILURE_CODES,
} from './types'

export const SERVER_MOVE_OPERATION_KIND = 'server-move'
export const SERVER_MOVE_RECOVERY_ACTION = 'server-move-recovery'

export interface ServerMoveContext {
  service: ServerTransferService
  engine: OperationEngine
  input: ServerTransferInput
  authorization: ServerTransferAuthorization
  authorizedBy: string
  transferId: string
  sourceMachineId: MachineId
  publicUrl: string
  bindHost: ServerBindHost
  port: number
  retryOf?: string
  crash?: (point: ServerTransferCrashPoint) => void | Promise<void>
  run?: ServerMoveRun
}

export interface ServerMoveReality {
  promoted?: {
    operationId: string
    transferId: string
    sourceMachineId: string
    targetMachineId: string
    manifestDigest: string
    publicUrl: string
    bindHost: ServerBindHost
    port: number
  } | null
  promoting?: {
    operationId: string
    transferId: string
    sourceMachineId: string
    targetMachineId: string
    manifestDigest: string
    publicUrl: string
    bindHost: ServerBindHost
    port: number
  } | null
  machineId?: string
  targetOnline?: boolean
  journal?: TransferJournalEntry
  now: number
}

type MovePhase = 'preflight' | 'stage' | 'validate'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

interface ServerMoveRun {
  promise: Promise<ServerTransferOutcome>
  sealReady: Deferred<TransferRecord>
  continueAfterSeal: Deferred<void>
  currentPhase: MovePhase
  canceled: boolean
  sealed: boolean
}

export function serverMoveFaultHook(
  env: NodeJS.ProcessEnv = process.env,
): ((point: ServerTransferCrashPoint) => void) | undefined {
  const crashPoint = env.PODIUM_SERVER_MOVE_CRASH_POINT
  const failPoint = env.PODIUM_SERVER_MOVE_FAIL_POINT
  const marker = env.PODIUM_SERVER_MOVE_FAULT_ONCE_FILE
  const commitEvidence = env.PODIUM_SERVER_MOVE_COMMIT_EVIDENCE_FILE
  if (!crashPoint && !failPoint && !commitEvidence) return undefined
  return (point) => {
    if (point === 'after-commit' && commitEvidence) {
      writeFileSync(commitEvidence, `${point}\n`)
    }
    if (point !== crashPoint && point !== failPoint) return
    if (marker && existsSync(marker)) return
    if (marker) writeFileSync(marker, `${point}\n`)
    if (point === crashPoint) process.exit(86)
    throw new ServerTransferError(
      TRANSFER_FAILURE_CODES.SNAPSHOT_FAILED,
      `injected server-move failure at ${point}`,
    )
  }
}

function deferred<T>(): Deferred<T> {
  let settled = false
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
  }
}

type MoveDetails = {
  transferId: string
  sourceMachineId: string
  targetMachineId: string
  publicUrl: string
  bindHost: ServerBindHost
  port: number
  manifestDigest?: string
  authorizedBy: string
  intent: {
    targetMachineId: string
    publicUrl: string
    bindHost: ServerBindHost
    port: number
    confirmation: 'satisfied'
  }
  handoff?: Record<string, unknown>
  [key: string]: unknown
}

function detailsOf(operation: ProtocolOperation): MoveDetails | undefined {
  const details = operation.details as MoveDetails | undefined
  if (
    !details ||
    typeof details.transferId !== 'string' ||
    typeof details.sourceMachineId !== 'string' ||
    typeof details.targetMachineId !== 'string' ||
    typeof details.publicUrl !== 'string' ||
    (details.bindHost !== '127.0.0.1' && details.bindHost !== '0.0.0.0') ||
    typeof details.port !== 'number' ||
    typeof details.authorizedBy !== 'string' ||
    !details.intent ||
    typeof details.intent !== 'object' ||
    details.intent.targetMachineId !== details.targetMachineId ||
    details.intent.publicUrl !== details.publicUrl ||
    details.intent.bindHost !== details.bindHost ||
    details.intent.port !== details.port ||
    details.intent.confirmation !== 'satisfied'
  ) {
    return undefined
  }
  return details
}

function patchStep(
  operation: ProtocolOperation,
  id: string,
  patch: Record<string, unknown>,
): ProtocolOperation {
  return {
    ...operation,
    steps: (operation.steps ?? []).map((step) => (step.id === id ? { ...step, ...patch } : step)),
  }
}

export function projectRecoveryOperation(
  operation: ProtocolOperation,
  journal: TransferJournalEntry | undefined,
  _now: number,
  inFlightDrive = false,
): ProtocolOperation {
  if (!journal) return operation
  const ask = {
    id: SERVER_MOVE_RECOVERY_ACTION,
    required: true,
    title: "The switch's outcome is unknown",
    detail: 'Check the new server to reconcile the durable promotion proof.',
  }
  if (journal.state === 'source-fenced') {
    const projected = patchStep(
      patchStep(operation, 'fence', { state: 'done', detail: 'ready to switch' }),
      'cutover',
      { state: 'pending', detail: 'ready to switch' },
    )
    return { ...projected, ...(inFlightDrive ? {} : { awaiting: [ask] }) }
  }
  if (journal.state === 'committing') {
    const projected = patchStep(patchStep(operation, 'fence', { state: 'done' }), 'cutover', {
      state: 'running',
      detail: 'switching servers',
    })
    return { ...projected, ...(inFlightDrive ? {} : { awaiting: [ask] }) }
  }
  if (journal.state === 'commit-uncertain') {
    const projected = patchStep(patchStep(operation, 'fence', { state: 'done' }), 'cutover', {
      state: 'stalled',
      detail: "the switch's outcome is unknown",
    })
    return { ...projected, state: 'waiting', awaiting: [ask] }
  }
  return operation
}

export function reconcileServerMoveOperation(
  operation: ProtocolOperation,
  reality: ServerMoveReality,
): ProtocolOperation | typeof ADOPTION_DEFERRED {
  const details = detailsOf(operation)
  if (!details) {
    return {
      ...operation,
      state: 'failed',
      error: { code: 'handoff-orphaned', message: 'The server move identity is incomplete.' },
      finishedAt: reality.now,
    }
  }
  const journal = reality.journal
  const journalDigest = journal?.record.manifest?.digest
  const exactResumableSource =
    journal &&
    ['preparing', 'staged', 'validated', 'fence-pending'].includes(journal.state) &&
    journal.record.operationId === operation.id &&
    journal.record.transferId === details.transferId &&
    journal.record.sourceMachineId === details.sourceMachineId &&
    journal.record.targetMachineId === details.targetMachineId &&
    journal.record.publicUrl === details.publicUrl &&
    journal.record.bindHost === details.bindHost &&
    journal.record.port === details.port &&
    journalDigest === details.manifestDigest &&
    reality.machineId === details.sourceMachineId
  if (exactResumableSource) {
    if (reality.targetOnline === false) return ADOPTION_DEFERRED
    const { _handoff: _staleSeal, ...adoptedDetails } = details
    return { ...operation, state: 'running', details: adoptedDetails }
  }
  if (journal?.state === 'aborted' && journal.error?.code === 'boot-recovery') {
    return {
      ...operation,
      state: 'failed',
      error: { code: 'boot-recovery', message: journal.error.message },
      finishedAt: reality.now,
    }
  }
  const promoted = reality.promoted
  if (
    promoted &&
    promoted.operationId === operation.id &&
    promoted.sourceMachineId === details.sourceMachineId &&
    promoted.targetMachineId === details.targetMachineId &&
    (reality.machineId === undefined || reality.machineId === details.targetMachineId) &&
    promoted.publicUrl === details.publicUrl &&
    promoted.bindHost === details.bindHost &&
    promoted.port === details.port
  ) {
    let reconciled = patchStep(operation, 'fence', {
      state: 'done',
      detail: 'This server was paused for the move.',
      finishedAt: reality.now,
    })
    reconciled = patchStep(reconciled, 'cutover', {
      state: 'done',
      detail: 'This machine is now the server.',
      finishedAt: reality.now,
    })
    return {
      ...reconciled,
      state: 'done',
      details: {
        ...details,
        handoff: { ...(details.handoff ?? {}), role: 'completed-on-target' },
      },
      awaiting: [],
      error: null,
      finishedAt: reality.now,
    }
  }
  // Starting the target server is what the daemon health-checks, so the exact
  // target-owned stage can still be `promoting` on this first boot. Its
  // candidate proof is internally bound to the final transfer id and digest by
  // target-status; stable move identity binds that candidate to this imported
  // operation. This verdict deliberately writes and runs nothing.
  const promoting = reality.promoting
  if (
    promoting &&
    promoting.operationId === operation.id &&
    promoting.sourceMachineId === details.sourceMachineId &&
    promoting.targetMachineId === details.targetMachineId &&
    promoting.publicUrl === details.publicUrl &&
    promoting.bindHost === details.bindHost &&
    promoting.port === details.port &&
    reality.machineId === details.targetMachineId
  ) {
    return ADOPTION_DEFERRED
  }
  return {
    ...operation,
    state: 'failed',
    error: {
      code: 'handoff-orphaned',
      message: 'The promoted server proof does not match this move.',
    },
    finishedAt: reality.now,
  }
}

function ensureMoveRun(operation: ProtocolOperation, context: ServerMoveContext): ServerMoveRun {
  if (context.run) return context.run

  const sealReady = deferred<TransferRecord>()
  const continueAfterSeal = deferred<void>()
  const run: ServerMoveRun = {
    promise: Promise.resolve(undefined as never),
    sealReady,
    continueAfterSeal,
    currentPhase: 'preflight',
    canceled: false,
    sealed: false,
  }
  context.run = run

  const recordDetails = (record: TransferRecord) => {
    context.engine.recordDetails(operation.id, {
      transferId: record.transferId,
      manifestDigest: record.manifest?.digest,
      bytesCopied: record.bytesCopied,
      totalBytes: record.totalBytes,
      offlineMachineIds: record.offlineMachineIds ?? [],
    })
  }
  run.promise = context.service.transfer(context.input, context.authorization, {
    operationId: operation.id,
    transferId: context.transferId,
    canceled: () => run.canceled,
    ...(context.crash ? { crash: context.crash } : {}),
    onRecord: (record) => {
      recordDetails(record)
      if (run.currentPhase === 'stage') {
        void context.engine.recordProgress(operation.id, 'stage', {
          state: 'running',
          progress: { done: record.bytesCopied, total: record.totalBytes },
          detail: 'Copying server state',
        })
      }
    },
    onPhase: (phase, state, record) => {
      run.currentPhase = phase
      recordDetails(record)
      void context.engine.recordProgress(operation.id, phase, {
        state,
        ...(phase === 'stage'
          ? {
              progress: { done: record.bytesCopied, total: record.totalBytes },
              detail: state === 'done' ? 'Server state copied.' : 'Copying server state',
            }
          : {
              detail:
                state === 'done'
                  ? phase === 'preflight'
                    ? 'The move can start.'
                    : 'The copy was verified.'
                  : phase === 'preflight'
                    ? 'Checking the source and target.'
                    : 'Verifying the copy',
            }),
      })
    },
    beforeFence: async (record) => {
      recordDetails(record)
      sealReady.resolve(record)
      await continueAfterSeal.promise
    },
  })
  void run.promise.then(
    (outcome) => {
      if (outcome.state !== 'aborted' || run.sealed) return
      void context.engine.recordProgress(operation.id, run.currentPhase, {
        state: 'failed',
        error: outcome.error ?? {
          code: TRANSFER_FAILURE_CODES.SNAPSHOT_FAILED,
          message: 'The server move stopped before promotion.',
        },
      })
    },
    (error) => {
      if (run.sealed) return
      void context.engine.recordProgress(operation.id, run.currentPhase, {
        state: 'failed',
        error: {
          code: TRANSFER_FAILURE_CODES.INTERNAL,
          message: error instanceof Error ? error.message : String(error),
        },
      })
    },
  )
  return run
}

export function serverMoveOperationKind(
  service: ServerTransferService,
): OperationKindDefinition<ServerMoveContext, ServerMoveReality> {
  return {
    kind: SERVER_MOVE_OPERATION_KIND,
    exclusionGroup: LIFECYCLE_EXCLUSION_GROUP,
    plan: (context) => ({
      steps: [
        { id: 'preflight', title: 'Checking the move' },
        { id: 'stage', title: 'Copying server state' },
        { id: 'validate', title: 'Verifying the copy' },
        { id: 'fence', title: 'Pausing this server' },
        { id: 'cutover', title: 'Switching servers' },
      ],
      details: {
        transferId: context.transferId,
        sourceMachineId: context.sourceMachineId,
        targetMachineId: context.input.targetMachineId,
        publicUrl: context.publicUrl,
        bindHost: context.bindHost,
        port: context.port,
        bytesCopied: 0,
        totalBytes: 0,
        authorizedBy: context.authorizedBy,
        intent: {
          targetMachineId: context.input.targetMachineId,
          publicUrl: context.publicUrl,
          bindHost: context.bindHost,
          port: context.port,
          confirmation: 'satisfied',
        },
      },
      ...(context.retryOf ? { retryOf: context.retryOf } : {}),
    }),
    reconcile: reconcileServerMoveOperation,
    runners: {
      preflight: {
        reversible: true,
        ensure: async ({ operation, context }) => {
          ensureMoveRun(operation, context)
          return { state: 'running', detail: 'Checking the source and target.' }
        },
      },
      stage: {
        reversible: true,
        ensure: async ({ operation, context }) => {
          ensureMoveRun(operation, context)
          return { state: 'running', detail: 'Copying server state' }
        },
      },
      validate: {
        reversible: true,
        ensure: async ({ operation, context }) => {
          ensureMoveRun(operation, context)
          return { state: 'running', detail: 'Verifying the copy' }
        },
      },
      fence: {
        ensure: async ({ operation, context }) => {
          const run = context.run
          if (!run) {
            return {
              state: 'failed',
              error: { code: 'boot-recovery', message: 'The move cutover context was lost.' },
            }
          }
          const record = await run.sealReady.promise
          context.engine.sealForHandoff(operation.id, 'fence', {
            step: { detail: 'pausing' },
            detailsPatch: {
              transferId: record.transferId,
              manifestDigest: record.manifest?.digest,
              bytesCopied: record.bytesCopied,
              totalBytes: record.totalBytes,
              handoff: {
                role: 'source',
                transferId: record.transferId,
                targetMachineId: record.targetMachineId,
                publicUrl: record.publicUrl,
                bindHost: record.bindHost,
                port: record.port,
                sealedAt: Date.now(),
              },
            },
          })
          run.sealed = true
          run.continueAfterSeal.resolve()

          let outcome: ServerTransferOutcome
          try {
            outcome = await run.promise
          } catch (error) {
            const journalState = context.service.status()?.state
            if (
              journalState === 'committing' ||
              journalState === 'commit-uncertain' ||
              journalState === 'committed'
            ) {
              return { state: 'handed-off' }
            }
            context.engine.reclaimHandoff(operation.id)
            return {
              state: 'failed',
              error: {
                code: TRANSFER_FAILURE_CODES.INTERNAL,
                message: error instanceof Error ? error.message : String(error),
              },
            }
          }
          if (outcome.state === 'aborted') {
            const journalState = context.service.status()?.state
            if (journalState !== 'aborted') return { state: 'handed-off' }
            context.engine.reclaimHandoff(operation.id)
            return {
              state: 'failed',
              error: outcome.error ?? {
                code: TRANSFER_FAILURE_CODES.SNAPSHOT_FAILED,
                message: 'The server move stopped before promotion.',
              },
            }
          }
          return { state: 'handed-off' }
        },
      },
    },
    deadlines: {
      preflight: { silenceMs: 60_000, totalMs: 5 * 60_000 },
      stage: { silenceMs: 3 * 60_000, totalMs: 30 * 60_000 },
      validate: { silenceMs: 60_000, totalMs: 5 * 60_000 },
      fence: { silenceMs: 2 * 60_000, totalMs: 10 * 60_000 },
      '#cancel': { totalMs: 60_000 },
    },
    projectSealed: (operation, projection) =>
      projectRecoveryOperation(operation, service.status(), Date.now(), projection.inFlightDrive),
    onAction: async ({ actionId }) => {
      if (actionId !== SERVER_MOVE_RECOVERY_ACTION) return { outcome: 'not-offered' }
      return service.recover()
    },
    onCancel: async ({ context }) => {
      const run = context.run
      if (!run) return { cleanup: 'complete' }
      run.canceled = true
      try {
        const outcome = await run.promise
        if (outcome.cleanup?.result === 'pending') {
          return {
            cleanup: 'pending',
            pending: [{ what: outcome.cleanup.detail ?? 'target stage cleanup', retryable: true }],
          }
        }
        return { cleanup: 'complete' }
      } catch {
        return { cleanup: 'complete' }
      }
    },
  }
}
