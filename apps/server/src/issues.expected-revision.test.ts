import { resolvePrincipal } from './command-principal'
import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OPERATOR } from './issue-authz'
import { IssueRevisionConflict } from './modules/issues/conflict'
import { type AnyIssueCommandDef, issueRegistry } from './modules/issues/registry'
import { SessionRegistry } from './relay'
import { appRouter } from './router'

/**
 * The Issues-seed command envelope (POD-793): `expectedRevision` refused when
 * stale (ADR 3 D13.3), `mutationId` deduped on replay (ADR 2 D11.7), and both
 * declared totally across the registry (ADR 3 D13.2).
 */

/** The field names one def's input schema accepts, unwrapping `.optional()`. */
function fieldsOf(schema: z.ZodTypeAny): string[] {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema
  return inner instanceof z.ZodObject ? Object.keys(inner.shape as object) : []
}

function callerFor(registry: SessionRegistry) {
  return appRouter.createCaller({
    registry,
    repos: {} as never,
    superagent: {} as never,
    capability: OPERATOR,
    principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
  })
}

function seed(registry: SessionRegistry, title = 'subject') {
  return registry.issues.create({ repoPath: '/repo', title, startNow: false })
}

/** The revision the authority currently holds for `id`. */
function revisionOf(registry: SessionRegistry, id: string): number | undefined {
  return registry.issues.get(id)?.revision
}

/** Assert `fn` rejects with the structured CONFLICT, and hand back its detail. */
async function expectConflict(fn: () => Promise<unknown>) {
  const err = await fn().then(
    () => null,
    (e: unknown) => e,
  )
  expect(err, 'expected a rejection, but the command applied').toBeInstanceOf(TRPCError)
  const trpc = err as TRPCError
  expect(trpc.code).toBe('CONFLICT')
  expect(trpc.cause).toBeInstanceOf(IssueRevisionConflict)
  return (trpc.cause as IssueRevisionConflict).detail
}

