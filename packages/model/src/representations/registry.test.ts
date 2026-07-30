import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OWNERSHIP_MATRIX_INDEX, ROW } from '../annotations/matrix'
import { asMatrixRowId } from '../annotations/ownership'
import { IssueGraphNode, IssueWire, OrphanIssue } from '../entities/issue'
import { HandoffManifest } from '../entities/handoff'
import { SessionMeta } from '../entities/session'
import {
  type RetainedRepresentation,
  representationViolations,
  representationVisibilityOf,
} from './checks'
import { DELETED_AS_DRIFTED_DUPLICATES, RETAINED_REPRESENTATIONS } from './registry'

/**
 * A minimal, VALID entry. Every planted-failure case below is this object with
 * exactly one thing wrong, so a case that fires proves the check saw that one
 * thing — and the `valid` case first proves the checker can say YES at all. A
 * refusal-only suite is satisfied by a checker that refuses everything.
 */
const valid: RetainedRepresentation = {
  symbol: 'FixtureRepresentation',
  entity: 'session',
  site: 'apps/server/src/fixture.ts',
  role: 'R5',
  purpose: 'A fixture representation used only to prove these checks fire on planted bad input.',
  distinctSemantics:
    'It differs from the aggregate by existing solely inside this test file and nowhere else.',
  composition: { state: 'composed', from: 'nothing — it is a fixture' },
  matrixRow: ROW.sessionIdentity,
  visibility: 'personal',
}

