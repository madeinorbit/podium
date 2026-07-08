import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveServerRole } from './roles'
import type { AppRouter } from './router'
import { startServer } from './server'

// Role composition (docs/offline-sync-architecture.md §4, issue #157): one
// server binary, hub surfaces activated by role. These tests boot a REAL
// server with the hub role OFF and prove the hub surfaces are absent (404 /
// pair refused) while every core surface keeps working — then check the
// role-resolution defaults that keep existing deployments unchanged.
describe('resolveServerRole', () => {
  it('no upstream configured → core + hub (the historical all-in-one shape)', () => {
    expect(resolveServerRole(undefined, {})).toEqual({ hub: true })
  })

  it('upstream configured → node: hub surfaces off', () => {
    expect(resolveServerRole(undefined, { upstream: { url: 'x', token: 't' } })).toEqual({
      hub: false,
    })
  })

  it('an explicit role config wins over the upstream heuristic, both ways', () => {
    expect(resolveServerRole({ hub: true }, { upstream: { url: 'x', token: 't' } })).toEqual({
      hub: true,
    })
    expect(resolveServerRole({ hub: false }, {})).toEqual({ hub: false })
  })
})

describe('startServer with the hub role disabled (node shape)', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-role-node-'))
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ port: 0, role: { hub: false } })
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${handle.port}/trpc` })],
    })
  })

  afterAll(async () => {
    await handle.close()
    delete process.env.PODIUM_STATE_DIR
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('core routes keep working: /health, sessions.list, machines.list', async () => {
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(await health.text()).toBe('ok')
    expect(await trpc.sessions.list.query()).toEqual([])
    // Reading the fleet is core (a node lists its own local machine)…
    const machines = await trpc.machines.list.query()
    expect(machines.some((m) => m.id === 'local')).toBe(true)
  })

  it('pairing/fleet procs are ABSENT: 404 NOT_FOUND, not permission-denied', async () => {
    for (const call of [
      () => trpc.machines.pairingCode.mutate(),
      () => trpc.machines.rename.mutate({ id: 'local', name: 'nope' }),
      () => trpc.machines.revoke.mutate({ id: 'local' }),
    ]) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(TRPCClientError)
      expect((err as TRPCClientError<AppRouter>).data?.httpStatus).toBe(404)
    }
  })

  it('a daemon `pair` handshake is refused (no pairing manager injected)', () => {
    const auth = handle.registry.modules.machines.authenticateDaemon({
      type: 'pair',
      code: 'ABCD-EFGH',
      machineId: 'joiner',
      hostname: 'joiner-host',
    })
    expect(auth).toEqual({ ok: false, reason: 'pairing is disabled on this server' })
  })

  it('the local daemon `hello` path is unaffected by the node role', () => {
    const auth = handle.registry.modules.machines.authenticateDaemon({
      type: 'hello',
      machineId: 'local',
      token: handle.bootstrapToken,
      hostname: 'same-host',
    })
    expect(auth.ok).toBe(true)
  })
})

describe('startServer default role (no upstream configured) keeps hub surfaces on', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-role-hub-'))
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ port: 0 })
  })

  afterAll(async () => {
    await handle.close()
    delete process.env.PODIUM_STATE_DIR
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('machines.pairingCode mints a redeemable code end-to-end (pair handshake)', async () => {
    const trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${handle.port}/trpc` })],
    })
    const { code } = await trpc.machines.pairingCode.mutate()
    expect(code.length).toBeGreaterThan(0)
    const auth = handle.registry.modules.machines.authenticateDaemon({
      type: 'pair',
      code,
      machineId: 'joiner',
      hostname: 'joiner-host',
    })
    expect(auth.ok).toBe(true)
  })
})
