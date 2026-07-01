import { afterEach, describe, expect, it } from 'vitest'
import { type Capability, OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

// The gate only exercises `issues.*`, which touches `ctx.registry.issues` (an in-memory
// :memory: store). `repos`/`superagent` are unused on this path, so they're stubbed —
// mirrors router-issues.test.ts and keeps the test off the heavy services.
const registries: SessionRegistry[] = []

function caller(capability: Capability) {
  const registry = new SessionRegistry() // in-memory :memory: store
  registries.push(registry)
  return appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability,
  })
}

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

const viewer: Capability = { role: 'viewer', scope: { kind: 'all' } }
const worker: Capability = { role: 'worker', scope: { kind: 'all' } }

describe('issues.* capability gate', () => {
  it('viewer may query but not mutate', async () => {
    const c = caller(viewer)
    await expect(c.issues.list({})).resolves.toBeDefined() // read OK
    await expect(c.issues.create({ repoPath: '/r', title: 'x', startNow: false })).rejects.toThrow(
      /FORBIDDEN|not allowed/i,
    )
  })

  it('worker may write (claim/update/create) but not manage (delete)', async () => {
    const c = caller(worker)
    // create is now a write-tier action (filing/decomposing is additive) — worker may create:
    const w = await c.issues.create({ repoPath: '/r', title: 'x', startNow: false })
    expect(w.seq).toBe(1)
    await expect(c.issues.delete({ id: 'iss_x' })).rejects.toThrow(/FORBIDDEN|not allowed/i)
    // a write-tier call passes the gate, then errors on the unknown id (not FORBIDDEN):
    await expect(c.issues.claim({ id: 'iss_missing', assignee: 'a' })).rejects.not.toThrow(
      /FORBIDDEN|not allowed/i,
    )
  })

  it('operator (admin) may create AND delete', async () => {
    const c = caller(OPERATOR)
    const w = await c.issues.create({ repoPath: '/r', title: 'x', startNow: false })
    expect(w.seq).toBe(1)
    // delete passes the gate, then errors on the unknown id (not FORBIDDEN):
    await expect(caller(OPERATOR).issues.delete({ id: 'iss_missing' })).rejects.not.toThrow(
      /FORBIDDEN|not allowed/i,
    )
  })
})
