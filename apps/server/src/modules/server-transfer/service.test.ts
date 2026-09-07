import { asMachineId } from '@podium/model'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertWritableServerBoot } from './journal'
import { ServerTransferService } from './service'
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
  await writeFile(join(root, 'update-signing-key.json'), 'server-key-v1')
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
    promote?: 'ok' | 'throw' | 'throw-once' | 'throw-before-once'
    acknowledge?: 'ok' | 'throw' | 'never'
    onAcknowledge?: () => void | Promise<void>
  } = {},
) {
  const operations: string[] = []
  const manifests = new Map<string, ServerTransferManifest>()
  const chunks = new Map<string, Map<number, Buffer>>()
  let firstChunk = true
  let promotion:
    | {
        transferId: string
        targetMachineId: string
        publicUrl: string
        bindHost: '127.0.0.1' | '0.0.0.0'
        port: number
      }
    | undefined
  let promoteReplyLost = false
  const rpc: ServerTransferRpc = {
    serverTransferPrepare: vi.fn(async (input, targetMachineId) => {
      operations.push(`prepare:${input.transferId}`)
      manifests.set(input.transferId, input.manifest)
      chunks.set(input.transferId, new Map())
      return {
        ok: true as const,
        state: 'prepared' as const,
        manifestDigest: input.manifest.digest,
        targetMachineId,
        targetCapability: 'server-only' as const,
        buildVersion: 'test',
        wireSchemaDigest: 'wire-1',
        receivedBytes: 0,
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
        ok: true as const,
        state: 'staging' as const,
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
          ok: false as const,
          state: 'staging' as const,
          error: { code: 'digest-mismatch', detail: 'candidate validation failed' },
        }
      }
      return {
        ok: true as const,
        state: 'validated' as const,
        proof: {
          operationId: manifest.operationId,
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
      if (options.promote === 'throw-before-once' && !promoteReplyLost) {
        promoteReplyLost = true
        throw new Error('promotion request dropped')
      }
      const manifest = manifests.get(input.transferId)
      if (!manifest) throw new Error('promotion before prepare')
      promotion = {
        transferId: input.transferId,
        targetMachineId,
        publicUrl: input.publicUrl,
        bindHost: input.bindHost,
        port: input.port,
      }
      if (options.promote === 'throw-once' && !promoteReplyLost) {
        promoteReplyLost = true
        throw new Error('promotion reply lost')
      }
      return {
        ok: true as const,
        state: 'promoted' as const,
        proof: {
          operationId: manifest.operationId,
          transferId: input.transferId,
          manifestDigest: input.manifestDigest,
          targetMachineId,
          feedId: manifest.sourceFeedId,
          feedEpoch: manifest.sourceFeedEpoch,
          schemaVersion: manifest.schemaVersion,
          buildVersion: 'test',
          health: 'serving' as const,
          publicUrl: input.publicUrl,
          bindHost: input.bindHost,
          port: input.port,
        },
      }
    }),
    serverTransferAcknowledge: vi.fn(async (input) => {
      operations.push(`acknowledge:${input.transferId}`)
      await options.onAcknowledge?.()
      if (options.acknowledge === 'never') await new Promise<never>(() => {})
      if (options.acknowledge === 'throw') throw new Error('acknowledgement reply lost')
      return {
        ok: true as const,
        state: 'promoted' as const,
        transferId: input.transferId,
        manifestDigest: input.manifestDigest,
        acknowledged: true as const,
      }
    }),
    serverTransferAbort: vi.fn(async (input) => {
      operations.push(`abort:${input.transferId}`)
      return {
        ok: true as const,
        state: 'aborted' as const,
        transferId: input.transferId,
        manifestDigest: input.manifestDigest,
        cleanup: 'cleaned' as const,
      }
    }),
    inspectServerTransfer: vi.fn(async (statusInput) => {
      const manifest = statusInput.transferId ? manifests.get(statusInput.transferId) : undefined
      if (!manifest) {
        return {
          ok: false as const,
          state: 'uncertain' as const,
          error: { code: 'unknown', detail: 'no proof' },
        }
      }
      if (!promotion || promotion.transferId !== statusInput.transferId) {
        return {
          ok: true as const,
          state: 'validated' as const,
          transferId: statusInput.transferId,
          manifestDigest: manifest.digest,
          publicUrl: 'https://target.example.test',
          port: 443,
          sourceConnected: true,
        }
      }
      return {
        ok: true as const,
        state: 'promoted' as const,
        transferId: promotion.transferId,
        manifestDigest: manifest.digest,
        proof: {
          operationId: manifest.operationId,
          transferId: promotion.transferId,
          manifestDigest: manifest.digest,
          targetMachineId: promotion.targetMachineId,
          feedId: manifest.sourceFeedId,
          feedEpoch: manifest.sourceFeedEpoch,
          schemaVersion: manifest.schemaVersion,
          buildVersion: 'test',
          health: 'serving' as const,
          publicUrl: promotion.publicUrl,
          bindHost: promotion.bindHost,
          port: promotion.port,
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
  const deps = {
    stateRoot: root,
    sourceInstanceId: 'instance-1',
    sourceMachineId: asMachineId('source-1'),
    sourceFeedIdentity: () => ({ feedId: 'feed-1', feedEpoch: 'epoch-1' }),
    sourceApplicationVersion: 'test',
    sourceSchemaVersion: async () => 'schema-1',
    sourceWireSchemaDigest: 'wire-1',
    rpc,
    targetState: () => ({ exists: true, online: true, capable: true, hasDaemon: true }),
    localPromotedTransfer: () => undefined,
    sourceHealthy: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => undefined),
    fence: vi.fn(),
    releaseFence: vi.fn(),
    demoteSource: vi.fn(),
    snapshotAvailableBytes: () => 2_000_000_000,
    uuid: () => `transfer-${++counter}`,
    ...overrides,
  }
  return new ServerTransferService({
    // SETUP ONLY (POD-3257): the batched resolver defaults to whichever
    // single-machine stub is in effect, so a test that overrides `targetState`
    // still controls both paths and no case had to be respelled.
    targetStateResolver: () => deps.targetState,
    ...deps,
  })
}

const input = {
  targetMachineId: asMachineId('target-1'),
  publicUrl: 'https://podium.example.com',
  bindHost: '0.0.0.0' as const,
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
    const fence = vi.fn(() => {
      order.push('fence')
    })
    const checkpoint = vi.fn(async () => {
      order.push(fence.mock.calls.length === 0 ? 'checkpoint:writable' : 'checkpoint:fenced')
    })
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
      targetState: () => ({ exists: true, online: false, capable: true, hasDaemon: true }),
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

  it('commits durably before acknowledging target retirement', async () => {
    let service!: ServerTransferService
    const demoteSource = vi.fn()
    const fake = fakeRpc({
      onAcknowledge: () => {
        expect(demoteSource).toHaveBeenCalledOnce()
        expect(service.status()?.state).toBe('committed')
      },
    })
    service = makeService(fake.rpc, { demoteSource })

    await expect(service.transfer(input, allow)).resolves.toMatchObject({
      ok: true,
      state: 'committed',
    })
    expect(fake.rpc.serverTransferAcknowledge).toHaveBeenCalledOnce()
  })

  it('retires a committed source when target acknowledgement never settles', async () => {
    let service!: ServerTransferService
    const afterCommitted = vi.fn()
    const fake = fakeRpc({
      acknowledge: 'never',
      onAcknowledge: () => {
        expect(service.status()?.state).toBe('committed')
        expect(afterCommitted).not.toHaveBeenCalled()
      },
    })
    service = makeService(fake.rpc, { afterCommitted, acknowledgementTimeoutMs: 0 })

    await expect(service.transfer(input, allow)).resolves.toMatchObject({
      ok: true,
      state: 'committed',
      cleanup: {
        result: 'pending',
        detail: 'target acknowledgement did not settle within 0ms',
      },
    })
    expect(afterCommitted).toHaveBeenCalledOnce()
    expect(service.status()).toMatchObject({
      state: 'committed',
      cleanup: {
        result: 'pending',
        detail: 'target acknowledgement did not settle within 0ms',
      },
    })
    expect(makeService(fake.rpc).status()).toMatchObject({
      state: 'committed',
      cleanup: { result: 'pending' },
    })
  })

  it('retains the target recovery channel when source demotion is not durable', async () => {
    const fake = fakeRpc()
    const service = makeService(fake.rpc, {
      demoteSource: vi.fn(() => {
        throw new Error('source config fsync failed')
      }),
    })

    await expect(service.transfer(input, allow)).resolves.toMatchObject({
      ok: false,
      state: 'commit-uncertain',
    })
    expect(fake.rpc.serverTransferAcknowledge).not.toHaveBeenCalled()
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
    expect(fake.rpc.inspectServerTransfer).toHaveBeenCalledOnce()
    expect(demoteSource).toHaveBeenCalledOnce()
    expect(service.status()?.state).toBe('committed')
    expect(afterCommitted).toHaveBeenCalledOnce()
  })

  it('replays the same idempotent promotion after a dropped request', async () => {
    const fake = fakeRpc({ promote: 'throw-before-once' })
    const demoteSource = vi.fn()
    const service = makeService(fake.rpc, { demoteSource })

    const first = await service.transfer(input, allow)
    expect(first.state).toBe('commit-uncertain')
    expect(demoteSource).not.toHaveBeenCalled()

    const second = await service.transfer(input, allow)
    expect(second).toMatchObject({ ok: true, state: 'committed' })
    expect(fake.rpc.serverTransferPromote).toHaveBeenCalledTimes(2)
    const promoteCalls = vi.mocked(fake.rpc.serverTransferPromote).mock.calls
    expect(promoteCalls[1]?.[0]).toEqual(promoteCalls[0]?.[0])
    expect(demoteSource).toHaveBeenCalledOnce()
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

})
