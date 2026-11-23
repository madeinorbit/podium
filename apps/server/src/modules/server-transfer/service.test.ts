import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asMachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { vaultCheckValue } from '@podium/runtime/vault-key'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { DaemonRpcService } from '../machines/rpc'
import { type MachinesDeps, MachinesService } from '../machines/service'
import { assertWritableServerBoot } from './journal'
import { serverTransferRpcAdapter } from './rpc-adapter'
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
  const endpoints = new Map<string, { publicUrl: string; port: number }>()
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
      endpoints.set(input.transferId, { publicUrl: input.publicUrl, port: input.port })
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
          publicUrl: endpoints.get(manifest.transferId)!.publicUrl,
          port: endpoints.get(manifest.transferId)!.port,
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
    hostMachine: { id: asMachineId('source-1') },
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
    const afterJournalCommitted = vi.fn(() => {
      expect(service.status()?.state).toBe('committed')
    })
    const fake = fakeRpc({
      onAcknowledge: () => {
        expect(demoteSource).toHaveBeenCalledOnce()
        expect(afterJournalCommitted).toHaveBeenCalledOnce()
        expect(service.status()?.state).toBe('committed')
      },
    })
    service = makeService(fake.rpc, { demoteSource, afterJournalCommitted })

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

  it.each([
    { publicUrl: 'https://podium.example.com', port: 443 },
    { publicUrl: 'https://other.example.test:8443', port: 8443 },
  ])('replays the same idempotent promotion after a dropped request ($publicUrl)', async (endpoint) => {
    const fake = fakeRpc({ promote: 'throw-before-once' })
    const demoteSource = vi.fn()
    const service = makeService(fake.rpc, { demoteSource })

    const replayInput = { ...input, ...endpoint }
    const first = await service.transfer(replayInput, allow)
    expect(first.state).toBe('commit-uncertain')
    expect(demoteSource).not.toHaveBeenCalled()

    const second = await service.transfer(replayInput, allow)
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

/**
 * `onRecord` USED TO BE TYPED `=> void` (POD-3820).
 *
 * The operation wiring behind it persists the journal record and reports
 * progress through the operations engine — two store writes, both fired with a
 * bare `void` because the hook's return type said there was nothing to wait
 * for. Under the async store executor an unawaited nested transaction JOINS
 * whatever span the transfer is running inside, as a savepoint: the span's next
 * statement addresses a frame with an open child and is refused, and the
 * savepoint dies when the span closes. That is the lock bug (POD-3802).
 *
 * The hook now returns `Promise<void>` and the service hands it to
 * `afterCommit`, which is the honest middle for a PER-CHUNK tick: deferred past
 * the commit and run at the root, so it neither blocks the copy loop nor joins
 * the caller's span. The hook below is production-shaped — it opens a REAL
 * store transaction — which is what a `vi.fn()` stub cannot show.
 */
describe('ServerTransferService under the async store (POD-3820)', () => {
  it('a record hook that opens its own transaction leaves the span it was called in usable', async () => {
    const store = await openTestStore(':memory:')
    try {
      const ticks: number[] = []
      const fake = fakeRpc()
      const service = makeService(fake.rpc)

      let ticksInsideTheSpan = -1

      await store.transact(async () => {
        const result = await service.transfer(input, allow, {
          operationId: 'op-async-store',
          onRecord: async (record) => {
            ticks.push(record.bytesCopied)
            await store.transact(async () => {
              await store.issues.getIssue(asIssueId('iss_transfer'))
            })
          },
        })
        expect(result).toMatchObject({ ok: true, state: 'committed' })
        ticksInsideTheSpan = ticks.length
        // The statement the lock bug died on: the same span, after the progress
        // ticks were registered.
        await store.issues.getIssue(asIssueId('iss_after'))
      })

      // NOT ONE tick ran inside the span. This is the assertion that fails if
      // the hand-off goes back to firing the hook where it stands: a store
      // write that runs there is a savepoint on the caller's frame, and whether
      // it is REFUSED depends on how soon the caller's next statement lands —
      // which is why the production symptom was intermittent and why an
      // end-state assertion alone cannot see this.
      expect(ticksInsideTheSpan).toBe(0)
      // Deferred, not discarded: the ticks ran on the far side of the commit.
      expect(ticks.length).toBeGreaterThan(0)
    } finally {
      await store.close()
    }
  })
})

describe('ServerTransferService vault key hand-over', () => {
  // Obviously fake: a fixed pattern, never a real key.
  const dataKey = Buffer.alloc(32, 0x5a)
  let keyDir: string
  let keyPath: string

  beforeEach(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'podium-source-vault-key-'))
    keyPath = join(keyDir, 'vault-source.key')
    await writeFile(keyPath, `${Buffer.alloc(32, 0x11).toString('base64')}\n`, { mode: 0o600 })
  })

  afterEach(async () => {
    await rm(keyDir, { recursive: true, force: true })
  })

  const vault = (state: 'ready' | 'empty' | 'locked' = 'ready') => ({
    state: () => state,
    status: () => ({ keyPath }),
    exportDataKey: () => (state === 'ready' ? Buffer.from(dataKey) : null),
  })
  const capableTarget = () => ({
    exists: true,
    online: true,
    capable: true,
    hasDaemon: true,
    vaultKeyHandover: true,
  })

  /** The target opens what it was given and answers with that key's check value. */
  function handingOver(fake: ReturnType<typeof fakeRpc>, given?: (key: Buffer) => Buffer) {
    const promote = fake.rpc.serverTransferPromote
    const inputs: Parameters<ServerTransferRpc['serverTransferPromote']>[0][] = []
    fake.rpc.serverTransferPromote = vi.fn(async (request, target) => {
      inputs.push(request)
      const reply = await promote(request, target)
      if (!reply.ok || typeof request.vaultDataKey !== 'string') return reply
      const received = Buffer.from(request.vaultDataKey, 'base64')
      return {
        ...reply,
        vaultCheck: vaultCheckValue(given ? given(received) : received, request.transferId),
      }
    })
    return inputs
  }

  /** Files under `dir` holding `key` raw, in hex or in base64. */
  async function filesHolding(dir: string, key: Buffer): Promise<string[]> {
    const needles = [
      key,
      Buffer.from(key.toString('hex')),
      Buffer.from(key.toString('base64')),
      Buffer.from(key.toString('base64url')),
    ]
    const found: string[] = []
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      if (needles.some((needle) => readFileSync(path).includes(needle))) found.push(path)
    }
    return found
  }

  it('hands the data key over in promotion and deletes its own key file at finalize', async () => {
    const fake = fakeRpc()
    const inputs = handingOver(fake)
    const result = await makeService(fake.rpc, {
      vault: vault(),
      targetState: capableTarget,
      targetLinkKind: () => 'encrypted',
    }).transfer(input, allow)

    expect(result).toMatchObject({ ok: true, state: 'committed' })
    expect(inputs.at(-1)).toMatchObject({
      vaultDataKey: dataKey.toString('base64'),
      vaultCheck: vaultCheckValue(dataKey, result.transferId),
    })
    expect(existsSync(keyPath)).toBe(false)

    // The journal and the snapshots never held the key; the search does find a canary.
    const canary = Buffer.alloc(32, 0x3c)
    await writeFile(join(root, '.server-transfer', 'canary.txt'), canary.toString('base64'))
    expect(await filesHolding(join(root, '.server-transfer'), canary)).toHaveLength(1)
    expect(await filesHolding(join(root, '.server-transfer'), dataKey)).toEqual([])
  })

  it('refuses a target on a plain connection before anything is copied or staged', async () => {
    const fake = fakeRpc()
    const fence = vi.fn()
    const service = makeService(fake.rpc, {
      fence,
      vault: vault(),
      targetState: capableTarget,
      targetLinkKind: () => 'plain',
    })

    await expect(service.transfer(input, allow)).rejects.toMatchObject({
      code: 'target-link-not-encrypted',
    })
    expect(fake.rpc.serverTransferPrepare).not.toHaveBeenCalled()
    expect(fake.rpc.serverTransferChunk).not.toHaveBeenCalled()
    expect(fence).not.toHaveBeenCalled()
    expect(service.status()).toBeUndefined()
    expect(existsSync(join(root, '.server-transfer', 'snapshots'))).toBe(false)
    expect(existsSync(keyPath)).toBe(true)
  })

  it('refuses a target that cannot take the key before the snapshot, when the vault holds one', async () => {
    const fake = fakeRpc()
    const service = makeService(fake.rpc, {
      vault: vault('ready'),
      targetState: () => ({ ...capableTarget(), vaultKeyHandover: false }),
      targetLinkKind: () => 'encrypted',
    })

    await expect(service.transfer(input, allow)).rejects.toMatchObject({
      code: 'target-unsupported',
    })
    expect(fake.rpc.serverTransferPrepare).not.toHaveBeenCalled()
    expect(service.status()).toBeUndefined()
    expect(existsSync(join(root, '.server-transfer', 'snapshots'))).toBe(false)
  })

  it('moves an empty vault to a target without the capability, sending no key', async () => {
    const fake = fakeRpc()
    const inputs = handingOver(fake)
    const result = await makeService(fake.rpc, {
      vault: vault('empty'),
      targetState: () => ({ ...capableTarget(), vaultKeyHandover: false }),
      targetLinkKind: () => 'local',
    }).transfer(input, allow)

    expect(result).toMatchObject({ ok: true, state: 'committed' })
    expect(inputs.at(-1)?.vaultDataKey).toBeNull()
    expect(inputs.at(-1)).not.toHaveProperty('vaultCheck')
  })

  it('aborts on a wrong check value from a target that refused: source writable with its key, target cleaned', async () => {
    const fake = fakeRpc()
    const wrong = vaultCheckValue(Buffer.alloc(32, 0x01), 'transfer-x')
    fake.rpc.serverTransferPromote = vi.fn(async () => ({
      ok: false as const,
      state: 'validated',
      error: { code: 'refused', detail: 'the vault data key does not open to the check value' },
      vaultCheck: wrong,
    }))
    const releaseFence = vi.fn()
    const demoteSource = vi.fn()
    const service = makeService(fake.rpc, {
      releaseFence,
      demoteSource,
      vault: vault(),
      targetState: capableTarget,
      targetLinkKind: () => 'trusted',
    })

    const result = await service.transfer(input, allow)

    expect(result).toMatchObject({
      ok: false,
      state: 'aborted',
      error: { code: 'vault-check-failed' },
      cleanup: { result: 'cleaned' },
    })
    expect(releaseFence).toHaveBeenCalledOnce()
    expect(demoteSource).not.toHaveBeenCalled()
    expect(fake.rpc.serverTransferAbort).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: result.transferId }),
      input.targetMachineId,
    )
    expect(service.status()?.state).toBe('aborted')
    expect(() => assertWritableServerBoot(root)).not.toThrow()
    expect(existsSync(keyPath)).toBe(true)
  })

  it('aborts when the promote holding the key is refused at the send; a later attach gets no key', async () => {
    // The real chain from the adapter down: DaemonRpcService, its broker, and
    // MachinesService.toMachine, with the target's daemon gone since the preflight.
    const machines = new MachinesService({
      instanceId: 'default',
      daemonLinkKind: () => 'encrypted',
      store: {
        machines: {
          getMachine: async () => ({ revokedAt: null }),
          addMachineComponent: () => false,
          setAvailability: async () => {},
          setPresenceSource: () => {},
          committed: { subscribe: () => () => {} },
        },
      } as unknown as MachinesDeps['store'],
      hostMachine: { id: asMachineId('source-1') },
    } satisfies MachinesDeps)
    const wire = new DaemonRpcService({
      toMachine: machines.toMachine,
      defaultMachine: () => input.targetMachineId,
    } as never)
    const fake = fakeRpc()
    fake.rpc.serverTransferPromote = vi.fn(serverTransferRpcAdapter(wire).serverTransferPromote)
    const releaseFence = vi.fn()
    const demoteSource = vi.fn()
    const service = makeService(fake.rpc, {
      releaseFence,
      demoteSource,
      vault: vault(),
      targetState: capableTarget,
      targetLinkKind: () => 'encrypted',
    })

    const result = await service.transfer(input, allow)

    // The key was really in the request: the refusal, not an empty vault, kept it home.
    expect(fake.rpc.serverTransferPromote).toHaveBeenCalledWith(
      expect.objectContaining({ vaultDataKey: dataKey.toString('base64') }),
      input.targetMachineId,
    )
    expect(result).toMatchObject({
      ok: false,
      state: 'aborted',
      error: { code: 'target-unreachable' },
    })
    expect(JSON.stringify(result)).not.toContain(dataKey.toString('base64'))
    expect(releaseFence).toHaveBeenCalledOnce()
    expect(demoteSource).not.toHaveBeenCalled()
    expect(fake.rpc.serverTransferAbort).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: result.transferId }),
      input.targetMachineId,
    )
    expect(service.status()?.state).toBe('aborted')
    expect(() => assertWritableServerBoot(root)).not.toThrow()
    expect(existsSync(keyPath)).toBe(true)

    // The target's daemon comes back: nothing was parked for it.
    const got: ControlMessage[] = []
    await machines.attach(input.targetMachineId, (m) => got.push(m), [])
    await machines.flushQueued(input.targetMachineId)
    expect(got.map((m) => m.type)).not.toContain('serverTransferPromoteRequest')
    expect(JSON.stringify(got)).not.toContain(dataKey.toString('base64'))
  })

  it('treats a promoted target with a wrong check value as uncertain and keeps the key file', async () => {
    const fake = fakeRpc()
    handingOver(fake, (key) => Buffer.alloc(key.length, 0x02))
    const demoteSource = vi.fn()
    const service = makeService(fake.rpc, {
      demoteSource,
      vault: vault(),
      targetState: capableTarget,
      targetLinkKind: () => 'encrypted',
    })

    const result = await service.transfer(input, allow)

    expect(result).toMatchObject({ ok: false, state: 'commit-uncertain' })
    expect(demoteSource).not.toHaveBeenCalled()
    expect(existsSync(keyPath)).toBe(true)
  })

  it('reports a key file it cannot delete and still commits', async () => {
    const fake = fakeRpc()
    handingOver(fake)
    const result = await makeService(fake.rpc, {
      vault: vault(),
      targetState: capableTarget,
      targetLinkKind: () => 'encrypted',
      removeVaultKeyFile: async () => {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
      },
    }).transfer(input, allow)

    expect(result).toMatchObject({
      ok: true,
      state: 'committed',
      cleanup: { result: 'pending', detail: expect.stringContaining(keyPath) },
    })
    expect(existsSync(keyPath)).toBe(true)
  })

  it('keeps the key file of a locked vault and sends no key', async () => {
    const fake = fakeRpc()
    const inputs = handingOver(fake)
    const result = await makeService(fake.rpc, {
      vault: vault('locked'),
      targetState: capableTarget,
      targetLinkKind: () => 'encrypted',
    }).transfer(input, allow)

    expect(result).toMatchObject({ ok: true, state: 'committed' })
    expect(inputs.at(-1)?.vaultDataKey).toBeNull()
    expect(existsSync(keyPath)).toBe(true)
  })
})
