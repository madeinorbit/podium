import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId } from '@podium/model'
import type { Operation } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { ADOPTION_DEFERRED } from '../operations/kinds'
import {
  projectRecoveryOperation,
  reconcileServerMoveOperation,
  serverMoveFaultHook,
  serverMoveOperationKind,
} from './operation'
import type { ServerTransferService } from './service'
import type { TransferJournalEntry, TransferRecord } from './types'

const details = {
  transferId: 'transfer-1',
  sourceMachineId: 'source-1',
  targetMachineId: 'target-1',
  publicUrl: 'https://podium.example.com',
  bindHost: '0.0.0.0' as const,
  port: 443,
  manifestDigest: 'a'.repeat(64),
  authorizedBy: 'user:sole',
  intent: {
    targetMachineId: 'target-1',
    publicUrl: 'https://podium.example.com',
    bindHost: '0.0.0.0' as const,
    port: 443,
    confirmation: 'satisfied' as const,
  },
  _handoff: { stepId: 'fence', sealedAt: 10 },
}

const operation = (): Operation => ({
  id: 'operation-1',
  kind: 'server-move',
  exclusionGroup: 'lifecycle',
  state: 'running',
  createdAt: 1,
  startedAt: 1,
  updatedAt: 1,
  steps: [
    { id: 'preflight', title: 'Checking the move', state: 'done' },
    { id: 'stage', title: 'Copying server state', state: 'done' },
    { id: 'validate', title: 'Verifying the copy', state: 'done' },
    { id: 'fence', title: 'Pausing this server', state: 'running' },
    { id: 'cutover', title: 'Switching servers', state: 'pending' },
  ],
  details,
  awaiting: [],
  deferred: [],
  error: null,
})

function journal(state: TransferJournalEntry['state']): TransferJournalEntry {
  const record: TransferRecord = {
    operationId: 'operation-1',
    phase: 'switching',
    bytesCopied: 10,
    totalBytes: 10,
    transferId: 'transfer-1',
    targetMachineId: asMachineId('target-1'),
    publicUrl: 'https://podium.example.com',
    bindHost: '0.0.0.0' as const,
    port: 443,
    sourceMachineId: asMachineId('source-1'),
    sourceInstanceId: 'instance-1',
    packageDir: '/state/.server-transfer/snapshot',
    manifest: {
      formatVersion: 1,
      operationId: 'operation-1',
      transferId: 'transfer-1',
      sourceInstanceId: 'instance-1',
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      sourceFeedId: 'feed-1',
      sourceFeedEpoch: 'epoch-1',
      appVersion: 'test',
      schemaVersion: 'schema-1',
      packageBytes: 0,
      files: [],
      digest: 'a'.repeat(64),
    },
    idempotencyKey: 'transfer-1',
    targetProof: state !== 'source-fenced',
    sourceConnected: false,
  }
  return {
    formatVersion: 1,
    state,
    record,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:01.000Z',
  }
}

