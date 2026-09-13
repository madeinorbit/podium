import { actorUser, asUserId, ISSUE_PRIVATE_EXECUTION_KEYS, IssueProjection } from '@podium/model'
import type { EntityChangeSpec } from '@podium/sync'
import { describe, expect, it } from 'vitest'
import {
  maskChangeSpecs,
  maskCommitOp,
  maskReconcileRows,
  maskSharedIssuePayload,
} from './shared-payload-mask'

/**
 * Unit witnesses for the producer-side mask [PDM-415, for PDM-387].
 *
 * The transport evidence lives in `relay.issue-private-keys.transport.test.ts`.
 * This file pins the two properties that file CANNOT see, because an end-to-end
 * green is consistent with a mask that removes too much or throws on the wrong
 * input.
 */

function fullProjection(): IssueProjection {
  return IssueProjection.parse({
    id: 'iss_1',
    seq: 1,
    title: 'A task two people can both read',
    description: { value: 'shared content' },
    stage: 'backlog',
    priority: 2,
    type: 'task',
    labels: [],
    archived: false,
    needsHuman: false,
    branch: 'issue/1-a-shared-line-of-development',
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    defaultModel: 'claude-opus-5',
    defaultEffort: 'high',
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: false,
    blockedByNotes: [],
    owner: 'user_owner',
    visibility: 'personal',
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    createdBy: { actor: actorUser(asUserId('user_owner')), onBehalfOf: asUserId('user_owner') },
    worktreePath: '/home/someone/repo/.worktrees/issue-1',
    machineId: 'm_someone_laptop',
    coordinatorSessionId: 'ses_private',
    startedBySession: 'ses_private_too',
  })
}

