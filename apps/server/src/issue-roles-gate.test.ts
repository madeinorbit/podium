import { afterEach, describe, expect, it } from 'vitest'
import type { Role } from './issue-roles'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

// Minimal harness: the gate only exercises `issues.*`, which touches `ctx.registry.issues`
// (an in-memory :memory: store). `repos`/`superagent` are unused on this path, so they are
// stubbed — mirrors router-issues.test.ts and keeps the test from spinning up heavy services.
const registries: SessionRegistry[] = []

function caller(role: Role) {
  const registry = new SessionRegistry() // in-memory :memory: store
  registries.push(registry)
  return appRouter.createCaller({ registry, repos: {} as never, superagent: {} as never, role })
}

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

describe('issues.* role gate', () => {
  it('reader may query but not mutate', async () => {
    const c = caller('reader')
    await expect(c.issues.list({})).resolves.toBeDefined() // reader OK
    await expect(
      c.issues.create({ repoPath: '/r', title: 'x', startNow: false }),
    ).rejects.toThrow(/FORBIDDEN|role/i)
  })
  it('worker may claim/update but not create', async () => {
    const c = caller('worker')
    await expect(
      c.issues.create({ repoPath: '/r', title: 'x', startNow: false }),
    ).rejects.toThrow(/FORBIDDEN|role/i)
    // a worker-tier call reaches the service (then errors on unknown id, not on the gate):
    await expect(c.issues.claim({ id: 'iss_missing', assignee: 'a' })).rejects.not.toThrow(
      /FORBIDDEN/i,
    )
  })
  it('maintainer may create', async () => {
    const c = caller('maintainer')
    const w = await c.issues.create({ repoPath: '/r', title: 'x', startNow: false })
    expect(w.seq).toBe(1)
  })
  it('delete is maintainer-only (a reader is denied — destructive op)', async () => {
    await expect(caller('reader').issues.delete({ id: 'iss_x' })).rejects.toThrow(/FORBIDDEN|role/i)
    await expect(caller('worker').issues.delete({ id: 'iss_x' })).rejects.toThrow(/FORBIDDEN|role/i)
    // maintainer passes the gate, then errors on the unknown id (not FORBIDDEN):
    await expect(caller('maintainer').issues.delete({ id: 'iss_missing' })).rejects.not.toThrow(
      /FORBIDDEN/i,
    )
  })
})
