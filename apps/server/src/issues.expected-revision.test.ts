import { ISSUE_CONTRACTS, QUEUED_ISSUE_COMMANDS } from '@podium/commands'
import { ROW } from '@podium/model'
import type { Ledger } from '@podium/sync'
import { TRPCError } from '@trpc/server'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolvePrincipal } from './command-principal'

import { IssueRevisionConflict } from './modules/issues/conflict'
import { type AnyIssueCommandDef, issueRegistry } from './modules/issues/registry'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

/**
 * The Issues-seed command envelope (POD-793): `expectedRevision` refused when
 * stale (ADR 3 D13.3), `mutationId` deduped on replay (ADR 2 D11.7), and both
 * declared totally across the registry (ADR 3 D13.2).
 */

/** The input fields behind optional and refined-object wrappers. */
function fieldsOf(schema: z.ZodTypeAny): string[] {
  if (schema instanceof z.ZodOptional) return fieldsOf(schema.unwrap())
  if (schema instanceof z.ZodEffects) return fieldsOf(schema.innerType())
  return schema instanceof z.ZodObject ? Object.keys(schema.shape as object) : []
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

async function seed(registry: SessionRegistry, title = 'subject') {
  // An issue is placed under a machine that REPORTED its repo (2b803efb5).
  await registry.sessionStore.repos.addRepo('/repo', registry.sessionStore.hostMachineId)
  return await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
    repoPath: '/repo',
    title,
    startNow: false,
    parentBranch: 'main',
  })
}