describe('server-move operation', () => {
  it('writes opt-in commit evidence and honors a one-shot failure marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'podium-server-move-hook-'))
    const commitEvidence = join(root, 'commit-evidence')
    const faultMarker = join(root, 'fault-once')
    const newline = String.fromCharCode(10)
    try {
      const hook = serverMoveFaultHook({
        PODIUM_SERVER_MOVE_COMMIT_EVIDENCE_FILE: commitEvidence,
        PODIUM_SERVER_MOVE_FAIL_POINT: 'after-seal',
        PODIUM_SERVER_MOVE_FAULT_ONCE_FILE: faultMarker,
      } as NodeJS.ProcessEnv)

      expect(() => hook?.('after-commit')).not.toThrow()
      await expect(readFile(commitEvidence, 'utf8')).resolves.toBe('after-commit' + newline)
      expect(() => hook?.('after-seal')).toThrow(/injected server-move failure/)
      await expect(readFile(faultMarker, 'utf8')).resolves.toBe('after-seal' + newline)
      expect(() => hook?.('after-seal')).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('declares the stable five-step lifecycle plan with only pre-fence cancellation', async () => {
    const kind = serverMoveOperationKind({} as ServerTransferService)
    const plan = await kind.plan({
      transferId: 'transfer-1',
      sourceMachineId: asMachineId('source-1'),
      input: {
        targetMachineId: asMachineId('target-1'),
        publicUrl: 'https://podium.example.com',
        bindHost: '0.0.0.0' as const,
        port: 443,
        confirmation: 'TRANSFER SERVER',
      },
      publicUrl: 'https://podium.example.com',
      bindHost: '0.0.0.0' as const,
      port: 443,
      authorizedBy: 'user:sole',
    } as never)

    expect(plan.steps.map(({ id }) => id)).toEqual([
      'preflight',
      'stage',
      'validate',
      'fence',
      'cutover',
    ])
    expect(kind.runners.preflight?.reversible).toBe(true)
    expect(kind.runners.stage?.reversible).toBe(true)
    expect(kind.runners.validate?.reversible).toBe(true)
    expect(kind.runners.fence?.reversible).not.toBe(true)
    expect(kind.runners.cutover).toBeUndefined()
  })

  it.each([
    ['source-fenced', 'pending', 'running'],
    ['committing', 'running', 'running'],
    ['commit-uncertain', 'stalled', 'waiting'],
  ] as const)('projects %s journal facts through one deterministic recovery ask', (state, cutover, operationState) => {
    const projected = projectRecoveryOperation(operation(), journal(state), 100)
    expect(projected.state).toBe(operationState)
    expect(projected.steps?.find((step) => step.id === 'fence')?.state).toBe('done')
    expect(projected.steps?.find((step) => step.id === 'cutover')?.state).toBe(cutover)
    expect(projected.awaiting).toEqual([
      expect.objectContaining({ id: 'server-move-recovery', required: true }),
    ])
  })

  it('does not offer source-fenced recovery while the sealing runner still owns the drive', () => {
    const projected = projectRecoveryOperation(operation(), journal('source-fenced'), 100, true)
    expect(projected.awaiting).toEqual([])
    const uncertain = projectRecoveryOperation(operation(), journal('commit-uncertain'), 100, true)
    expect(uncertain.awaiting).toEqual([
      expect.objectContaining({ id: 'server-move-recovery', required: true }),
    ])
  })

  it('strictly defers an exact promoting target, then settles only exact promoted proof', () => {
    const promoting = {
      operationId: 'operation-1',
      transferId: 'final-transfer',
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      manifestDigest: 'b'.repeat(64),
      publicUrl: 'https://podium.example.com',
      bindHost: '0.0.0.0' as const,
      port: 443,
    }
    expect(
      reconcileServerMoveOperation(operation(), {
        promoting,
        machineId: 'target-1',
        now: 100,
      }),
    ).toBe(ADOPTION_DEFERRED)

    expect(
      reconcileServerMoveOperation(operation(), {
        promoting,
        promoted: promoting,
        machineId: 'target-1',
        now: 101,
      }),
    ).toMatchObject({ state: 'done', finishedAt: 101 })

    expect(
      reconcileServerMoveOperation(operation(), {
        promoting: { ...promoting, publicUrl: 'https://other.example.com' },
        machineId: 'target-1',
        now: 100,
      }),
    ).toMatchObject({ state: 'failed', error: { code: 'handoff-orphaned' } })

    expect(
      reconcileServerMoveOperation(operation(), {
        promoted: promoting,
        machineId: 'target-1',
        now: 101,
      }),
    ).toMatchObject({ state: 'done', finishedAt: 101 })
  })

  it('adopts an exact promoted proof as done and rejects every mismatched identity', () => {
    const promoted = {
      operationId: 'operation-1',
      transferId: 'transfer-1',
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      manifestDigest: 'a'.repeat(64),
      publicUrl: 'https://podium.example.com',
      bindHost: '0.0.0.0' as const,
      port: 443,
    }
    const done = reconcileServerMoveOperation(operation(), {
      promoted,
      machineId: 'target-1',
      now: 100,
    })
    if (done === ADOPTION_DEFERRED) throw new Error('promoted proof unexpectedly deferred')
    expect(done).toMatchObject({ state: 'done', finishedAt: 100 })
    expect(done.steps?.map((step) => [step.id, step.state])).toContainEqual(['cutover', 'done'])

    const driftedFinalProof = reconcileServerMoveOperation(operation(), {
      promoted: {
        ...promoted,
        transferId: 'transfer-final',
        manifestDigest: 'b'.repeat(64),
      },
      now: 100,
    })
    expect(driftedFinalProof).toMatchObject({ state: 'done', finishedAt: 100 })

    for (const mismatch of [
      { ...promoted, operationId: 'operation-other' },
      { ...promoted, sourceMachineId: 'source-other' },
      { ...promoted, targetMachineId: 'target-other' },
      { ...promoted, publicUrl: 'https://other.example.com' },
      { ...promoted, bindHost: '127.0.0.1' as const },
      { ...promoted, port: 8443 },
    ]) {
      expect(
        reconcileServerMoveOperation(operation(), { promoted: mismatch, now: 100 }),
      ).toMatchObject({ state: 'failed', error: { code: 'handoff-orphaned' } })
    }
    expect(
      reconcileServerMoveOperation(operation(), { promoted, machineId: 'machine-other', now: 100 }),
    ).toMatchObject({ state: 'failed', error: { code: 'handoff-orphaned' } })
  })

  it('refuses adoption when the persisted intent differs from the operation identity', () => {
    const mismatched = operation()
    mismatched.details = {
      ...mismatched.details,
      intent: { ...details.intent, publicUrl: 'https://other.example.com' },
    }
    expect(reconcileServerMoveOperation(mismatched, { now: 100 })).toMatchObject({
      state: 'failed',
      error: { code: 'handoff-orphaned' },
    })
  })

  it('defers only an exact resumable source journal while its target is offline', () => {
    const exact = journal('validated')
    expect(
      reconcileServerMoveOperation(operation(), {
        journal: exact,
        machineId: 'source-1',
        targetOnline: false,
        now: 100,
      }),
    ).toBe(ADOPTION_DEFERRED)

    const resumed = reconcileServerMoveOperation(operation(), {
      journal: exact,
      machineId: 'source-1',
      targetOnline: true,
      now: 101,
    })
    if (resumed === ADOPTION_DEFERRED) throw new Error('online target unexpectedly deferred')
    expect(resumed.state).toBe('running')
    expect(resumed.details).not.toHaveProperty('_handoff')

    for (const mismatched of [
      { ...exact, record: { ...exact.record, operationId: 'operation-other' } },
      { ...exact, record: { ...exact.record, sourceMachineId: asMachineId('source-other') } },
      { ...exact, record: { ...exact.record, bindHost: '127.0.0.1' as const } },
      { ...exact, record: { ...exact.record, port: 8443 } },
    ]) {
      expect(
        reconcileServerMoveOperation(operation(), {
          journal: mismatched,
          machineId: 'source-1',
          targetOnline: false,
          now: 102,
        }),
      ).toMatchObject({ state: 'failed', error: { code: 'handoff-orphaned' } })
    }
  })
})
