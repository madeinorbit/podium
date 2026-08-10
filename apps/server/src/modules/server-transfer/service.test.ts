import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertWritableServerBoot } from './journal'
import { ServerTransferService } from './service'
import { readPromotedTargetMetadata } from './target-status'
import {
  SERVER_TRANSFER_CONFIRMATION,
  type ServerTransferManifest,
  type ServerTransferRpc,
} from './types'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'podium-server-transfer-'))
  await writeFile(join(root, 'podium.db'), 'db-v1')
  await writeFile(join(root, 'enrollment.ledger'), 'ledger-v1')
  await mkdir(join(root, 'transcripts'))
  await writeFile(join(root, 'transcripts', 'session.txt'), 'transcript-v1')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function fakeRpc(
  options: {
    onFirstChunk?: () => Promise<void>
    validateOk?: boolean
    promote?: 'ok' | 'throw' | 'throw-once'
    acknowledge?: 'ok' | 'throw'
  } = {},
) {
  const operations: string[] = []
  const manifests = new Map<string, ServerTransferManifest>()
  const chunks = new Map<string, Map<number, Buffer>>()
  let firstChunk = true
  let promotion: { transferId: string; targetMachineId: string; publicUrl: string } | undefined
  let promoteReplyLost = false
  const rpc: ServerTransferRpc = {
    serverTransferPrepare: vi.fn(async (input, targetMachineId) => {
      operations.push(`prepare:${input.transferId}`)
      manifests.set(input.transferId, input.manifest)
      chunks.set(input.transferId, new Map())
      return {
        ok: true,
        state: 'prepared',
        manifestDigest: input.manifest.digest,
        targetMachineId,
        targetCapability: 'server-only',
        buildVersion: 'test',
        wireSchemaDigest: 'wire-1',
        space: { availableBytes: 2_000_000_000, requiredBytes: 1, sufficient: true },
      }
    }),
    serverTransferChunk: vi.fn(async (input) => {
      operations.push(`chunk:${input.transferId}:${input.fileIndex}`)
      const byFile = chunks.get(input.transferId)
      if (!byFile) throw new Error('chunk before prepare')
      const previous = byFile.get(input.fileIndex) ?? Buffer.alloc(0)
      expect(input.offset).toBe(previous.length)
      byFile.set(input.fileIndex, Buffer.concat([previous, input.data]))
      if (firstChunk && options.onFirstChunk) {
        firstChunk = false
        await options.onFirstChunk()
      }
      return {
        ok: true,
        state: 'staging',
        manifestDigest: input.manifestDigest,
        path: manifests.get(input.transferId)?.files[input.fileIndex]?.path ?? 'missing',
        offset: input.offset,
        receivedBytes: input.data.length,
      }
    }),
    serverTransferValidate: vi.fn(async (input, targetMachineId) => {
      operations.push(`validate:${input.transferId}`)
      const manifest = manifests.get(input.transferId)
      if (!manifest || options.validateOk === false) {
        return {
          ok: false,
          state: 'staging',
          error: { code: 'digest-mismatch', detail: 'candidate validation failed' },
        }
      }
      return {
        ok: true,
        state: 'validated',
        proof: {
          transferId: input.transferId,
          manifestDigest: input.manifestDigest,
          targetMachineId,
          feedId: manifest.sourceFeedId,
          feedEpoch: manifest.sourceFeedEpoch,
          schemaVersion: manifest.schemaVersion,
          buildVersion: 'test',
        },
      }
    }),
    serverTransferPromote: vi.fn(async (input, targetMachineId) => {
      operations.push(`promote:${input.transferId}`)
      if (options.promote === 'throw') throw new Error('promotion reply lost')
      const manifest = manifests.get(input.transferId)
      if (!manifest) throw new Error('promotion before prepare')
      promotion = { transferId: input.transferId, targetMachineId, publicUrl: input.publicUrl }
      if (options.promote === 'throw-once' && !promoteReplyLost) {
        promoteReplyLost = true
        throw new Error('promotion reply lost')
      }
      return {
        ok: true,
        state: 'promoted',
        proof: {
          transferId: input.transferId,
          manifestDigest: input.manifestDigest,
          targetMachineId,
          feedId: manifest.sourceFeedId,
          feedEpoch: manifest.sourceFeedEpoch,
          schemaVersion: manifest.schemaVersion,
          buildVersion: 'test',
          health: 'serving',
          publicUrl: input.publicUrl,
        },
      }
    }),
    serverTransferAcknowledge: vi.fn(async (input) => {
      operations.push('acknowledge:' + input.transferId)
      if (options.acknowledge === 'throw') throw new Error('acknowledgement reply lost')
      return {
        ok: true,
        state: 'promoted',
        transferId: input.transferId,
        manifestDigest: input.manifestDigest,
        acknowledged: true,
      }
    }),
    serverTransferAbort: vi.fn(async (input) => {
      operations.push(`abort:${input.transferId}`)
      return {
        ok: true,
        state: 'aborted',
        transferId: input.transferId,
        manifestDigest: input.manifestDigest,
        cleanup: 'cleaned',
      }
    }),
    serverTransferStatus: vi.fn(async (statusInput) => {
      const manifest = statusInput.transferId ? manifests.get(statusInput.transferId) : undefined
      if (!manifest || !promotion || promotion.transferId !== statusInput.transferId) {
        return {
          ok: false,
          state: 'uncertain',
          error: { code: 'unknown', detail: 'no proof' },
        }
      }
      return {
        ok: true,
        state: 'promoted',
        transferId: promotion.transferId,
        manifestDigest: manifest.digest,
        proof: {
          transferId: promotion.transferId,
          manifestDigest: manifest.digest,
          targetMachineId: promotion.targetMachineId,
          feedId: manifest.sourceFeedId,
          feedEpoch: manifest.sourceFeedEpoch,
          schemaVersion: manifest.schemaVersion,
          buildVersion: 'test',
          health: 'serving',
          publicUrl: promotion.publicUrl,
        },
        sourceConnected: true,
      }
    }),
  }
  return { rpc, operations, manifests, chunks }
}