describe('expectedRevision preconditions (ADR 3 D13)', () => {
  it('(a) refuses the second of two concurrent edits and reports the current revision', async () => {
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)

      // Both writers read the same truth.
      const base = revisionOf(registry, issue.id)
      expect(base).toBeGreaterThan(0)

      // Writer 1 lands, moving the issue off `base`.
      await caller.issues.update({
        id: issue.id,
        patch: { title: 'writer one' },
        expectedRevision: base,
      })
      const afterFirst = revisionOf(registry, issue.id)
      expect(afterFirst).toBe((base as number) + 1)

      // Writer 2 submits against the state it read — now stale. This is the lost
      // update: without the precondition it would silently overwrite writer 1.
      const detail = await expectConflict(() =>
        caller.issues.update({
          id: issue.id,
          patch: { title: 'writer two' },
          expectedRevision: base,
        }),
      )
      expect(detail).toMatchObject({
        issueId: issue.id,
        command: 'issues.update',
        expectedRevision: base,
        actualRevision: afterFirst,
        reason: 'stale-revision',
      })

      // The refusal is a REFUSAL: writer 1's work survives intact, and the
      // rejected write did not burn a revision on its way out.
      expect(registry.issues.get(issue.id)?.title).toBe('writer one')
      expect(revisionOf(registry, issue.id)).toBe(afterFirst)
    } finally {
      registry.dispose()
    }
  })

  it('(a2) applies the second edit once it rebases onto the revision the conflict reported', async () => {
    // The conflict has to be actionable, not just loud — the number it hands back
    // must be the one that works on retry.
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)
      const base = revisionOf(registry, issue.id)
      await caller.issues.update({ id: issue.id, patch: { title: 'one' }, expectedRevision: base })
      const detail = await expectConflict(() =>
        caller.issues.update({ id: issue.id, patch: { title: 'two' }, expectedRevision: base }),
      )
      await caller.issues.update({
        id: issue.id,
        patch: { title: 'two' },
        expectedRevision: detail.actualRevision,
      })
      expect(registry.issues.get(issue.id)?.title).toBe('two')
    } finally {
      registry.dispose()
    }
  })

  it('applies a write whose precondition is current', async () => {
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)
      await caller.issues.update({
        id: issue.id,
        patch: { title: 'fresh' },
        expectedRevision: revisionOf(registry, issue.id),
      })
      expect(registry.issues.get(issue.id)?.title).toBe('fresh')
    } finally {
      registry.dispose()
    }
  })

  it('leaves a write with no precondition on last-write-wins, as today', async () => {
    // The field is optional until clients carry revisions (POD-795/796). An
    // omitted precondition must keep every shipped CLI/agent/MCP write working.
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)
      await caller.issues.update({ id: issue.id, patch: { title: 'one' } })
      await caller.issues.update({ id: issue.id, patch: { title: 'two' } })
      expect(registry.issues.get(issue.id)?.title).toBe('two')
    } finally {
      registry.dispose()
    }
  })

  it('(d) applies an append-only command that carries no expectedRevision', async () => {
    // ADR 1 files comments as an APPEND create: a comment is not based on the
    // issue's prior state, so it must land even when the issue has moved under it.
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)
      await caller.issues.update({ id: issue.id, patch: { title: 'moved' } })
      await caller.issues.update({ id: issue.id, patch: { title: 'moved again' } })

      const comment = await caller.issues.addComment({
        id: issue.id,
        author: 'agent',
        body: 'lands regardless of how far the issue has moved',
      })
      expect(comment).toBeTruthy()
      expect(registry.issues.comments(issue.id)).toHaveLength(1)

      // And the contract says so, rather than the behaviour being incidental.
      // Main spells the declaration `concurrency: { kind: 'append' }`; this tree
      // spells it as the ADR 1 CONFLICT CLASS on the contract itself
      // (`packages/commands` `ConflictClass`), which the registry merges onto the
      // def. Same claim, one vocabulary.
      expect(issueRegistry.defs.addComment.conflict).toBe('append')
    } finally {
      registry.dispose()
    }
  })

  it('always has a revision to check a local issue against', async () => {
    // Why there is no server-level test of the `unverifiable` arm: the durable
    // column is `DEFAULT 1 NOT NULL` (POD-792) and the store's mapping coalesces
    // anyway, so a LOCAL issue cannot reach the dispatcher without a revision —
    // attempting to blank one is rejected by the schema itself. The arm is
    // defence for wire shapes the local store does not mint (a hub-mirrored
    // issue, a pre-ADR-2-D3 authority), and its LOGIC is pinned in
    // packages/domain/src/issue-concurrency.test.ts, where the input can actually
    // be constructed. This test guards the premise: if a local issue ever loses
    // its revision, the fail-closed arm starts firing on ordinary edits and this
    // goes red first.
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)
      expect(revisionOf(registry, issue.id)).toBeGreaterThan(0)
      await caller.issues.update({ id: issue.id, patch: { title: 'edited' } })
      expect(revisionOf(registry, issue.id)).toBeGreaterThan(0)
      await caller.issues.addComment({ id: issue.id, author: 'a', body: 'b' })
      expect(revisionOf(registry, issue.id)).toBeGreaterThan(0)
    } finally {
      registry.dispose()
    }
  })
})

describe('mutationId dedupe (ADR 2 D11.7 / ADR 3 D1)', () => {
  it('(b) returns the stored result on replay without re-applying', async () => {
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)
      const mutationId = 'mut-comment-1'

      const first = await caller.issues.addComment({
        id: issue.id,
        author: 'agent',
        body: 'exactly once',
        mutationId,
      })
      const replay = await caller.issues.addComment({
        id: issue.id,
        author: 'agent',
        body: 'exactly once',
        mutationId,
      })

      // The replay is the RECORDED result, not a second append.
      expect(replay).toEqual(first)
      expect(registry.issues.comments(issue.id)).toHaveLength(1)
    } finally {
      registry.dispose()
    }
  })

  it('(b2) records that the receipt is NOT yet hoisted into the dispatcher here', () => {
    // Main hoists the mutation receipt into the dispatcher, which makes dedupe
    // total over the registry: `claim` gets it without writing idempotency code.
    // This tree has not landed that half — the receipt is still per-handler
    // (`ctx.withMutation`), and only the contracts that carry `mutationId` can
    // reach it. `claim` is not one of them, so main's version of this test could
    // not even compile here: it passes an argument the input schema has no key
    // for.
    //
    // MEASURED rather than deleted. Asserting the enumeration means the day the
    // envelope goes registry-wide, this fails and is rewritten to main's claim —
    // where a deleted test would have left the gap invisible.
    const carriers = Object.entries(issueRegistry.defs as Record<string, AnyIssueCommandDef>)
      .filter(([, def]) => def.kind === 'mutation' && fieldsOf(def.input).includes('mutationId'))
      .map(([name]) => name)
      .sort()
    expect(carriers).toEqual([
      'addComment',
      'close',
      'create',
      'markRead',
      'markUnread',
      'setTucked',
      'update',
    ])
    expect(fieldsOf(issueRegistry.defs.claim.input)).not.toContain('mutationId')
  })

  it('replays under a DIFFERENT mutationId apply again (the id is the dedupe key)', async () => {
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const caller = callerFor(registry)
      await caller.issues.addComment({ id: issue.id, author: 'a', body: 'x', mutationId: 'm1' })
      await caller.issues.addComment({ id: issue.id, author: 'a', body: 'x', mutationId: 'm2' })
      expect(registry.issues.comments(issue.id)).toHaveLength(2)
    } finally {
      registry.dispose()
    }
  })
})

