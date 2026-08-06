import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerTransferRpc } from './service'
import { ServerTransferService } from './service'

let root = ''
let previousStateDir: string | undefined

beforeEach(async () => {
  previousStateDir = process.env.PODIUM_STATE_DIR
  root = await mkdtemp(join(tmpdir(), 'podium-server-transfer-'))
  process.env.PODIUM_STATE_DIR = root
  await writeFile(join(root, 'podium.db'), 'db-v1')
  await writeFile(join(root, 'enrollment.ledger'), 'ledger-v1')
  await mkdir(join(root, 'transcripts'), { recursive: true })
  await writeFile(join(root, 'transcripts', 'session.txt'), 'transcript-v1')
})

afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = previousStateDir
  await rm(root, { recursive: true, force: true })
})

function fakeRpc(
  overrides: Partial<{
    validate: { ok: boolean; state: string; error?: string }
    promote: { ok: boolean; state: string; error?: string }
    abort: { ok: boolean; state: string; error?: string }
  }> = {},
): { rpc: ServerTransferRpc; operations: string[] } {
  const operations: string[] = []
  const rpc: ServerTransferRpc = {
    serverTransferPrepare: vi.fn(async () => {
      operations.push('prepare')
      return { ok: true, state: 'staging' }
    }),
    serverTransferChunk: vi.fn(async (input) => {
      operations.push(`chunk:${input.path}:${input.offset}`)
      return { ok: true, state: 'staging' }
    }),
    serverTransferValidate: vi.fn(async () => {
      operations.push('validate')
      return overrides.validate ?? { ok: true, state: 'validated' }
    }),
    serverTransferPromote: vi.fn(async () => {
      operations.push('promote')
      return overrides.promote ?? { ok: true, state: 'promoted' }
    }),
    serverTransferAbort: vi.fn(async () => {
      operations.push('abort')
      return overrides.abort ?? { ok: true, state: 'aborted' }
    }),
  }
  return { rpc, operations }
}

function service(
  rpc: ServerTransferRpc,
  extra: Partial<ConstructorParameters<typeof ServerTransferService>[0]> = {},
) {
  return new ServerTransferService({
    stateRoot: root,
    rpc,
    online: () => true,
    ...extra,
  })
}

const input = {
  targetMachineId: 'vps-1',
  publicUrl: 'https://podium.example.com',
  confirmation: true as const,
}

describe('ServerTransferService', () => {
  it('refuses the current server machine before any snapshot work', async () => {
    const { rpc } = fakeRpc()
    await expect(service(rpc, { sourceMachineId: 'vps-1' }).transfer(input)).rejects.toThrow(
      /already the server/,
    )
    expect(rpc.serverTransferPrepare).not.toHaveBeenCalled()
  })

  it('commits only after staging, validation, fencing, and promotion', async () => {
    const { rpc, operations } = fakeRpc()
    const result = await service(rpc).transfer(input)

    expect(result).toMatchObject({
      ok: true,
      state: 'committed',
      targetMachineId: 'vps-1',
      publicUrl: 'https://podium.example.com',
    })
    expect(operations[0]).toBe('prepare')
    expect(operations.at(-1)).toBe('promote')
    expect(operations).not.toContain('abort')
    expect(
      JSON.parse(await readFile(join(root, '.server-transfer', 'journal.json'), 'utf8')).state,
    ).toBe('committed')
    expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).mode).toBe('daemon')
  })

  it('aborts the target and leaves source state untouched when validation fails', async () => {
    const { rpc, operations } = fakeRpc({
      validate: { ok: false, state: 'staging', error: 'hash mismatch' },
    })

    await expect(service(rpc).transfer(input)).rejects.toMatchObject({
      name: 'ServerTransferError',
      phase: 'validating',
    })
    expect(operations).toContain('abort')
    expect(await readFile(join(root, 'podium.db'), 'utf8')).toBe('db-v1')
    expect(
      JSON.parse(await readFile(join(root, '.server-transfer', 'journal.json'), 'utf8')).state,
    ).toBe('aborted')
  })

  it('aborts when the source changes at the fence', async () => {
    const { rpc, operations } = fakeRpc()
    const releaseFence = vi.fn()
    const result = service(rpc, {
      fence: async () => {
        await writeFile(join(root, 'podium.db'), 'db-mutated')
      },
      releaseFence,
    })

    await expect(result.transfer(input)).rejects.toMatchObject({ phase: 'fencing' })
    expect(operations).toContain('abort')
    expect(operations).not.toContain('promote')
    expect(releaseFence).toHaveBeenCalledOnce()
  })

  it('records abort uncertainty when the source fence cannot be released', async () => {
    const { rpc, operations } = fakeRpc()
    const releaseFence = vi.fn(async () => {
      throw new Error('release failed')
    })
    const transfer = service(rpc, {
      fence: async () => {
        await writeFile(join(root, 'podium.db'), 'db-mutated')
      },
      releaseFence,
    })

    await expect(transfer.transfer(input)).rejects.toMatchObject({
      name: 'ServerTransferError',
      phase: 'fencing',
    })
    expect(operations).toContain('abort')
    expect(
      JSON.parse(await readFile(join(root, '.server-transfer', 'journal.json'), 'utf8')).state,
    ).toBe('abort-uncertain')
  })

  it('records abort uncertainty instead of claiming cleanup succeeded', async () => {
    const { rpc } = fakeRpc({
      validate: { ok: false, state: 'staging', error: 'validation failed' },
      abort: { ok: false, state: 'staging', error: 'target disappeared' },
    })

    await expect(service(rpc).transfer(input)).rejects.toMatchObject({
      name: 'ServerTransferError',
    })
    expect(
      JSON.parse(await readFile(join(root, '.server-transfer', 'journal.json'), 'utf8')).state,
    ).toBe('abort-uncertain')
  })

  it('returns commit-uncertain and refuses a blind second transfer', async () => {
    const { rpc, operations } = fakeRpc({
      promote: { ok: false, state: 'uncertain', error: 'promotion timeout' },
    })

    const first = await service(rpc).transfer(input)
    expect(first).toMatchObject({ ok: false, state: 'commit-uncertain' })
    await expect(service(rpc).transfer(input)).rejects.toThrow(/previous transfer is uncertain/)
    expect(operations.filter((operation) => operation === 'prepare')).toHaveLength(1)
  })
})