function makeService(
  rpc: ServerTransferRpc,
  overrides: Partial<ConstructorParameters<typeof ServerTransferService>[0]> = {},
) {
  let counter = 0
  return new ServerTransferService({
    stateRoot: root,
    sourceInstanceId: 'instance-1',
    sourceMachineId: 'source-1',
    sourceFeedIdentity: () => ({ feedId: 'feed-1', feedEpoch: 'epoch-1' }),
    sourceApplicationVersion: 'test',
    sourceSchemaVersion: () => 'schema-1',
    sourceWireSchemaDigest: 'wire-1',
    rpc,
    targetState: () => ({ exists: true, online: true, capable: true }),
    localPromotedTransfer: () => undefined,
    sourceHealthy: vi.fn(),
    checkpoint: vi.fn(),
    fence: vi.fn(),
    releaseFence: vi.fn(),
    demoteSource: vi.fn(),
    snapshotAvailableBytes: () => 2_000_000_000,
    uuid: () => `transfer-${++counter}`,
    ...overrides,
  })
}

const input = {
  targetMachineId: 'target-1',
  publicUrl: 'https://podium.example.com',
  confirmation: SERVER_TRANSFER_CONFIRMATION,
}
const allow = { reauthorize: vi.fn() }

describe('ServerTransferService final-fence flow', () => {
  it('commits final DB and transcript bytes when the writable source changes during initial staging', async () => {
    const fake = fakeRpc({
      onFirstChunk: async () => {
        await writeFile(join(root, 'podium.db'), 'db-v2')
        await writeFile(join(root, 'transcripts', 'session.txt'), 'transcript-v2')
      },
    })
    const order: string[] = []
    const fence = vi.fn(() => order.push('fence'))
    const checkpoint = vi.fn(() =>
      order.push(fence.mock.calls.length === 0 ? 'checkpoint:writable' : 'checkpoint:fenced'),
    )
    const service = makeService(fake.rpc, { fence, checkpoint })

    const result = await service.transfer(input, allow)

    expect(result).toMatchObject({ ok: true, state: 'committed' })
    expect(fence).toHaveBeenCalledOnce()
    expect(order).toEqual(['checkpoint:writable', 'fence', 'checkpoint:fenced'])
    expect(fake.operations.filter((operation) => operation.startsWith('prepare:'))).toHaveLength(2)
    expect(fake.operations.some((operation) => operation.startsWith('abort:'))).toBe(true)

    const finalManifest = fake.manifests.get(result.transferId)
    expect(finalManifest).toBeDefined()
    const finalChunks = fake.chunks.get(result.transferId)
    const dbIndex = finalManifest?.files.findIndex((entry) => entry.path === 'podium.db')
    const transcriptIndex = finalManifest?.files.findIndex(
      (entry) => entry.path === 'transcripts/session.txt',
    )
    expect(finalChunks?.get(dbIndex ?? -1)?.toString()).toBe('db-v2')
    expect(finalChunks?.get(transcriptIndex ?? -1)?.toString()).toBe('transcript-v2')
  })

  it('reauthorizes every apply phase and safely aborts when commit authorization is revoked', async () => {
    const fake = fakeRpc()
    const releaseFence = vi.fn()
    const phases: string[] = []
    const result = await makeService(fake.rpc, { releaseFence }).transfer(input, {
      reauthorize: (phase) => {
        phases.push(phase)
        if (phase === 'commit') throw new Error('grant revoked')
      },
    })

    expect(result).toMatchObject({ ok: false, state: 'aborted' })
    expect(phases).toEqual(['prepare', 'stage', 'validate', 'fence', 'commit'])
    expect(releaseFence).toHaveBeenCalledOnce()
    expect(fake.rpc.serverTransferAbort).toHaveBeenCalledOnce()
    expect(fake.rpc.serverTransferPromote).not.toHaveBeenCalled()
  })

  it('fails preflight before journal, target mutation, or fencing', async () => {
    const fake = fakeRpc()
    const fence = vi.fn()
    const service = makeService(fake.rpc, {
      fence,
      targetState: () => ({ exists: true, online: false, capable: true }),
    })

    await expect(service.transfer(input, allow)).rejects.toMatchObject({ code: 'target-offline' })
    expect(fake.rpc.serverTransferPrepare).not.toHaveBeenCalled()
    expect(fence).not.toHaveBeenCalled()
    await expect(readFile(join(root, '.server-transfer', 'journal.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('is idempotent after commit and does not promote a second time', async () => {
    const fake = fakeRpc()
    const service = makeService(fake.rpc)

    const first = await service.transfer(input, allow)
    const second = await service.transfer(input, allow)

    expect(second).toEqual(first)
    expect(fake.rpc.serverTransferPromote).toHaveBeenCalledOnce()
  })

  it('commits after serving proof when target acknowledgement is cleanup-degraded', async () => {
    const fake = fakeRpc({ acknowledge: 'throw' })
    const demoteSource = vi.fn()
    const service = makeService(fake.rpc, { demoteSource })

    const result = await service.transfer(input, allow)

    expect(result).toMatchObject({
      ok: true,
      state: 'committed',
      cleanup: { result: 'pending', detail: 'acknowledgement reply lost' },
    })
    expect(service.status()).toMatchObject({
      state: 'committed',
      cleanup: { result: 'pending' },
    })
    expect(fake.rpc.serverTransferAcknowledge).toHaveBeenCalledOnce()
    expect(demoteSource).toHaveBeenCalledOnce()
  })

  it('keeps the source fenced and records commit-uncertain after a lost promotion reply', async () => {
    const fake = fakeRpc({ promote: 'throw' })
    const releaseFence = vi.fn()
    const service = makeService(fake.rpc, { releaseFence })

    const result = await service.transfer(input, allow)

    expect(result).toMatchObject({ ok: false, state: 'commit-uncertain' })
    expect(releaseFence).not.toHaveBeenCalled()
    expect(service.status()?.state).toBe('commit-uncertain')
    expect(() => assertWritableServerBoot(root)).toThrow(/refusing writable server boot/)
  })

  it('resolves a lost promotion reply only from a fully bound serving proof', async () => {
    const fake = fakeRpc({ promote: 'throw-once' })
    const demoteSource = vi.fn()
    const afterCommitted = vi.fn()
    const service = makeService(fake.rpc, { demoteSource, afterCommitted })

    const first = await service.transfer(input, allow)
    expect(first.state).toBe('commit-uncertain')
    expect(demoteSource).not.toHaveBeenCalled()

    const second = await service.transfer(input, allow)
    expect(second).toMatchObject({ ok: true, state: 'committed' })
    expect(fake.rpc.serverTransferPromote).toHaveBeenCalledOnce()
    expect(fake.rpc.serverTransferStatus).toHaveBeenCalledOnce()
    expect(demoteSource).toHaveBeenCalledOnce()
    expect(service.status()?.state).toBe('committed')
    expect(afterCommitted).toHaveBeenCalledOnce()
  })

  it('aborts target staging without fencing when candidate validation fails', async () => {
    const fake = fakeRpc({ validateOk: false })
    const fence = vi.fn()
    const result = await makeService(fake.rpc, { fence }).transfer(input, allow)

    expect(result).toMatchObject({
      ok: false,
      state: 'aborted',
      cleanup: { result: 'cleaned' },
    })
    expect(fake.rpc.serverTransferAbort).toHaveBeenCalledOnce()
    expect(fence).not.toHaveBeenCalled()
  })

  it('reports committed on the source without claiming reconnect continuity', async () => {
    const fake = fakeRpc()
    const service = makeService(fake.rpc)

    await service.transfer(input, allow)
    const status = await service.publicStatus([{ id: 'source-1' }, { id: 'target-1' }])

    expect(status.transfer).toMatchObject({
      state: 'committed',
      phase: 'switching',
      targetProof: true,
      sourceConnected: false,
    })
    expect(status.transfer?.bytesCopied).toBe(status.transfer?.totalBytes)
    expect(fake.rpc.serverTransferStatus).not.toHaveBeenCalled()
  })

  it('projects promoted target metadata and observes source reconnect locally', async () => {
    const fake = fakeRpc()
    let sourceOnline = false
    const promoted = {
      transferId: '00000000-0000-4000-8000-000000000001',
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      publicUrl: 'https://podium.example.com',
      manifestDigest: 'digest-1',
      state: 'promoted' as const,
      servingProof: {
        transferId: '00000000-0000-4000-8000-000000000001',
        manifestDigest: 'digest-1',
        targetMachineId: 'target-1',
        feedId: 'feed-1',
        feedEpoch: 'epoch-1',
        schemaVersion: 'schema-1',
        buildVersion: 'test',
        health: 'serving',
        publicUrl: 'https://podium.example.com',
      },
    }
    const stageDir = join(root, '.server-transfer', promoted.transferId)
    await mkdir(stageDir, { recursive: true })
    await writeFile(join(stageDir, 'state.json'), JSON.stringify(promoted))
    const service = makeService(fake.rpc, {
      sourceMachineId: 'target-1',
      localPromotedTransfer: () => readPromotedTargetMetadata(root),
      targetState: (machineId) => ({
        exists: true,
        online: machineId === 'source-1' ? sourceOnline : true,
        capable: true,
      }),
    })

    const before = await service.publicStatus([{ id: 'source-1' }, { id: 'target-1' }])
    expect(before).toMatchObject({
      sourceMachineId: 'source-1',
      transfer: { state: 'committed', phase: 'switching', sourceConnected: false },
    })

    sourceOnline = true
    const after = await service.publicStatus([{ id: 'source-1' }, { id: 'target-1' }])
    expect(after.transfer).toMatchObject({
      state: 'committed',
      phase: 'connected',
      targetProof: true,
      sourceConnected: true,
    })
  })
})
