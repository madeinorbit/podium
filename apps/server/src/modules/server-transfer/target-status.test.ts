import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPromotedTargetMetadata } from './target-status'

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
    port: 443,
    health: 'serving',
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
  ] as const)('rejects serving proof whose %s differs from promotion metadata', async (field, value) => {
    const valueWithMismatch = promoted()
    valueWithMismatch.servingProof = { ...valueWithMismatch.servingProof, [field]: value }
    const root = await writeMetadata(valueWithMismatch)

    expect(readPromotedTargetMetadata(root)).toBeUndefined()
  })
})
