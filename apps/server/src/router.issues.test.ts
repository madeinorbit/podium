import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Capability, OPERATOR } from './issue-authz'
import { issueRegistry } from './modules/issues/registry'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

function inputSchema(path: string) {
  // tRPC stores the parsed input parser on the procedure's _def.
  const proc = (appRouter as any)._def.procedures[path]
  return proc._def.inputs[0]
}

describe('issues router inputs (P1)', () => {
  it('create accepts priority/type/labels/parentId', () => {
    const parsed = inputSchema('issues.create').parse({
      repoPath: '/r',
      title: 'A',
      startNow: false,
      priority: 0,
      type: 'bug',
      labels: ['ui'],
      parentId: 'iss_e',
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
    expect(inputSchema('issues.close').parse({ id: 'a', reason: 'duplicate' }).reason).toBe(
      'duplicate',
    )
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

    const { sessionId: sid } = registry.modules.sessions.createSession({
      cwd: wt,
      agentKind: 'shell',
    })
    const cap = registry.modules.sessions.capabilityForSession(sid)
    // actorSessionId is stamped so close/unblock events can name their causer (#116).
    expect(cap).toEqual({
      role: 'worker',
      scope: { kind: 'subtree', rootId: i.id },
      actorSessionId: sid,
    })

    const { sessionId: sid2 } = registry.modules.sessions.createSession({
      cwd: '/unowned',
      agentKind: 'shell',
    })
    expect(registry.modules.sessions.capabilityForSession(sid2)).toEqual({
      role: 'worker',
      scope: { kind: 'none' },
      actorSessionId: sid2,
    })

    // No session behind the id → no actor to name.
    expect(registry.modules.sessions.capabilityForSession('no-such-session')).toEqual({
      role: 'worker',
      scope: { kind: 'none' },
    })
  })
})

// Structural guarantee: the scope gate only runs for defs that carry a `target`
// extractor, so a new write/manage command that mutates an EXISTING issue must
// declare one or it silently escapes the subtree check. The registry replaced
// the PROC_ACTION/SCOPED_TARGET string maps — coverage now reads the defs.
describe('scope-gate coverage (P1b)', () => {
  // Commands that mutate but have NO single existing-issue target (additive / not-an-issue):
  // attachSession is a deliberate exemption: the session re-homes itself onto an
  // issue OUTSIDE its subtree by design (issue-as-workspace), so no scope gate.
  const NO_TARGET = new Set([
    'create',
    'linearSearch',
    'attachSession',
    // mailSend is deliberately cross-scope (append-only mailbox; see the registry) —
    // like create, a write with no EXISTING-target extractor.
    'mailSend',
    // subscription add/remove act on the CALLER's own subscriptions (subscriber =
    // the caller); the source-within-subtree check runs in the handler itself (the
    // input has no single existing-issue target the guard could extract).
    'subscriptionAdd',
    'subscriptionRemove',
    // subscriptionSetEnabled targets a subscription id, not an issue; the
    // own-or-operator check runs in the handler itself.
    'subscriptionSetEnabled',
  ])

  it('every write/manage command that targets an existing issue is scope-gated', () => {
    const need = Object.entries(issueRegistry.defs)
      .filter(([, d]) => d.action === 'write' || d.action === 'manage')
      .map(([p]) => p)
      .filter((p) => !NO_TARGET.has(p))
    const missing = need.filter(
      (p) => issueRegistry.defs[p as keyof typeof issueRegistry.defs].target === undefined,
    )
    expect(missing).toEqual([])
  })

  // The other half of the completeness pair (#25): every issues.* MUTATION the
  // router actually exposes must carry write/manage authority — a 'read'-tier
  // mutation would silently open a write to viewers. The only exemptions are the
  // documented read-authority bookkeeping mutations. Enumerated from the router
  // itself so the registry and the mounted surface can't drift.
  const READ_AUTHORITY_MUTATIONS = new Set([
    // markRead is a mutation in transport only — reading an issue marks it read,
    // so it deliberately carries 'read' authority (see the registry def comment).
    'markRead',
    // markUnread (#138) is the same read-tracking bookkeeping in reverse — also
    // node-local, never hub-forwarded, 'read' authority only.
    'markUnread',
    // mailInbox mutates (listing consumes unread status) but is authz-wise a read:
    // mailbox bookkeeping on behalf of the reader — viewers may check mail.
    'mailInbox',
  ])

  it('every issues.* mutation exposed by the router carries write/manage authority', () => {
    const procedures = (
      appRouter as unknown as {
        _def: { procedures: Record<string, { _def: { type: string } }> }
      }
    )._def.procedures
    const mutations = Object.entries(procedures)
      .filter(([name, p]) => name.startsWith('issues.') && p._def.type === 'mutation')
      .map(([name]) => name.slice('issues.'.length))
    expect(mutations.length).toBeGreaterThan(20) // the enumeration actually works
    const defs = issueRegistry.defs as Record<string, { action: string }>
    const missing = mutations.filter(
      (p) => defs[p]?.action !== 'write' && defs[p]?.action !== 'manage',
    )
    expect(missing.sort()).toEqual([...READ_AUTHORITY_MUTATIONS].sort())
    // And every exempted command really is declared 'read', not merely missing.
    for (const p of READ_AUTHORITY_MUTATIONS) expect(defs[p]?.action).toBe('read')
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
    expect(await c.issues.mailPending()).toMatchObject({ unread: 1 })
    const inbox = await c.issues.mailInbox()
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ body: 'for A', wasUnread: true })
    expect(await c.issues.mailPending()).toMatchObject({ unread: 0 })
  })

  it('a PEEK at another mailbox (operator or other agent) does not consume unread', async () => {
    await callerWith(OPERATOR).issues.mailSend({ id: A.id, body: 'for A' })
    // operator peek
    const opInbox = await callerWith(OPERATOR).issues.mailInbox({ id: A.id })
    expect(opInbox[0]).toMatchObject({ status: 'unread', wasUnread: true })
    // other agent peek (reads are scope-free)
    const scopedToB = callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: B.id } })
    await scopedToB.issues.mailInbox({ id: A.id })
    // recipient still sees it unread and consumes it
    expect(await scopedToA().issues.mailPending()).toMatchObject({ unread: 1 })
    const inbox = await scopedToA().issues.mailInbox()
    expect(inbox[0]).toMatchObject({ wasUnread: true })
    expect(await scopedToA().issues.mailPending()).toMatchObject({ unread: 0 })
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

// Event subscriptions (Phase B): subscriber defaults to the caller; a subtree caller
// may only watch sources within its subtree and only see/remove its own rows.
describe('issues.subscription* authz (Phase B)', () => {
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
    A = await setup.issues.create({ repoPath: '/r', title: 'root A', startNow: false })
    B = await setup.issues.create({ repoPath: '/r', title: 'root B', startNow: false })
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
  const scopedTo = (id: string) =>
    callerWith({ role: 'worker', scope: { kind: 'subtree', rootId: id } })

  it('a subtree caller subscribes ITSELF (issue subscriber = its root)', async () => {
    const s = await scopedTo(A.id).issues.subscriptionAdd({
      event: 'issue.closed',
      source: { kind: 'issue', ref: A.id },
    })
    expect(s.subscriberKind).toBe('issue')
    expect(s.subscriberId).toBe(A.id)
    expect(s.origin).toBe('custom')
    expect(s.enabled).toBe(true)
  })

  it('a subtree caller cannot watch an issue source outside its subtree', async () => {
    await expect(
      scopedTo(A.id).issues.subscriptionAdd({
        event: 'issue.closed',
        source: { kind: 'issue', ref: B.id },
      }),
    ).rejects.toThrow(/outside your subtree/)
  })

  it('a relationship source is always in-scope', async () => {
    await expect(
      scopedTo(A.id).issues.subscriptionAdd({
        event: 'session.finished',
        source: { kind: 'relationship', ref: 'my-children' },
      }),
    ).resolves.toBeTruthy()
  })

  it("subscriptionList returns only the caller's own rows; operator sees all", async () => {
    await scopedTo(A.id).issues.subscriptionAdd({
      event: 'issue.closed',
      source: { kind: 'issue', ref: A.id },
    })
    await scopedTo(B.id).issues.subscriptionAdd({
      event: 'issue.closed',
      source: { kind: 'issue', ref: B.id },
    })
    expect((await scopedTo(A.id).issues.subscriptionList()).length).toBe(1)
    expect((await scopedTo(B.id).issues.subscriptionList()).length).toBe(1)
    expect((await callerWith(OPERATOR).issues.subscriptionList()).length).toBe(2)
  })

  it('a subtree caller may only remove its OWN subscription', async () => {
    const sa = await scopedTo(A.id).issues.subscriptionAdd({
      event: 'issue.closed',
      source: { kind: 'issue', ref: A.id },
    })
    await expect(scopedTo(B.id).issues.subscriptionRemove({ id: sa.id })).rejects.toThrow(
      /do not own/,
    )
    await expect(scopedTo(A.id).issues.subscriptionRemove({ id: sa.id })).resolves.toMatchObject({
      removed: true,
    })
  })

  it('the operator creates a subscription for an EXPLICIT subscriber (Automations UI)', async () => {
    const s = await callerWith(OPERATOR).issues.subscriptionAdd({
      event: 'issue.stage_changed:review',
      source: { kind: 'relationship', ref: 'my-children' },
      subscriber: { kind: 'issue', id: B.id },
    })
    expect(s.subscriberKind).toBe('issue')
    expect(s.subscriberId).toBe(B.id)
  })

  it('the explicit subscriber is IGNORED for a constrained caller (subscribes itself)', async () => {
    const s = await scopedTo(A.id).issues.subscriptionAdd({
      event: 'session.finished',
      source: { kind: 'relationship', ref: 'my-children' },
      subscriber: { kind: 'issue', id: B.id }, // attempt to target B — must be ignored
    })
    expect(s.subscriberId).toBe(A.id)
  })

  it('operator toggles any subscription; a subtree caller only its own', async () => {
    const sa = await scopedTo(A.id).issues.subscriptionAdd({
      event: 'issue.closed',
      source: { kind: 'issue', ref: A.id },
    })
    // Operator toggles it off, then a foreign subtree caller is refused.
    await expect(
      callerWith(OPERATOR).issues.subscriptionSetEnabled({ id: sa.id, enabled: false }),
    ).resolves.toMatchObject({ updated: true })
    expect((await callerWith(OPERATOR).issues.subscriptionList())[0]!.enabled).toBe(false)
    await expect(
      scopedTo(B.id).issues.subscriptionSetEnabled({ id: sa.id, enabled: true }),
    ).rejects.toThrow(/do not own/)
    // The owner may re-enable it.
    await expect(
      scopedTo(A.id).issues.subscriptionSetEnabled({ id: sa.id, enabled: true }),
    ).resolves.toMatchObject({ updated: true })
  })
})
