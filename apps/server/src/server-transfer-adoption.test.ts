import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from './migrations'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'
import { OperationStore } from './modules/operations/store'
import { startServer, type ServerHandle } from './server'

const priorStateDir = process.env.PODIUM_STATE_DIR!
const finalTransferId = '00000000-0000-4000-8000-000000000002'
const finalDigest = 'b'.repeat(64)

const operation = {
  id: 'operation-1',
  kind: 'server-move',
  exclusionGroup: 'lifecycle',
  state: 'running' as const,
  createdAt: 1,
  startedAt: 1,
  updatedAt: 10,
  steps: [
    { id: 'preflight', title: 'Checking the move', state: 'done' as const },
    { id: 'stage', title: 'Copying server state', state: 'done' as const },
    { id: 'validate', title: 'Verifying the copy', state: 'done' as const },
    { id: 'fence', title: 'Pausing this server', state: 'running' as const },
    { id: 'cutover', title: 'Switching servers', state: 'pending' as const },
  ],
  details: {
    transferId: '00000000-0000-4000-8000-000000000001',
    sourceMachineId: 'source-1',
    targetMachineId: 'target-1',
    publicUrl: 'https://podium.example.com',
    port: 443,
    manifestDigest: 'a'.repeat(64),
    authorizedBy: 'user:sole',
    intent: {
      targetMachineId: 'target-1',
      publicUrl: 'https://podium.example.com',
      port: 443,
      confirmation: 'satisfied' as const,
    },
    _handoff: { stepId: 'fence', sealedAt: 9 },
  },
  awaiting: [],
  deferred: [],
  error: null,
}

const candidateProof = {
  operationId: operation.id,
  transferId: finalTransferId,
  manifestDigest: finalDigest,
  targetMachineId: 'target-1',
  feedId: 'feed-1',
  feedEpoch: 'epoch-1',
  schemaVersion: 'schema-1',
  buildVersion: 'test',
}

function promotingMetadata() {
  return {
    version: 1,
    operationId: operation.id,
    transferId: finalTransferId,
    manifestDigest: finalDigest,
    sourceMachineId: 'source-1',
    targetMachineId: 'target-1',
    publicUrl: 'https://podium.example.com',
    port: 443,
    state: 'promoting',
    promotion: {
      idempotencyKey: finalTransferId,
      publicUrl: 'https://podium.example.com',
      port: 443,
      targetMode: 'server',
    },
    proof: candidateProof,
  }
}

function promotedMetadata() {
  return {
    ...promotingMetadata(),
    state: 'promoted',
    servingProof: {
      ...candidateProof,
      publicUrl: 'https://podium.example.com',
      port: 443,
      health: 'serving',
    },
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error('deferred server move did not settle')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('target server deferred move adoption', () => {
  let root: string
  let metadataPath: string
  let handle: ServerHandle

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'podium-server-move-adoption-'))
    process.env.PODIUM_STATE_DIR = root
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        configVersion: 2,
        mode: 'server',
        persistence: 'detached',
        publicUrl: 'https://podium.example.com',
      }),
    )
    writeFileSync(join(root, 'machine.id'), 'target-1')

    const db = openDatabase(join(root, 'podium.db'))
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
    new OperationStore(db).insert(operation)
    db.close()

    const stage = join(root, '.server-transfer', finalTransferId)
    mkdirSync(stage, { recursive: true })
    metadataPath = join(stage, 'state.json')
    writeFileSync(metadataPath, JSON.stringify(promotingMetadata()))
    handle = await startServer({ port: 0 })
  })

  afterAll(async () => {
    await handle?.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(root, { recursive: true, force: true })
  })

  it('serves health while preserving the row and refusing all data until exact proof settles', async () => {
    const origin = `http://127.0.0.1:${handle.port}`
    expect(await (await fetch(`${origin}/health`)).text()).toBe('ok')
    expect((await fetch(`${origin}/readiness`)).status).toBe(503)
    expect(handle.registry.modules.operations.engine.get(operation.id)?.operation?.updatedAt).toBe(
      10,
    )

    const engine = handle.registry.modules.operations.engine
    const resume = engine.resumeDeferredAdoption.bind(engine)
    let attempts = 0
    engine.resumeDeferredAdoption = async (...args: Parameters<typeof resume>) => {
      attempts += 1
      if (attempts === 1) throw new Error('transient store failure')
      return resume(...args)
    }

    writeFileSync(metadataPath, JSON.stringify(promotedMetadata()))
    const readiness = await eventually(
      () => fetch(`${origin}/readiness`),
      (response) => response.status === 200,
    )
    expect(await readiness.json()).toMatchObject({ dataPlane: 'available' })
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(handle.registry.modules.operations.engine.get(operation.id)?.operation).toMatchObject({
      state: 'done',
      details: { handoff: { role: 'completed-on-target' } },
    })
  })

  it('reboots with durable promoted proof and opens the data plane before binding', async () => {
    await handle.close()
    handle = await startServer({ port: 0 })

    const response = await fetch(`http://127.0.0.1:${handle.port}/readiness`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ dataPlane: 'available' })
    expect(handle.registry.modules.operations.engine.get(operation.id)?.state).toBe('done')
  })
})