describe('representationViolations — the checks FIRE on planted bad input', () => {
  it('accepts a fully classified, fully documented fixture (the YES case)', () => {
    expect(representationViolations([valid], OWNERSHIP_MATRIX_INDEX)).toEqual([])
  })

  it('fires when a representation is UNCLASSIFIED — its matrix row does not exist', () => {
    const planted = { ...valid, matrixRow: asMatrixRowId('no-such-row') }
    const kinds = representationViolations([planted], OWNERSHIP_MATRIX_INDEX).map((v) => v.kind)
    // Both halves must fire: the missing declaration fails the build, AND the
    // default-closed resolver answers `personal` so any louder claim mismatches.
    expect(kinds).toContain('no-matrix-row')
  })

  it('resolves an unclassified representation to PERSONAL, never to tenant-visible', () => {
    // ADR 9 D4: forgetting to classify fails toward privacy. Proven on a symbol
    // that is not in the registry at all, so it holds with every entry deleted.
    expect(representationVisibilityOf('NeverRegistered', RETAINED_REPRESENTATIONS)).toBe('personal')
    // And the pair with the check above: an unclassified row declaring anything
    // LOUDER than personal is a disagreement, which is the exposure case.
    const planted = {
      ...valid,
      matrixRow: asMatrixRowId('no-such-row'),
      visibility: 'deployment-substrate' as const,
    }
    expect(representationViolations([planted], OWNERSHIP_MATRIX_INDEX).map((v) => v.kind)).toContain(
      'declaration-disagrees-with-matrix',
    )
  })

  it('fires when a declaration is LOUDER than the matrix row it points at', () => {
    const planted = { ...valid, visibility: 'deployment-substrate' as const }
    const v = representationViolations([planted], OWNERSHIP_MATRIX_INDEX)
    expect(v.map((x) => x.kind)).toEqual(['declaration-disagrees-with-matrix'])
    expect(v[0]?.detail).toContain('personal')
  })

  it('fires when a representation cannot justify itself — no purpose', () => {
    const planted = { ...valid, purpose: 'wire shape' }
    const v = representationViolations([planted], OWNERSHIP_MATRIX_INDEX)
    expect(v.map((x) => x.kind)).toEqual(['undocumented'])
    expect(v[0]?.detail).toContain('DELETED')
  })

  it('fires when a representation cannot say why its semantics differ', () => {
    const planted = { ...valid, distinctSemantics: 'it is a wire' }
    expect(representationViolations([planted], OWNERSHIP_MATRIX_INDEX).map((v) => v.kind)).toEqual([
      'undocumented',
    ])
  })

  it('fires when a claimed legitimate restatement has no coverage enforcing it', () => {
    const planted: RetainedRepresentation = {
      ...valid,
      composition: {
        state: 'declared-legitimate-restatement',
        reason: 'it is a validation gate over untrusted input, so composing would loosen it',
        enforcedBy: 'prose',
      },
    }
    const v = representationViolations([planted], OWNERSHIP_MATRIX_INDEX)
    expect(v.map((x) => x.kind)).toEqual(['undocumented'])
    expect(v[0]?.detail).toContain('silencing a detector')
  })

  it('fires on a per-user singleton planted on a representation', () => {
    const planted: RetainedRepresentation = {
      ...valid,
      schema: z.object({ sessionId: z.string(), readAt: z.string().nullable() }),
    }
    const v = representationViolations([planted], OWNERSHIP_MATRIX_INDEX)
    expect(v.map((x) => x.kind)).toEqual(['per-user-state-member'])
    expect(v[0]?.detail).toContain('POD-1076')
  })

  it('fires on a serialized effective-capability snapshot planted on a representation', () => {
    const planted: RetainedRepresentation = {
      ...valid,
      // The shape a real leak would take: a portable bundle carrying what the
      // exporter was allowed to do, so the importer need not look it up.
      schema: z.object({
        sessionId: z.string(),
        delegation: z.object({ onBehalfOf: z.string(), effectiveRights: z.array(z.string()) }),
      }),
    }
    const v = representationViolations([planted], OWNERSHIP_MATRIX_INDEX)
    expect(v.map((x) => x.kind)).toEqual(['capability-snapshot'])
    expect(v[0]?.detail).toContain('delegation.effectiveRights')
  })

  it('does NOT fire on the attribution pair, which must survive export', () => {
    // The audit must not forbid the attribution the matrix REQUIRES: `owner`,
    // `actor` and `onBehalfOf` are durable facts about who caused a write, not a
    // statement of what they were allowed to do.
    const planted: RetainedRepresentation = {
      ...valid,
      schema: z.object({
        sessionId: z.string(),
        owner: z.string(),
        actor: z.object({ kind: z.literal('user'), id: z.string() }),
        onBehalfOf: z.string().nullable(),
      }),
    }
    expect(representationViolations([planted], OWNERSHIP_MATRIX_INDEX)).toEqual([])
  })

  it('fires on an instance/tenant partition planted on a representation', () => {
    for (const key of ['instance_id', 'instanceId', 'tenantId'] as const) {
      const planted: RetainedRepresentation = {
        ...valid,
        schema: z.object({ sessionId: z.string(), [key]: z.string() }),
      }
      const v = representationViolations([planted], OWNERSHIP_MATRIX_INDEX)
      expect(v.map((x) => x.kind), key).toEqual(['instance-partition'])
      expect(v[0]?.detail).toContain('not multi-tenancy')
    }
  })
})

