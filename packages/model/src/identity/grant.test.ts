import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import { GRANT_VERBS, grantVerbsOf } from '../annotations/ownership'
import { ROW } from '../annotations/matrix'
import { asUserId } from '../ids/brands'
import { ENTITY_KINDS, subjectResourceKey } from '../ids/keys'
import { asSessionId } from '../ids/brands'
import { GrantEdge, GrantVerbField } from './grant'

const edge = (over: Record<string, unknown> = {}) => ({
  resourceKind: 'session',
  resourceId: 'sess-1',
  grantee: asUserId('user:bob'),
  verb: 'read',
  owner: asUserId('user:alice'),
  visibility: 'personal',
  createdAt: '2026-07-30T00:00:00.000Z',
  createdBy: { actor: { kind: 'user', id: asUserId('user:alice') }, onBehalfOf: asUserId('user:alice') },
  ...over,
})

describe('the grant edge is (entityRef, granteeUserId, verb) — ADR 9 D2', () => {
  it('parses the triple plus its accountable party and attribution', () => {
    expect(GrantEdge.safeParse(edge()).success).toBe(true)
  })

  it('refuses an edge with no grantee, no verb, or no resource', () => {
    for (const missing of ['grantee', 'verb', 'resourceId', 'resourceKind']) {
      const { [missing]: _dropped, ...partial } = edge() as Record<string, unknown>
      expect(GrantEdge.safeParse(partial).success).toBe(false)
    }
  })

  it('the granter is the `owner` — one column for one fact', () => {
    // ADR 1's matrix resolves this row's owner as `granter`. A separate
    // `granter` field beside `owner` is two columns holding one fact, which is
    // the drift this phase deletes; `registry.test.ts` caught exactly that in
    // this file's first draft.
    expect(GrantEdge.shape).toHaveProperty('owner')
    expect(GrantEdge.shape).not.toHaveProperty('granter')
  })

  it('keeps the ACTOR separate from the granter — they genuinely differ', () => {
    // An agent may perform a share on behalf of its human: the actor is the
    // agent, the accountable granter is the human (ADR 9 D5 A3/A4). Collapsing
    // them makes "did a person or an agent share this?" unanswerable.
    const byAgent = GrantEdge.safeParse(
      edge({
        createdBy: {
          actor: { kind: 'agent', id: 'agent-1' },
          onBehalfOf: asUserId('user:alice'),
        },
      }),
    )
    expect(byAgent.success).toBe(true)
  })
})

describe('the verb vocabulary is ADR 9’s, not a second one', () => {
  it('the field enum and the matrix vocabulary are ONE list', () => {
    expect(GrantVerbField.options).toBe(GRANT_VERBS)
    expect([...GRANT_VERBS]).toEqual(['read', 'write', 'see', 'use', 'manage'])
  })

  it('refuses a verb nobody declared', () => {
    expect(GrantVerbField.safeParse('admin').success).toBe(false)
    expect(GrantVerbField.safeParse('execute').success).toBe(false)
  })

  it('`use` is annotated on machines and NOT on personal classes', () => {
    // ADR 9 D6 M2: `use` is a CODE-EXECUTION boundary — arbitrary execution on
    // someone's hardware with their SSH keys and checked-out private repos. A
    // personal class offering it would make it look like a louder `read`.
    expect([...grantVerbsOf(ROW.machine)].sort()).toEqual(['manage', 'see', 'use'])
    expect([...grantVerbsOf(ROW.sessionIdentity)].sort()).toEqual(['read', 'write'])
    expect(grantVerbsOf(ROW.sessionIdentity)).not.toContain('use')
  })

  it('a class that declares NO grants resolves to no verbs, not to a default set', () => {
    // Per-user state is non-grantable BY CONSTRUCTION (D3 rule 4). If
    // `grantVerbsOf` fell back to a default verb list for an undeclared class,
    // this would return something.
    expect(grantVerbsOf(ROW.perUserStateFamily)).toEqual([])
    expect(grantVerbsOf('a-row-that-does-not-exist')).toEqual([])
  })
})

describe('the resource half tracks ONE entity-kind list', () => {
  it('admits every kind the key constructors admit', () => {
    for (const kind of ENTITY_KINDS) {
      expect(GrantEdge.safeParse(edge({ resourceKind: kind })).success).toBe(true)
    }
  })

  it('refuses a kind that list does not have', () => {
    expect(GrantEdge.safeParse(edge({ resourceKind: 'widget' })).success).toBe(false)
  })

  it('is the parsed form of the key the edge is stored under', () => {
    // Not a second description of the same thing: `subjectResourceKey` encodes
    // [subject.kind, subject.id, resource.kind, resource.id], and the schema's
    // resource half is the (kind, id) pair that key carries.
    const key = subjectResourceKey(
      { kind: 'user', id: asUserId('user:bob') },
      { kind: 'session', id: asSessionId('sess-1') },
    )
    expect(key).toContain('session')
    expect(key).toContain('sess-1')
  })
})

describe('a grant is an INPUT to a decision, never the decision (ADR 9 D2 rule 4)', () => {
  it('carries no resolved permission set, no expiry, no inheritance source', () => {
    for (const forbidden of ['effectiveRights', 'allowed', 'expiresAt', 'inheritedFrom']) {
      expect(GrantEdge.shape).not.toHaveProperty(forbidden)
    }
  })

  it('the detector’s verdict is exactly ["grantee"] — the edge, not a right', () => {
    // POD-643's name matcher matches `grant`, so `grantee` is the one key it
    // sees on this shape. That is the correct verdict and not a carve-out: this
    // aggregate IS ADR 9 D2's grant edge, so a key naming the grantee is what it
    // is FOR — while what it must never carry is the RESOLVED answer computed
    // from it. Pinned, so anything else the detector matches fails here.
    expect(findCapabilitySnapshotKeys(GrantEdge).sort()).toEqual(['grantee'])
  })

  it('FIRES on a frozen right added beside them — the instrument can say NO', () => {
    const frozen = GrantEdge.extend({ effectiveRights: z.array(z.string()) })
    expect(findCapabilitySnapshotKeys(frozen)).toContain('effectiveRights')
  })
})
