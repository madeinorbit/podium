import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Capability, OPERATOR, PROC_ACTION } from './issue-authz'
import { SessionRegistry } from './relay'
import { appRouter, SCOPED_TARGET } from './router'

function inputSchema(path: string) {
  // tRPC stores the parsed input parser on the procedure's _def.
  const proc = (appRouter as any)._def.procedures[path]
  return proc._def.inputs[0]
}

describe('issues router inputs (P1)', () => {
  it('create accepts priority/type/labels/parentId', () => {
    const parsed = inputSchema('issues.create').parse({
      repoPath: '/r', title: 'A', startNow: false,
      priority: 0, type: 'bug', labels: ['ui'], parentId: 'iss_e',
    })
    expect(parsed.priority).toBe(0)
    expect(parsed.type).toBe('bug')
  })

  it('depAdd requires fromId + toId', () => {
    expect(() => inputSchema('issues.depAdd').parse({ fromId: 'a' })).toThrow()
    expect(inputSchema('issues.depAdd').parse({ fromId: 'a', toId: 'b' }).type).toBeUndefined()
  })

  it('close accepts an optional reason', () => {
    expect(inputSchema('issues.close').parse({ id: 'a' }).id).toBe('a')
    expect(inputSchema('issues.close').parse({ id: 'a', reason: 'duplicate' }).reason).toBe('duplicate')
  })
})

// Subtree-scope enforcement in the issues middleware (P1a). Reuses the caller/registry
// pattern from issue-authz-gate.test.ts: an in-memory :memory: SessionRegistry, with
// repos/superagent stubbed (unused on the issues.* path). Two issues are pre-created via
// an OPERATOR caller — A (a subtree root) and B (unrelated) — then constrained callers
// exercise the scope gate. overrideScope is optional on Context; scoped callers pass it.
describe('issues.* subtree scope (P1a)', () => {
  const registries: SessionRegistry[] = []
  let registry: SessionRegistry
  let A: { id: string; title: string }
  let B: { id: string; title: string }

  beforeEach(async () => {
    registry = new SessionRegistry()
    registries.push(registry)
    const setup = appRouter.createCaller({
      registry,
      repos: {} as never,
      superagent: {} as never,
      capability: OPERATOR,
    })
    A = await setup.issues.create({ repoPath: '/r', title: 'epic root', startNow: false })
    B = await setup.issues.create({ repoPath: '/r', title: 'unrelated', startNow: false })
  })

  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  const callerWith = (capability: Capability, overrideScope = false) =>
    appRouter.createCaller({
      registry,
      repos: {} as never,
      superagent: {} as never,
      capability,
      overrideScope,
    })

  it('worker may write inside its subtree', async () => {
    const c = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })
    await expect(c.issues.update({ id: A.id, patch: { notes: 'x' } })).resolves.toBeTruthy()
  })

  it('worker writing outside its subtree is rejected until overridden', async () => {
    const c = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })
    await expect(c.issues.update({ id: B.id, patch: { notes: 'x' } })).rejects.toThrow(
      /outside your subtree/,
    )
    const c2 = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } }, true)
    await expect(c2.issues.update({ id: B.id, patch: { notes: 'x' } })).resolves.toBeTruthy()
  })

  it('worker may always create and always read', async () => {
    const c = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })
    await expect(
      c.issues.create({ repoPath: '/r', title: 'filed', startNow: false }),
    ).resolves.toBeTruthy()
    await expect(c.issues.get({ id: B.id })).resolves.toBeTruthy()
  })

  it('operator (default) is unaffected', async () => {
    const c = appRouter.createCaller({
      registry,
      repos: {} as never,
      superagent: {} as never,
      capability: OPERATOR,
    })
    await expect(c.issues.update({ id: B.id, patch: { notes: 'x' } })).resolves.toBeTruthy()
  })

  it('issues.prime binds to the capability subtree root', async () => {
    const c = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })
    const out = await c.issues.prime({ repoPath: '/r' })
    expect(out).toContain(A.title)
  })
})

// Structural guarantee: the scope gate only runs for procs listed in SCOPED_TARGET, so a
// new write/manage proc that mutates an EXISTING issue must have an extractor or it silently
// escapes the subtree check. Tie coverage to PROC_ACTION so the omission fails CI, not review.
describe('scope-gate coverage (P1b)', () => {
  // Procs that mutate but have NO single existing-issue target (additive / not-an-issue):
  const NO_TARGET = new Set(['create', 'linearSearch'])

  it('every write/manage proc that targets an existing issue is scope-gated', () => {
    const need = Object.entries(PROC_ACTION)
      .filter(([, a]) => a === 'write' || a === 'manage')
      .map(([p]) => p)
      .filter((p) => !NO_TARGET.has(p))
    const missing = need.filter((p) => !(p in SCOPED_TARGET))
    expect(missing).toEqual([])
  })
})