describe('the live registry', () => {
  /**
   * Pinned as a LITERAL, not derived from the array under test. A suite whose
   * parameter list is the thing being measured cannot notice its own coverage
   * shrinking — "39 passed" and "37 passed" read identically (POD-365's deleted
   * registry entry, POD-367 §6).
   */
  it('covers exactly 39 retained representations: 22 session + 17 issue', () => {
    expect(RETAINED_REPRESENTATIONS).toHaveLength(39)
    expect(RETAINED_REPRESENTATIONS.filter((r) => r.entity === 'session')).toHaveLength(22)
    expect(RETAINED_REPRESENTATIONS.filter((r) => r.entity === 'issue')).toHaveLength(17)
  })

  it('names every representation exactly once per site', () => {
    const keys = RETAINED_REPRESENTATIONS.map((r) => `${r.symbol}@${r.site}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('records the two drifted duplicates that were DELETED rather than documented', () => {
    // The convention's teeth: a representation that cannot answer
    // `distinctSemantics` is deleted. These two could not, and are not registered.
    expect(DELETED_AS_DRIFTED_DUPLICATES.map((d) => d.symbol)).toEqual([
      'BtwSessionInfo',
      'StatusWire',
    ])
    const registered = new Set(RETAINED_REPRESENTATIONS.map((r) => r.symbol))
    for (const d of DELETED_AS_DRIFTED_DUPLICATES) expect(registered.has(d.symbol)).toBe(false)
  })

  it('classifies every representation against a real matrix row, none louder than the matrix', () => {
    const v = representationViolations(RETAINED_REPRESENTATIONS, OWNERSHIP_MATRIX_INDEX)
    expect(
      v.filter((x) => x.kind === 'no-matrix-row' || x.kind === 'declaration-disagrees-with-matrix'),
    ).toEqual([])
  })

  it('documents every representation in the required form', () => {
    const v = representationViolations(RETAINED_REPRESENTATIONS, OWNERSHIP_MATRIX_INDEX)
    expect(v.filter((x) => x.kind === 'undocumented')).toEqual([])
  })

  it('carries NO serialized effective-capability snapshot and NO instance partition', () => {
    const v = representationViolations(RETAINED_REPRESENTATIONS, OWNERSHIP_MATRIX_INDEX)
    expect(v.filter((x) => x.kind === 'capability-snapshot')).toEqual([])
    expect(v.filter((x) => x.kind === 'instance-partition')).toEqual([])
  })

  /**
   * A RATCHET, not a zero. Five per-user singletons ride the two wire
   * projections today. They are INHERITED — POD-367 §3.5 records that none was
   * added or blessed by 1.4 — and POD-1076 owns re-keying them to
   * `(userId, entityId)`. Pinning the exact membership is what makes adding a
   * sixth a red rather than a slightly larger number.
   */
  it('pins the five INHERITED per-user singletons awaiting POD-1076', () => {
    const found = representationViolations(RETAINED_REPRESENTATIONS, OWNERSHIP_MATRIX_INDEX)
      .filter((x) => x.kind === 'per-user-state-member')
      .map((x) => `${x.representation.split(' ')[0]}.${/'([^']+)'/.exec(x.detail)?.[1]}`)
      .sort()
    expect(found).toEqual([
      'IssueWire.pinned',
      'IssueWire.readAt',
      'IssueWire.tuckedAt',
      'SessionMeta.readAt',
      'SessionMeta.snoozedUntil',
    ])
  })

  it('pins every schema-bearing entry to the schema it claims to document', () => {
    const bySymbol = new Map(RETAINED_REPRESENTATIONS.map((r) => [r.symbol, r]))
    // `toBe`, not `toEqual`: an entry pointing at a LOOK-ALIKE schema would
    // satisfy structural equality and document the wrong thing.
    expect(bySymbol.get('SessionMeta')?.schema).toBe(SessionMeta)
    expect(bySymbol.get('IssueWire')?.schema).toBe(IssueWire)
    expect(bySymbol.get('HandoffManifest')?.schema).toBe(HandoffManifest)
    expect(bySymbol.get('OrphanIssue')?.schema).toBe(OrphanIssue)
    expect(bySymbol.get('IssueGraphNode')?.schema).toBe(IssueGraphNode)
  })

  /**
   * THE ONE COMPOSITION ASSERTION THIS PACKAGE CAN ACTUALLY MAKE.
   *
   * Branding is compile-time, so a composed field swapped for a fresh
   * `z.string()` is byte-identical and passes every golden fixture — golden-green
   * is NOT evidence of composition. Only field IDENTITY sees it, so this asserts
   * the field IS the same zod instance across the three issue representations
   * that claim to compose one identity head.
   */
  it('proves the composed identity members are ONE schema instance, not three equal ones', () => {
    expect(OrphanIssue.shape.id).toBe(IssueWire.shape.id)
    expect(IssueGraphNode.shape.id).toBe(IssueWire.shape.id)
    expect(OrphanIssue.shape.seq).toBe(IssueWire.shape.seq)
    expect(HandoffManifest.shape.sessionId).toBe(SessionMeta.shape.sessionId)
  })

  it('names an owner and a blocker for every entry still pending composition', () => {
    for (const r of RETAINED_REPRESENTATIONS) {
      if (r.composition.state !== 'pending') continue
      expect(r.composition.owner, r.symbol).toMatch(/^POD-\d+$/)
      expect(r.composition.blocker.length, r.symbol).toBeGreaterThan(24)
    }
  })
})