describe('the shared-payload mask [PDM-415]', () => {
  it('removes EXACTLY the private keys from a REAL producer payload', async () => {
    // WHAT THIS DOES AND DOES NOT SHOW [PDM-447]. This fixture is
    // `IssueProjection.parse`d, which is what the real producer emits — see the
    // reconciliation test below — so it is the right fixture for "does masking
    // lose any SUPPORTED field". It is the WRONG fixture for "can the parse drop
    // an undeclared field", because the parse has already dropped any such field
    // before the mask runs. The previous version of this test used only this
    // fixture and claimed the second property; that claim was VACUOUS and the
    // reviewer was right to strike it. The discriminating case is the next test.
    const full = fullProjection()
    const masked = maskSharedIssuePayload('issueProjection', full) as Record<string, unknown>

    expect(Object.keys(masked).sort()).toEqual(
      Object.keys(full)
        .filter((key) => !(ISSUE_PRIVATE_EXECUTION_KEYS as readonly string[]).includes(key))
        .sort(),
    )
    // NON-VACUITY: the fixture must actually carry the private keys, or the
    // assertion above is a claim about a projection that never had them.
    expect.soft(
      Object.keys(full).filter((k) => (ISSUE_PRIVATE_EXECUTION_KEYS as readonly string[]).includes(k)).sort(),
    ).toEqual([...ISSUE_PRIVATE_EXECUTION_KEYS].sort())
    // And the values that survive are unchanged, not merely present.
    expect.soft(masked.title).toBe(full.title)
    expect.soft(masked.branch).toBe(full.branch)
  })

  it('DOES drop a field the shared schema does not declare — the cost, measured', async () => {
    // THE DISCRIMINATING FIXTURE the previous test could not be [PDM-447]: built
    // as a literal and NOT passed through `IssueProjection.parse`, so it still
    // carries a key the schema has never heard of when the mask sees it.
    //
    // The result is the honest one and it is NOT what I would have preferred:
    // the mask DROPS it. `toSharedWire` is a zod object parse and a zod object
    // parse strips undeclared keys. So the over-stripping cost I claimed to have
    // "pinned" is REAL at the level of this function, and the only thing standing
    // between it and a lost field is what the producers actually emit — which is
    // the next test, and is a separate claim with its own evidence.
    const withExtra = { ...fullProjection(), extraProducerField: 'keep-me' } as Record<string, unknown>
    const masked = maskSharedIssuePayload('issueProjection', withExtra) as Record<string, unknown>

    // NON-VACUITY: the input really did carry it.
    expect.soft(withExtra.extraProducerField).toBe('keep-me')
    // THE MEASUREMENT, asserted as observed rather than as hoped.
    expect(Object.hasOwn(masked, 'extraProducerField')).toBe(false)
    // The private keys still come off, which is the property that must hold on
    // every input regardless of what else the parse does.
    expect(ISSUE_PRIVATE_EXECUTION_KEYS.filter((k) => Object.hasOwn(masked, k))).toEqual([])
  })

  it('reconciles the mask against what the producers can actually emit', async () => {
    // THE RECONCILIATION the reviewer asked for [PDM-447]: the test above shows
    // the mask can drop an undeclared key, so the question that decides whether
    // that matters is whether a PRODUCER can emit one.
    //
    // `issueProjection`: it cannot. `issueRowToProjection` ends in `toWire`,
    // which is `IssueProjection.parse(dropNullValues(issue))`
    // (`packages/model/src/projections/issue-projection.ts:146-147`). The
    // producer's output is therefore ALREADY parsed through the base schema that
    // `SharedIssueProjection` omits from, so the mask's parse cannot remove a key
    // the producer put there. Asserted rather than asserted-in-prose: masking a
    // producer-shaped payload twice is identical to masking it once, which is
    // what "already stripped" means operationally.
    const producerShaped = fullProjection()
    const once = maskSharedIssuePayload('issueProjection', producerShaped) as Record<string, unknown>
    const twice = maskSharedIssuePayload('issueProjection', once) as Record<string, unknown>
    expect(Object.keys(once).sort()).toEqual(Object.keys(twice).sort())

    // AND THE RESIDUAL, STATED RATHER THAN CLOSED. The `issue` kind's producer
    // (`IssueService.toWire`, service/core.ts:634) is a hand-built object literal
    // typed as `IssueWire`, NOT an `IssueWire.parse`. TypeScript's excess-property
    // check refuses an undeclared key written directly into that literal, but it
    // does NOT refuse one arriving via a spread of a wider object. So for `issue`
    // the guarantee is a COMPILE-TIME one with a known hole, not a runtime parse.
    // I have not found a producer that spreads a wider object into it; I have not
    // proved none exists, and this comment is the bound rather than a clearance.
  })

  it('leaves every other entity kind alone, by identity', async () => {
    // `capture` is shared with sessions, conversations and the rest. A mask that
    // reshaped a foreign payload would be a regression with no test of its own
    // anywhere near this file.
    const foreign = { hello: 'world', worktreePath: '/not/an/issue' }
    expect(maskSharedIssuePayload('session', foreign)).toBe(foreign)
    expect(maskSharedIssuePayload('issueExecution', foreign)).toBe(foreign)
    const specs = [{ entity: 'session', id: 's1', op: 'upsert', value: foreign }] as EntityChangeSpec[]
    expect(maskChangeSpecs(specs)[0]?.value).toBe(foreign)
  })

  it('keeps the owner-scoped sidecar intact', async () => {
    // Masking `issueExecution` would empty the row the owner's client re-joins
    // from — fixing the disclosure by breaking the entitled reader instead.
    const sidecar = { issueId: 'iss_1', worktreePath: '/wt', machineId: 'm1' }
    const rows = maskReconcileRows('issueExecution', [{ id: 'iss_1', value: sidecar }])
    expect(rows[0]?.value).toBe(sidecar)
  })

  it('carries a removal through without inventing a value', async () => {
    const specs = [{ entity: 'issue', id: 'iss_1', op: 'remove' }] as EntityChangeSpec[]
    const out = maskChangeSpecs(specs)
    expect(out[0]).toBe(specs[0])
    expect(out[0]).not.toHaveProperty('value')
  })

  it('strips rather than throws when a payload does not parse', async () => {
    // THE FALLBACK ARM, EXERCISED. Nothing parsed these payloads before, so the
    // parse is a new throw path on a live broadcast; under `reconcile`'s
    // full-truth contract a dropped row is diffed as a REMOVE, which would tell
    // every client the issue was deleted. A guard whose failure path is never
    // reached is a decoration, so this drives it directly.
    const malformed = { id: 'iss_1', notAnIssue: true, worktreePath: '/wt/secret', machineId: 'm1' }
    const masked = maskSharedIssuePayload('issue', malformed) as Record<string, unknown>

    // THE INVARIANT HOLDS ON THIS ARM TOO — that is the whole point of it.
    expect(ISSUE_PRIVATE_EXECUTION_KEYS.filter((k) => k in masked)).toEqual([])
    // And it is a strip, not a drop: the rest of the payload survives.
    expect.soft(masked.notAnIssue).toBe(true)
    expect.soft(masked.id).toBe('iss_1')
  })

  it('masks the commit op, which is the door the ordinary write path uses', async () => {
    // The regression this pins: masking only `capture`/`reconcile` left every
    // `crud.ts` write unmasked and the transport witness fully red, because
    // those arms declare their changes through `commit`.
    const op = {
      write: async () => 'ok',
      changes: () =>
        [{ entity: 'issue', id: 'iss_1', op: 'upsert', value: fullProjection() }] as EntityChangeSpec[],
    }
    const masked = await maskCommitOp(op).changes('ok')
    expect(ISSUE_PRIVATE_EXECUTION_KEYS.filter((k) => k in (masked[0]?.value as object))).toEqual([])
    // Non-vacuity: the unmasked op really did carry them.
    expect.soft(
      ISSUE_PRIVATE_EXECUTION_KEYS.filter((k) => k in (op.changes()[0]?.value as object)),
    ).toEqual([...ISSUE_PRIVATE_EXECUTION_KEYS])
  })
})