describe('the conflict reaches a real client over HTTP (ADR 3 D13.3)', () => {
  it('(c) answers 409 with a structured conflict, not a 500 and not a silent success', async () => {
    // The full transport: fetch adapter → router → guard middleware → zod parse →
    // dispatcher → errorFormatter → JSON. createCaller would skip the formatter,
    // which is exactly the seam where a structured rejection quietly degrades into
    // prose a client has to parse.
    const registry = new SessionRegistry()
    try {
      const issue = seed(registry)
      const base = revisionOf(registry, issue.id) as number
      await callerFor(registry).issues.update({
        id: issue.id,
        patch: { title: 'landed' },
        expectedRevision: base,
      })

      const res = await fetchRequestHandler({
        endpoint: '/trpc',
        router: appRouter,
        req: new Request('http://localhost/trpc/issues.update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: issue.id,
            patch: { title: 'stale writer' },
            expectedRevision: base,
          }),
        }),
        createContext: () =>
          ({
            registry,
            repos: {} as never,
            superagent: {} as never,
            capability: OPERATOR,
            principal: resolvePrincipal(OPERATOR, { parentSessionOf: () => undefined }),
          }) as never,
      })

      expect(res.status).toBe(409)
      const body = (await res.json()) as {
        error: { message: string; data: { code: string; conflict?: unknown } }
      }
      expect(body.error.data.code).toBe('CONFLICT')
      // The machine-readable half: a client can rebase off this without parsing English.
      expect(body.error.data.conflict).toEqual({
        issueId: issue.id,
        command: 'issues.update',
        expectedRevision: base,
        actualRevision: base + 1,
        reason: 'stale-revision',
      })
      // …and the human-readable half still says what happened.
      expect(body.error.message).toContain('changed since you read it')

      expect(registry.issues.get(issue.id)?.title).toBe('landed')
    } finally {
      registry.dispose()
    }
  })
})

describe('registry totality (ADR 3 D13.2 — declared per contract, never guessed)', () => {
  const mutations = Object.entries(issueRegistry.defs as Record<string, AnyIssueCommandDef>).filter(
    ([, def]) => def.kind === 'mutation',
  )

  it('covers every mutating command in the registry', () => {
    // A canary on the enumeration itself: if this count moves, a command was
    // added or removed and the rows below must be re-read, not re-baselined.
    expect(mutations).toHaveLength(45)
  })

  it.each(mutations)('%s declares a conflict class', (_name, def) => {
    expect(def.conflict).toBeDefined()
  })

  // Main's `%s accepts a client-minted mutationId` is NOT reproduced per-command:
  // the idempotency envelope is partial in this tree, and its actual extent is
  // enumerated in the (b2) case above rather than asserted 43 times over.

  it.each(mutations)('%s agrees with its own schema about expectedRevision', (_name, def) => {
    // The declaration and the wire shape cannot disagree: a def claiming exp-rev
    // while omitting the field would advertise a precondition no caller could
    // send, and one carrying the field without the declaration would accept a
    // precondition the dispatcher never checks — a guarantee in name only.
    const carries = fieldsOf(def.input).includes('expectedRevision')
    expect(carries).toBe(def.conflict === 'exp-rev')
  })

  it.each(mutations)('%s states its rule when the rule is command-specific', (_name, def) => {
    if (def.conflict !== 'cmd') return
    expect(def.conflictRule?.length ?? 0).toBeGreaterThan(10)
  })

  it('leaves reads out of the envelope entirely', () => {
    for (const [name, def] of Object.entries(
      issueRegistry.defs as Record<string, AnyIssueCommandDef>,
    )) {
      if (def.kind === 'mutation') continue
      expect(
        def.conflict,
        `${name} is a query and must not declare a conflict class`,
      ).toBeUndefined()
    }
  })
})