/** The revision the authority currently holds for `id`. */
async function revisionOf(registry: SessionRegistry, id: string): Promise<number | undefined> {
  return (await registry.issues.reports.get(id))?.revision
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
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)

      // Both writers read the same truth.
      const base = await revisionOf(registry, issue.id)
      expect(base).toBeGreaterThan(0)

      // Writer 1 lands, moving the issue off `base`.
      await caller.issues.update({
        id: issue.id,
        patch: { title: 'writer one' },
        expectedRevision: base,
      })
      const afterFirst = await revisionOf(registry, issue.id)
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
      expect((await registry.issues.reports.get(issue.id))?.title).toBe('writer one')
      expect(await revisionOf(registry, issue.id)).toBe(afterFirst)
    } finally {
      await registry.dispose()
    }
  })

  it('(a2) applies the second edit once it rebases onto the revision the conflict reported', async () => {
    // The conflict has to be actionable, not just loud — the number it hands back
    // must be the one that works on retry.
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      const base = await revisionOf(registry, issue.id)
      await caller.issues.update({ id: issue.id, patch: { title: 'one' }, expectedRevision: base })
      const detail = await expectConflict(() =>
        caller.issues.update({ id: issue.id, patch: { title: 'two' }, expectedRevision: base }),
      )
      await caller.issues.update({
        id: issue.id,
        patch: { title: 'two' },
        expectedRevision: detail.actualRevision,
      })
      expect((await registry.issues.reports.get(issue.id))?.title).toBe('two')
    } finally {
      await registry.dispose()
    }
  })

  it('routes supplied preconditions through the production Authority hook', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const base = (await revisionOf(registry, issue.id)) as number
      const ledger = (registry as unknown as { ledger: Ledger }).ledger
      const commit = vi.spyOn(ledger.authority, 'commit')

      await callerFor(registry).issues.update({
        id: issue.id,
        patch: { title: 'authority-routed' },
        expectedRevision: base,
      })

      const requests = commit.mock.calls
        .map(([operation]) => operation.arbitrate)
        .filter((request) => request !== undefined)
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        rowId: ROW.issueCore,
        attempt: { expectedRevision: base },
        omittedExpectedRevision: 'accept',
        current: expect.any(Function),
      })
    } finally {
      await registry.dispose()
    }
  })

  it('applies a write whose precondition is current', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      await caller.issues.update({
        id: issue.id,
        patch: { title: 'fresh' },
        expectedRevision: await revisionOf(registry, issue.id),
      })
      expect((await registry.issues.reports.get(issue.id))?.title).toBe('fresh')
    } finally {
      await registry.dispose()
    }
  })

  it('leaves a write with no precondition on last-write-wins, as today', async () => {
    // The field is optional until clients carry revisions (POD-795/796). An
    // omitted precondition must keep every shipped CLI/agent/MCP write working.
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      await caller.issues.update({ id: issue.id, patch: { title: 'one' } })
      await caller.issues.update({ id: issue.id, patch: { title: 'two' } })
      expect((await registry.issues.reports.get(issue.id))?.title).toBe('two')
    } finally {
      await registry.dispose()
    }
  })

  it('(d) applies an append-only command that carries no expectedRevision', async () => {
    // ADR 1 files comments as an APPEND create: a comment is not based on the
    // issue's prior state, so it must land even when the issue has moved under it.
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      await caller.issues.update({ id: issue.id, patch: { title: 'moved' } })
      await caller.issues.update({ id: issue.id, patch: { title: 'moved again' } })

      const comment = await caller.issues.addComment({
        id: issue.id,
        body: 'lands regardless of how far the issue has moved',
      })
      expect(comment).toBeTruthy()
      expect(await registry.issues.reports.comments(issue.id)).toHaveLength(1)

      // And the contract says so, rather than the behaviour being incidental.
      // Main spells the declaration `concurrency: { kind: 'append' }`; this tree
      // spells it as the ADR 1 CONFLICT CLASS on the contract itself
      // (`packages/commands` `ConflictClass`), which the registry merges onto the
      // def. Same claim, one vocabulary.
      expect(issueRegistry.defs.addComment.conflict).toBe('append')
    } finally {
      await registry.dispose()
    }
  })

  it('always has a revision to check a local issue against', async () => {
    // Why there is no server-level test of the `unverifiable` arm: the durable
    // column is `DEFAULT 1 NOT NULL` (POD-792) and the store's mapping coalesces
    // anyway, so a LOCAL issue cannot reach the dispatcher without a revision —
    // attempting to blank one is rejected by the schema itself. The arm is
    // defence for wire shapes the local store does not mint (a hub-mirrored
    // issue, a pre-ADR-2-D3 authority), and its logic is pinned in the sync Authority
    // arbitration tests, where the input can actually be constructed. This test guards
    // the premise: if a local issue ever loses its revision, the fail-closed arm starts
    // firing on ordinary edits and this goes red first.
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      expect(await revisionOf(registry, issue.id)).toBeGreaterThan(0)
      await caller.issues.update({ id: issue.id, patch: { title: 'edited' } })
      expect(await revisionOf(registry, issue.id)).toBeGreaterThan(0)
      await caller.issues.addComment({ id: issue.id, body: 'b' })
      expect(await revisionOf(registry, issue.id)).toBeGreaterThan(0)
    } finally {
      await registry.dispose()
    }
  })
})

describe('mutationId dedupe (ADR 2 D11.7 / ADR 3 D1)', () => {
  it('(b) returns the stored result on replay without re-applying', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      const mutationId = 'mut-comment-1'

      const first = await caller.issues.addComment({
        id: issue.id,
        body: 'exactly once',
        mutationId,
      })
      const replay = await caller.issues.addComment({
        id: issue.id,
        body: 'exactly once',
        mutationId,
      })

      // The replay is the RECORDED result, not a second append.
      expect(replay).toEqual(first)
      expect(await registry.issues.reports.comments(issue.id)).toHaveLength(1)
    } finally {
      await registry.dispose()
    }
  })

  it('(b1) replays an exp-rev command without re-arbitrating its now-stale token', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      const base = (await revisionOf(registry, issue.id)) as number
      const input = {
        id: issue.id,
        patch: { title: 'exactly once' },
        expectedRevision: base,
        mutationId: 'mut-update-1',
      }
      const first = await caller.issues.update(input)
      const replay = await caller.issues.update(input)

      expect(replay).toEqual(first)
      expect((await registry.issues.reports.get(issue.id))?.title).toBe('exactly once')
      expect(await revisionOf(registry, issue.id)).toBe(base + 1)
    } finally {
      await registry.dispose()
    }
  })

  it('every queued issue command accepts its client-minted mutation identity', () => {
    expect(QUEUED_ISSUE_COMMANDS.length).toBeGreaterThan(0)
    for (const name of QUEUED_ISSUE_COMMANDS) {
      expect(fieldsOf(issueRegistry.defs[name].input), name).toContain('mutationId')
    }
    // The live replay cases above verify effects, not an obsolete partial
    // carrier list. Structural commands can use the sync submission envelope.
  })

  it('replays under a DIFFERENT mutationId apply again (the id is the dedupe key)', async () => {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const caller = callerFor(registry)
      await caller.issues.addComment({ id: issue.id, body: 'x', mutationId: 'm1' })
      await caller.issues.addComment({ id: issue.id, body: 'x', mutationId: 'm2' })
      expect(await registry.issues.reports.comments(issue.id)).toHaveLength(2)
    } finally {
      await registry.dispose()
    }
  })
})

