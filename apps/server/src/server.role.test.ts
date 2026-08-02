import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FLEET_CONTRACTS } from '@podium/commands'
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
const priorStateDir = process.env.PODIUM_STATE_DIR!

describe('resolveServerRole', () => {
  it('no explicit role → core + hub (the H1 shape: the server IS the rendezvous)', () => {
    expect(resolveServerRole()).toEqual({ hub: true })
    expect(resolveServerRole(undefined)).toEqual({ hub: true })
  })

  // The default is `true`, so a test asserting only the default cannot tell a working
  // override from `return { hub: true }`. Both directions, explicitly.
  it('an explicit role config wins in BOTH directions', () => {
    expect(resolveServerRole({ hub: false })).toEqual({ hub: false })
    expect(resolveServerRole({ hub: true })).toEqual({ hub: true })
  })

  // POD-309: the `config.upstream` heuristic is retired, not merely unused. A caller
  // that still passes the old second argument must not be able to switch hub OFF —
  // that is exactly the regression a re-added `!config.upstream` branch would be.
  it('a leftover upstream-shaped argument no longer turns hub surfaces off', () => {
    const asOldCaller = resolveServerRole as unknown as (
      explicit: Partial<{ hub: boolean }> | undefined,
      config: { upstream?: unknown },
    ) => { hub: boolean }
    expect(asOldCaller(undefined, { upstream: { url: 'x', token: 't' } })).toEqual({ hub: true })
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
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('core routes keep working: /health, sessions.list, machines.list', async () => {
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`)
    expect(await health.text()).toBe('ok')
    expect(await trpc.sessions.list.query()).toEqual([])
    // Reading the fleet is core (a node lists its own host machine)…
    const machines = await trpc.machines.list.query()
    expect(machines.some((m) => m.id === handle.registry.modules.machines.hostMachineId)).toBe(
      true,
    )
  })

  it('pairing/fleet procs are ABSENT: 404 NOT_FOUND, not permission-denied', async () => {
    for (const call of [
      () => trpc.machines.pairingCode.mutate(),
      () =>
        trpc.machines.rename.mutate({
          id: handle.registry.modules.machines.hostMachineId,
          name: 'nope',
        }),
      () => trpc.machines.revoke.mutate({ id: handle.registry.modules.machines.hostMachineId }),
    ]) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(TRPCClientError)
      expect((err as TRPCClientError<AppRouter>).data?.httpStatus).toBe(404)
    }
  })

  /**
   * THE COUNTERFACTUAL FOR THE BLOCK ABOVE (POD-384).
   *
   * Three 404s prove the gate refuses; they do not prove it DISCRIMINATES. A
   * server that 404'd every fleet write — a mis-derived surface, a `hubProc`
   * accidentally applied to the whole family, a router that failed to build at
   * all — would satisfy the previous test perfectly. So the same client, on the
   * same hub-less server, must still reach the fleet commands whose contracts
   * declare `serverRole: 'core'`.
   *
   * This is the test that fails if someone flips `repos.add`'s `serverRole` to
   * `hub`, and the one above is the test that fails if they flip
   * `machines.rename`'s to `core`. Neither direction is silent.
   */
  it('core fleet writes are NOT gated: repos.add/remove keep working with the hub role off', async () => {
    expect(await trpc.repos.add.mutate({ path: '/abs/node-repo' })).toContain('/abs/node-repo')
    expect(await trpc.repos.remove.mutate({ path: '/abs/node-repo' })).not.toContain(
      '/abs/node-repo',
    )
  })

  /**
   * The 404 loop above names its three by hand, which is right for readability
   * and wrong as a completeness claim: another hub-role command would be
   * added with no 404 test and nothing would say so. This binds the list to the
   * SHIPPED contract table.
   */
  it('covers every hub-role fleet contract, so another cannot arrive untested', () => {
    const hubNames = Object.values(FLEET_CONTRACTS)
      .filter((c) => c.serverRole === 'hub')
      .map((c) => c.name)
      .sort()
    expect(hubNames).toEqual([
      'machines.pairingCode',
      'machines.rename',
      'machines.revoke',
      'machines.share',
      'machines.unshare',
    ])
    // Non-vacuity: the filter must actually be filtering. If every contract were
    // `hub` (or the table were empty) the assertion above could still be made to
    // pass by editing one literal; this cannot.
    expect(Object.values(FLEET_CONTRACTS).some((c) => c.serverRole === 'core')).toBe(true)
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
    // The split-mode daemon presents the id it read from `<stateDir>/machine.id` —
    // the same file this server read, hence the same value the service reports.
    const auth = handle.registry.modules.machines.authenticateDaemon({
      type: 'hello',
      machineId: handle.registry.modules.machines.hostMachineId,
      token: handle.bootstrapToken,
      hostname: 'same-host',
    })
    expect(auth.ok).toBe(true)
  })
})

describe('startServer default role keeps hub surfaces on', () => {
  let stateDir: string
  let handle: Awaited<ReturnType<typeof startServer>>

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'podium-role-hub-'))
    process.env.PODIUM_STATE_DIR = stateDir
    handle = await startServer({ port: 0 })
  })

  afterAll(async () => {
    await handle.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
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

  /**
   * THE POSITIVE CONTROL for the hub-off 404s (POD-384): the same two commands,
   * on a server that DOES run the hub role, must succeed. Without this, a
   * derived procedure that was broken for every caller — a schema that rejects
   * everything, a handler that always throws, a name that never got built —
   * would produce the same 404-shaped evidence as a working role gate.
   */
  it('machines.rename and machines.revoke work when the hub role IS on', async () => {
    const trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${handle.port}/trpc` })],
    })
    const host = handle.registry.modules.machines.hostMachineId
    const renamed = await trpc.machines.rename.mutate({ id: host, name: 'renamed-host' })
    expect(renamed.find((m) => m.id === host)?.name).toBe('renamed-host')
    // The schema is the contract's, and it still refuses what it always refused.
    await expect(trpc.machines.rename.mutate({ id: host, name: '' })).rejects.toThrow()
    const after = await trpc.machines.revoke.mutate({ id: 'joiner' })
    expect(after.some((m) => m.id === 'joiner')).toBe(false)
  })
})
