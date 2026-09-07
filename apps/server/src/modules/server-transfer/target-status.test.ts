import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readNewestTargetPromotionMetadata,
  readPromotedTargetMetadata,
  readPromotingTargetMetadata,
} from './target-status'

const roots: string[] = []
const transferId = '00000000-0000-4000-8000-000000000001'
const manifestDigest = 'a'.repeat(64)

const promoted = () => ({
  version: 1,
  operationId: 'operation-1',
  transferId,
  manifestDigest,
  sourceMachineId: 'source-1',
  targetMachineId: 'target-1',
  publicUrl: 'https://podium.example.com',
  port: 443,
  state: 'promoted',
  promotion: {
    idempotencyKey: transferId,
    publicUrl: 'https://podium.example.com',
    bindHost: '0.0.0.0',
    port: 443,
    targetMode: 'server',
  },
  servingProof: {
    operationId: 'operation-1',
    transferId,
    manifestDigest,
    targetMachineId: 'target-1',
    feedId: 'feed-1',
    feedEpoch: 'epoch-1',
    schemaVersion: 'schema-1',
    buildVersion: 'test',
    publicUrl: 'https://podium.example.com',
    bindHost: '0.0.0.0',
    port: 443,
    health: 'serving',
  },
})

const promoting = () => ({
  version: 1,
  operationId: 'operation-1',
  transferId,
  manifestDigest,
  sourceMachineId: 'source-1',
  targetMachineId: 'target-1',
  publicUrl: 'https://podium.example.com',
  port: 443,
  state: 'promoting',
  promotion: {
    idempotencyKey: transferId,
    publicUrl: 'https://podium.example.com',
    bindHost: '0.0.0.0',
    port: 443,
    targetMode: 'server',
  },
  proof: {
    operationId: 'operation-1',
    transferId,
    manifestDigest,
    targetMachineId: 'target-1',
    feedId: 'feed-1',
    feedEpoch: 'epoch-1',
    schemaVersion: 'schema-1',
    buildVersion: 'test',
  },
})

async function writeMetadata(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'podium-target-status-'))
  roots.push(root)
  const stage = join(root, '.server-transfer', transferId)
  await mkdir(stage, { recursive: true })
  await writeFile(join(stage, 'state.json'), JSON.stringify(value))
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('promoted target metadata', () => {
  it('returns stable operation identity with the exact final serving proof', async () => {
    const root = await writeMetadata(promoted())

    expect(readPromotedTargetMetadata(root)).toMatchObject({
      operationId: 'operation-1',
      transferId,
      manifestDigest,
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      publicUrl: 'https://podium.example.com',
      bindHost: '0.0.0.0',
      port: 443,
      proof: {
        operationId: 'operation-1',
        transferId,
        manifestDigest,
        health: 'serving',
      },
    })
  })

  it.each([
    ['operationId', 'operation-other'],
    ['transferId', '00000000-0000-4000-8000-000000000002'],
    ['manifestDigest', 'b'.repeat(64)],
    ['bindHost', '127.0.0.1'],
  ] as const)('rejects serving proof whose %s differs from promotion metadata', async (field, value) => {
    const valueWithMismatch = promoted()
    valueWithMismatch.servingProof = { ...valueWithMismatch.servingProof, [field]: value }
    const root = await writeMetadata(valueWithMismatch)

    expect(readPromotedTargetMetadata(root)).toBeUndefined()
  })
})

describe('newest target promotion metadata', () => {
  it('lets a newer exact promoted stage win over an older promoting stage', async () => {
    const root = await writeMetadata(promoting())
    const newerTransferId = '00000000-0000-4000-8000-000000000002'
    const newerDigest = 'c'.repeat(64)
    const newer = promoted()
    newer.transferId = newerTransferId
    newer.manifestDigest = newerDigest
    newer.promotion = { ...newer.promotion, idempotencyKey: newerTransferId }
    newer.servingProof = {
      ...newer.servingProof,
      transferId: newerTransferId,
      manifestDigest: newerDigest,
    }
    const newerStage = join(root, '.server-transfer', newerTransferId)
    await mkdir(newerStage, { recursive: true })
    const newerPath = join(newerStage, 'state.json')
    await writeFile(newerPath, JSON.stringify(newer))
    const future = new Date(Date.now() + 1_000)
    await utimes(newerPath, future, future)

    expect(readNewestTargetPromotionMetadata(root)).toMatchObject({
      state: 'promoted',
      transferId: newerTransferId,
      manifestDigest: newerDigest,
    })
  })
})

describe('promoting target metadata', () => {
  it('accepts only an internally bound final candidate marker', async () => {
    const root = await writeMetadata(promoting())

    expect(readPromotingTargetMetadata(root, transferId)).toMatchObject({
      state: 'promoting',
      operationId: 'operation-1',
      transferId,
      manifestDigest,
      sourceMachineId: 'source-1',
      targetMachineId: 'target-1',
      publicUrl: 'https://podium.example.com',
      bindHost: '0.0.0.0',
      port: 443,
      proof: { operationId: 'operation-1', transferId, manifestDigest },
    })
    expect(readPromotedTargetMetadata(root, transferId)).toBeUndefined()
  })

  it.each([
    ['operationId', 'operation-other'],
    ['transferId', '00000000-0000-4000-8000-000000000002'],
    ['manifestDigest', 'b'.repeat(64)],
  ] as const)('rejects a candidate proof whose %s differs from its stage', async (field, value) => {
    const marker = promoting()
    marker.proof = { ...marker.proof, [field]: value }
    const root = await writeMetadata(marker)

    expect(readPromotingTargetMetadata(root, transferId)).toBeUndefined()
  })
})
