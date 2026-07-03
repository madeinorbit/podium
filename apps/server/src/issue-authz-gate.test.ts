import { afterEach, describe, expect, it } from 'vitest'
import { type Capability, OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

// The gate only exercises `issues.*`, which touches `ctx.registry.issues` (an in-memory
// :memory: store). `repos`/`superagent` are unused on this path, so they're stubbed —
// mirrors router-issues.test.ts and keeps the test off the heavy services.
const registries: SessionRegistry[] = []

function caller(capability: Capability, shared?: SessionRegistry) {
  const registry = shared ?? new SessionRegistry() // in-memory :memory: store
  if (!shared) registries.push(registry)
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

  it('subtree-scoped worker may start a CHILD inside its subtree without --outside-scope; outside issues are scope-blocked', async () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    // No daemon in this harness: a real repoOp would await a machine round-trip forever.
    // Failing it fast keeps the test on what it proves — the AUTHZ gate decision.
    registry.repoOp = async () => ({ ok: false, output: 'no daemon in test harness' })
    const op = caller(OPERATOR, registry)
    const epic = await op.issues.create({ repoPath: '/r', title: 'Epic', startNow: false })
    const child = await op.issues.create({
      repoPath: '/r',
      title: 'Child',
      parentId: epic.id,
      startNow: false,
    })
    const outsider = await op.issues.create({ repoPath: '/r', title: 'Outside', startNow: false })

    const scoped = caller(
      { role: 'worker', scope: { kind: 'subtree', rootId: epic.id } },
      registry,
    )
    // In-subtree child: clears BOTH gates (role + scope) with no --outside-scope override.
    // Past the gate, start hits real git plumbing ('/r' is not a repo) — any failure there
    // must NOT be an authz denial. (Mirrors the "passes the gate, then errors on other
    // grounds" pattern above; a full worktree spawn needs a real repo + session backend.)
    const err = await scoped.issues.start({ id: child.id }).then(
      () => null,
      (e: unknown) => e,
    )
    if (err) expect(String(err)).not.toMatch(/FORBIDDEN|not allowed|outside your subtree/i)

    // Outside the subtree: the scope gate demands the explicit override.
    await expect(scoped.issues.start({ id: outsider.id })).rejects.toThrow(
      /outside your subtree/i,
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
