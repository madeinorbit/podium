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

  it('setNeedsHuman is scope-gated like other writes', async () => {
    const c = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })
    await expect(c.issues.setNeedsHuman({ id: A.id, question: 'q' })).resolves.toBeTruthy()
    await expect(c.issues.setNeedsHuman({ id: B.id, question: 'q' })).rejects.toThrow(
      /outside your subtree/,
    )
  })

  it('issues.prime binds to the capability subtree root', async () => {
    const c = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })
    const out = await c.issues.prime({ repoPath: '/r' })
    expect(out).toContain(A.title)
  })
})

// Per-session capability minting (P1b): the registry derives an agent's capability from the
// cwd its session runs in. A session inside an issue worktree gets a subtree cap rooted at
// that issue; anything else (or an unknown session) gets the most-restricted worker/none.
describe('SessionRegistry.capabilityForSession (P1b)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  it('capabilityForSession returns subtree cap for a session in an issue worktree, else none', () => {
    const registry = new SessionRegistry()
    registries.push(registry)
    // create + set worktreePath directly (start() needs a daemon repoOp round-trip).
    const i = registry.issues.create({ repoPath: '/r', title: 'W', startNow: false })
    registry.issues.update(i.id, { worktreePath: '/r/.worktrees/issue-1-w' })
    const wt = registry.issues.get(i.id)!.worktreePath as string

    const { sessionId: sid } = registry.createSession({ cwd: wt, agentKind: 'shell' })
    const cap = registry.capabilityForSession(sid)
    expect(cap).toEqual({ role: 'worker', scope: { kind: 'subtree', rootId: i.id } })

    const { sessionId: sid2 } = registry.createSession({ cwd: '/unowned', agentKind: 'shell' })
    expect(registry.capabilityForSession(sid2)).toEqual({ role: 'worker', scope: { kind: 'none' } })

    expect(registry.capabilityForSession('no-such-session')).toEqual({
      role: 'worker',
      scope: { kind: 'none' },
    })
  })
})

// Structural guarantee: the scope gate only runs for procs listed in SCOPED_TARGET, so a
// new write/manage proc that mutates an EXISTING issue must have an extractor or it silently
// escapes the subtree check. Tie coverage to PROC_ACTION so the omission fails CI, not review.
describe('scope-gate coverage (P1b)', () => {
  // Procs that mutate but have NO single existing-issue target (additive / not-an-issue):
  // attachSession is a deliberate exemption: the session re-homes itself onto an
  // issue OUTSIDE its subtree by design (issue-as-workspace), so no scope gate.
  const NO_TARGET = new Set([
    'create',
    'linearSearch',
    'attachSession',
    // mailSend is deliberately cross-scope (append-only mailbox; see issue-authz.ts) —
    // like create, a write with no EXISTING-target extractor.
    'mailSend',
  ])

  it('every write/manage proc that targets an existing issue is scope-gated', () => {
    const need = Object.entries(PROC_ACTION)
      .filter(([, a]) => a === 'write' || a === 'manage')
      .map(([p]) => p)
      .filter((p) => !NO_TARGET.has(p))
    const missing = need.filter((p) => !Object.hasOwn(SCOPED_TARGET, p))
    expect(missing).toEqual([])
  })
})

// Agent mail procs (#103): mailSend is deliberately cross-scope; mailClaim enforces
// the subtree scope in-proc (its target lives behind a message id); omitted ids
// resolve to the caller's own bound issue.
describe('issues.mail* (agent mail #103)', () => {
  const registries: SessionRegistry[] = []
  let registry: SessionRegistry
  let A: { id: string; seq: number }
  let B: { id: string; seq: number }

  beforeEach(async () => {
    registry = new SessionRegistry()
    registries.push(registry)
    const setup = appRouter.createCaller({
      registry,
      repos: {} as never,
      superagent: {} as never,
      capability: OPERATOR,
    })
    A = await setup.issues.create({ repoPath: '/r', title: 'mine', startNow: false })
    B = await setup.issues.create({ repoPath: '/r', title: 'other', startNow: false })
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

  const scopedToA = () => callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })

  it('mailSend to ANOTHER issue needs no --outside-scope; sender is issue:#<seq>', async () => {
    const m = await scopedToA().issues.mailSend({ id: B.id, body: 'heads up' })
    expect(m).toMatchObject({ issueId: B.id, fromAuthor: `issue:#${A.seq}`, status: 'unread' })
  })

  it('operator mailSend stamps from_author=operator', async () => {
    const m = await callerWith(OPERATOR).issues.mailSend({ id: A.id, body: 'hi' })
    expect(m.fromAuthor).toBe('operator')
  })

  it('mailInbox / mailPending with no id resolve to the caller bound issue', async () => {
    await callerWith(OPERATOR).issues.mailSend({ id: A.id, body: 'for A' })
    const c = scopedToA()
    expect(await c.issues.mailPending()).toEqual({ unread: 1 })
    const inbox = await c.issues.mailInbox()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ body: 'for A', wasUnread: true })
    expect(await c.issues.mailPending()).toEqual({ unread: 0 })
  })

  it('mailInbox with no id and no bound issue is a BAD_REQUEST', async () => {
    const c = callerWith({ role: 'worker', scope: { kind: 'none' } })
    await expect(c.issues.mailInbox()).rejects.toThrow(/no issue bound/)
  })

  it('mailClaim is scope-gated to the OWN issue via the message target', async () => {
    const op = callerWith(OPERATOR)
    const mine = await op.issues.mailSend({ id: A.id, body: 'mine' })
    const theirs = await op.issues.mailSend({ id: B.id, body: 'theirs' })
    const c = scopedToA()
    const r = await c.issues.mailClaim({ messageId: mine.id })
    expect(r.claimed).toBe(true)
    expect(r.message.claimedBy).toBe(`issue:#${A.seq}`)
    await expect(c.issues.mailClaim({ messageId: theirs.id })).rejects.toThrow(
      /outside your subtree/,
    )
    const c2 = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } }, true)
    await expect(c2.issues.mailClaim({ messageId: theirs.id })).resolves.toMatchObject({
      claimed: true,
    })
    await expect(c.issues.mailClaim({ messageId: 'msg_nope' })).rejects.toThrow(
      /unknown mail message/,
    )
  })

  it('second claim on the same message loses', async () => {
    const op = callerWith(OPERATOR)
    const m = await op.issues.mailSend({ id: A.id, body: 'race' })
    expect((await op.issues.mailClaim({ messageId: m.id })).claimed).toBe(true)
    const again = await scopedToA().issues.mailClaim({ messageId: m.id })
    expect(again.claimed).toBe(false)
    expect(again.message.claimedBy).toBe('operator')
  })
})