describe('the conflict reaches a real client over HTTP (ADR 3 D13.3)', () => {
  it('(c) answers 409 with a structured conflict, not a 500 and not a silent success', async () => {
    // The full transport: fetch adapter → router → guard middleware → zod parse →
    // dispatcher → errorFormatter → JSON. createCaller would skip the formatter,
    // which is exactly the seam where a structured rejection quietly degrades into
    // prose a client has to parse.
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    try {
      const issue = await seed(registry)
      const base = (await revisionOf(registry, issue.id)) as number
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

      expect((await registry.issues.reports.get(issue.id))?.title).toBe('landed')
    } finally {
      await registry.dispose()
    }
  })
})

describe('registry totality (ADR 3 D13.2 — declared per contract, never guessed)', () => {
  const mutations = Object.entries(issueRegistry.defs as Record<string, AnyIssueCommandDef>).filter(
    ([, def]) => def.kind === 'mutation',
  )

  it('covers every mutation declared by the shared command contracts', () => {
    const declared = Object.entries(ISSUE_CONTRACTS)
      .filter(([, contract]) => contract.kind === 'mutation')
      .map(([name]) => name)
      .sort()
    expect(declared.length).toBeGreaterThan(0)
    expect(mutations.map(([name]) => name).sort()).toEqual(declared)
  })

  it.each(mutations)('%s declares a conflict class', (_name, def) => {
    expect(def.conflict).toBeDefined()
  })

  // Queued inputs carry mutationId; replay behavior is tested above, while
  // the sync submission envelope covers the structural command transport.

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

  it('leaves reads out of the envelope — as a written `n/a`, not as a silence', () => {
    // REWRITTEN BY POD-1250. The property is the same one this always asserted —
    // a query has no ADR 1 row and gets no arbitration envelope — but the field
    // is now required on `CommandContractBase`, so "must not declare a class" is
    // no longer expressible and `'n/a'` is how a query says it.
    //
    // That is a STRONGER assertion than the `toBeUndefined()` it replaces, and
    // the reason is worth keeping: `undefined` was also what a mutation whose
    // author forgot the field would have produced, so the old form passed
    // identically for "correctly has no row" and "nobody classified it". Only
    // one of those two can now reach this loop at all.
    const queries: string[] = []
    for (const [name, def] of Object.entries(
      issueRegistry.defs as Record<string, AnyIssueCommandDef>,
    )) {
      if (def.kind === 'mutation') continue
      queries.push(`issues.${name}`)
      expect(def.conflict, `${name} is a query and must declare 'n/a'`).toBe('n/a')
      expect(def.conflictRule, `${name} is a query and has no rule to state`).toBeUndefined()
    }
    const declared = Object.entries(ISSUE_CONTRACTS)
      .filter(([, contract]) => contract.kind === 'query')
      .map(([name]) => `issues.${name}`)
      .sort()
    expect(declared.length).toBeGreaterThan(0)
    expect(queries.sort()).toEqual(declared)
  })
})
