/**
 * THE TOTALITY TEST — POD-304, the enforcement seam ADR 1 Amendment 1 D9 point
 * 2 and ADR 9 D4 point 2 both assign here.
 *
 * "A durable class that reaches the write funnel without a declared visibility
 * class and either an owner or a declared no-owner reason is a TEST FAILURE, not
 * a warning."
 *
 * The type system already makes most of this unavoidable — `MatrixRow` has no
 * optional column where one is required — so these tests target what a type
 * cannot: that the VALUES do not contradict the ADR, that conditionally-required
 * notes are actually present, and that the default-closed rule holds for a class
 * the matrix has never heard of.
 */

import { describe, expect, it } from 'vitest'
import {
  DECLARED_OMISSIONS,
  FIELD_LWW_MEMBERS,
  OP_STREAM_RESERVED_MEMBERS,
  OWNERSHIP_MATRIX,
  OWNERSHIP_MATRIX_INDEX,
  PER_USER_WRITER_EXCEPTIONS,
  ROW,
} from './matrix'
import {
  asMatrixRowId,
  grantVerbsOf,
  isTenantVisible,
  type MatrixRow,
  OP_STREAM_COMPACTION_CONSTRAINT,
  SYSTEM_WRITER_RULE,
  type VisibilityClass,
  visibilityClassOf,
} from './ownership'
import { conflictRuleFor, FIELD_LWW_CLOCK, permitsFieldLww } from './arbitration'

const rows = OWNERSHIP_MATRIX

// ---------------------------------------------------------------------------
// Totality: every row, every column
// ---------------------------------------------------------------------------

describe('totality — no row escapes annotation', () => {
  it('has a unique id and a real definition site for every row', () => {
    const ids = rows.map((r) => r.id as string)
    expect(new Set(ids).size).toBe(ids.length)
    for (const row of rows) {
      expect(row.sites.length, `${row.id} declares no site`).toBeGreaterThan(0)
      expect(row.title.length, `${row.id} has no title`).toBeGreaterThan(0)
    }
  })

  it('declares owner, visibility class and grants on EVERY row', () => {
    // Amendment 1 D8: "Blank" is not a value. A no-owner row carries a DECLARED
    // reason, and the reason is not allowed to be an empty string.
    for (const row of rows) {
      expect(row.visibility, `${row.id} has no visibility class`).toBeTruthy()
      if (row.owner.kind === 'none') {
        expect(row.owner.reason, `${row.id} is owner-less with no reason`).toBeTruthy()
        expect(
          row.owner.note.length,
          `${row.id} declares no-owner '${row.owner.reason}' without explaining it`,
        ).toBeGreaterThan(20)
      }
      if (row.grants.kind === 'none') {
        expect(row.grants.reason, `${row.id} has no grant rule reason`).toBeTruthy()
      }
      if (row.grants.kind === 'verbs') {
        expect(row.grants.verbs.length, `${row.id} declares an empty verb set`).toBeGreaterThan(0)
      }
    }
  })

  it('declares owner/grant inheritance on create for EVERY row (ADR 9 O4)', () => {
    for (const row of rows) {
      const rule = row.inheritanceOnCreate
      if (rule.kind === 'not-applicable') {
        expect(rule.reason.length, `${row.id} says n/a with no reason`).toBeGreaterThan(10)
      }
      if (rule.kind === 'parent') {
        expect(
          OWNERSHIP_MATRIX_INDEX.has(rule.from as string),
          `${row.id} inherits from an unknown row '${rule.from}'`,
        ).toBe(true)
      }
    }
  })

  it('resolves every `inherits` edge to a row that exists', () => {
    // A dangling edge is how an inheritance chain silently resolves to "no
    // grants" — which is safe for visibility and WRONG for the sharing feature.
    for (const row of rows) {
      if (row.owner.kind === 'inherits') {
        expect(
          OWNERSHIP_MATRIX_INDEX.has(row.owner.from as string),
          `${row.id} owner inherits unknown '${row.owner.from}'`,
        ).toBe(true)
      }
      if (row.grants.kind === 'inherits') {
        expect(
          OWNERSHIP_MATRIX_INDEX.has(row.grants.from as string),
          `${row.id} grants inherit unknown '${row.grants.from}'`,
        ).toBe(true)
      }
    }
  })

  it('records a reason for every open item it cites, and cites nothing outside O1–O6', () => {
    const canonical = new Set(['O1', 'O2', 'O3', 'O4', 'O5', 'O6'])
    for (const row of rows) {
      if (row.open.length === 0) continue
      for (const q of row.open) expect(canonical.has(q)).toBe(true)
      expect(row.openNote?.length ?? 0, `${row.id} cites ${row.open} with no note`).toBeGreaterThan(
        30,
      )
    }
  })

  it('gives every interim defect an EXPIRY CONDITION, so "known bug" cannot be permanent', () => {
    const defects = rows.filter((r) => r.interimDefect)
    // Amendment 1 D10's composer draft is the archetype; if this list ever
    // empties the assertion below still holds, but the fixture would be gone —
    // so pin that the mechanism has a live subject.
    expect(defects.map((r) => r.id)).toContain(ROW.composerDraft)
    for (const row of defects) {
      expect(row.interimDefect?.defect.length ?? 0).toBeGreaterThan(30)
      expect(
        row.interimDefect?.expiresWhen.length ?? 0,
        `${row.id} records a defect with no expiry condition`,
      ).toBeGreaterThan(30)
    }
  })

  it('explains every ADR row it omits', () => {
    for (const omission of DECLARED_OMISSIONS) {
      expect(omission.reason.length).toBeGreaterThan(40)
    }
    // The one legitimate omission is the retired legacy forwarder path.
    expect(DECLARED_OMISSIONS.map((o) => o.title).join(' ')).toContain('upstream_outbox')
  })
})

// ---------------------------------------------------------------------------
// Default-closed — and the two mechanisms are proven SEPARATELY
// ---------------------------------------------------------------------------

describe('default-closed: an unclassified class resolves PRIVATE', () => {
  // The planted fixture: a durable class that a future issue forgot to
  // classify. It is deliberately NOT added to the matrix — that absence is the
  // whole scenario.
  const UNCLASSIFIED = asMatrixRowId('some-future-entity-nobody-classified')

  it('fails the totality obligation: the class is absent from the matrix', () => {
    // This is the TEST half of the enforcement. A real new class would be
    // caught here as a missing row while its code already exists.
    expect(OWNERSHIP_MATRIX_INDEX.has(UNCLASSIFIED as string)).toBe(false)
  })

  it('STILL resolves to personal/private with the test removed — the semantic backstop', () => {
    // The counterfactual that makes this test non-vacuous: `personal` is not
    // the value a lookup miss happens to produce for every class. A row that IS
    // declared substrate resolves substrate, so the `personal` answer below is
    // the DEFAULT firing, not the absence of any answer.
    expect(visibilityClassOf(ROW.locks as string)).toBe<VisibilityClass>('deployment-substrate')
    expect(visibilityClassOf(UNCLASSIFIED as string)).toBe<VisibilityClass>('personal')
  })

  it('is not tenant-visible, and neither is anything else undeclared', () => {
    // The question a scoped feed actually asks. Note the counterfactual again:
    // the lock row IS tenant-visible, so `false` here is a decision.
    expect(isTenantVisible(ROW.locks as string)).toBe(true)
    expect(isTenantVisible(UNCLASSIFIED as string)).toBe(false)
    expect(isTenantVisible('')).toBe(false)
    expect(isTenantVisible('../../etc/passwd')).toBe(false)
  })

  it('grants nothing to an unclassified class', () => {
    // Failing closed on visibility while failing OPEN on verbs would defeat the
    // point: personal-but-writable-by-anyone is not private.
    expect(grantVerbsOf(UNCLASSIFIED as string)).toEqual([])
    expect(grantVerbsOf(ROW.issueCore as string)).toEqual(['read', 'write'])
  })

  it('refuses to ARBITRATE an unclassified class instead of guessing a merge rule', () => {
    // Visibility has a safe default; a merge policy does not. Silently picking
    // one is how a class ends up with whole-aggregate LWW nobody chose.
    expect(() => conflictRuleFor(UNCLASSIFIED as string)).toThrow(/no row for/)
  })
})

// ---------------------------------------------------------------------------
// Conformance with the ADR pack — the values, not just their presence
// ---------------------------------------------------------------------------

describe('no annotation contradicts the ADR', () => {
  it('keeps the field-LWW set closed to Amendment 1 D10 members, with clock + invariant notes', () => {
    const actual = rows.filter((r) => r.conflict === 'field-LWW').map((r) => r.id)
    expect(new Set(actual)).toEqual(new Set(FIELD_LWW_MEMBERS))
    for (const row of rows.filter((r) => r.conflict === 'field-LWW')) {
      // D3 condition 1 (defined clock) and condition 2 (independent group) must
      // both be recorded ON the row, not inferred from the ADR.
      expect(row.conflictNote, `${row.id} claims field-LWW with no note`).toBeTruthy()
      expect(row.conflictNote).toMatch(/clock|Clock/)
      expect(row.conflictNote).toMatch(/[Ii]nvariant|independent|PER KEY|one group/)
    }
    // The clock has exactly one legal value (D3 condition 1).
    expect(FIELD_LWW_CLOCK).toBe('authority-event-time-at-commit')
  })

  it('removed everything D10 moved OUT of field-LWW', () => {
    // The rows that used to be field-LWW and must not claim it any more.
    const moved = [
      ROW.sessionReadAt,
      ROW.snooze,
      ROW.pins,
      ROW.tabOrder,
      ROW.preferencesPersonal,
      ROW.issueMessageReadAt,
    ]
    for (const id of moved) {
      const row = OWNERSHIP_MATRIX_INDEX.get(id as string) as MatrixRow
      expect(row.conflict, `${id} still claims field-LWW`).toBe('single-writer')
      expect(row.visibility).toBe<VisibilityClass>('per-user-state')
    }
    // `archived` / `workState` became SHARED session facts at exp-rev.
    expect(conflictRuleFor(ROW.sessionLabels as string)).toBe('exp-rev')
    expect(permitsFieldLww(ROW.sessionLabels as string)).toBe(false)
  })

  it('reserves op-stream for D12’s named members and IMPLEMENTS NONE of it', () => {
    const reserving = rows.filter((r) => r.reservedConflict?.rule === 'op-stream').map((r) => r.id)
    expect(new Set(reserving)).toEqual(new Set(OP_STREAM_RESERVED_MEMBERS))
    // Expressible, not applied: no row may run as op-stream today.
    expect(rows.filter((r) => r.conflict === 'op-stream')).toEqual([])
    // And the ADR 2 D5 constraint travels with the reservation.
    for (const row of rows.filter((r) => r.reservedConflict)) {
      expect(row.reservedConflict?.constraint).toBe(OP_STREAM_COMPACTION_CONSTRAINT)
      expect(row.reservedConflict?.constraint).toMatch(/MATERIALIZED DOCUMENT/)
    }
    // PTY input is a CONTROL problem and must never be cited for op-stream.
    const pty = OWNERSHIP_MATRIX_INDEX.get(ROW.sessionLiveEphemeral as string) as MatrixRow
    expect(pty.reservedConflict).toBeUndefined()
    expect(pty.conflictNote).toMatch(/CONTROL problem/)
  })

  it('makes the per-user state family single-writer, per-user, owning-user-only', () => {
    const family = rows.filter((r) => r.visibility === 'per-user-state')
    expect(family.length).toBeGreaterThan(5)
    const exceptions = new Set(PER_USER_WRITER_EXCEPTIONS.map((e) => e.row as string))
    for (const row of family) {
      expect(row.conflict, `${row.id} is per-user but not single-writer`).toBe('single-writer')
      expect(row.grants.kind, `${row.id} is per-user but grantable`).toBe('none')
      if (row.grants.kind === 'none') {
        expect(row.grants.reason).toBe('per-user-state-non-grantable')
      }
      if (exceptions.has(row.id as string)) continue
      // Owning user only: not admins, not system, not agents on behalf.
      expect(row.writers, `${row.id} admits a writer other than the owning user`).toEqual([
        'operator',
      ])
      expect(row.systemWriter, `${row.id} lets system write a per-user row`).toBe('never-writes')
    }
    // Every exception is DECLARED with a reason rather than left permissive.
    for (const exception of PER_USER_WRITER_EXCEPTIONS) {
      expect(OWNERSHIP_MATRIX_INDEX.has(exception.row as string)).toBe(true)
      expect(exception.reason.length).toBeGreaterThan(40)
    }
  })

  it('states the system-writer rule on EVERY row a system principal may write', () => {
    const writable = rows.filter((r) => r.systemWriter === 'may-write')
    expect(writable.length).toBeGreaterThan(10)
    for (const row of writable) {
      expect(row.systemWriterRule, `${row.id} may be system-written with no rule stated`).toBe(
        SYSTEM_WRITER_RULE,
      )
    }
    // And rows that are NOT system-written do not carry it — the counterfactual
    // that makes the assertion above mean something.
    for (const row of rows.filter((r) => r.systemWriter === 'never-writes')) {
      expect(row.systemWriterRule, `${row.id} states the rule but never writes`).toBeUndefined()
    }
    // The rule's content: read across owners, write attributed as system into
    // the acted-on scope, never widening, never as a person.
    expect(SYSTEM_WRITER_RULE).toMatch(/READ across owners/)
    expect(SYSTEM_WRITER_RULE).toMatch(/attributed as `system`/)
    expect(SYSTEM_WRITER_RULE).toMatch(/never widen/)
    expect(SYSTEM_WRITER_RULE).toMatch(/never act AS a/)
  })

  it('keeps actor and on-behalf-of as DISTINCT annotations on every row', () => {
    for (const row of rows) {
      expect(row.attribution.actor).toBeTruthy()
      expect(row.attribution.onBehalfOf).toBeTruthy()
    }
    // The machine/system case is an explicit "none", never a defaulted person:
    // a machine is not a person and must not originate a write as one.
    const observed = OWNERSHIP_MATRIX_INDEX.get(ROW.daemonObservedRuntime as string) as MatrixRow
    expect(observed.attribution.onBehalfOf).toBe('none-representable')
    // And a personal row requires both halves — the counterfactual.
    const issue = OWNERSHIP_MATRIX_INDEX.get(ROW.issueCore as string) as MatrixRow
    expect(issue.attribution.actor).toBe('required')
    expect(issue.attribution.onBehalfOf).toBe('required')
  })

  it('keeps ADR 1 D6 intact: secrets never replicate, never enqueue, admin-grade manage', () => {
    for (const row of rows.filter((r) => r.secret === 'secret-value')) {
      expect(row.replication, `${row.id} replicates secret material`).toBe('none')
      expect(row.offline, `${row.id} may enqueue a secret write`).toBe('never-enqueue')
      expect(row.visibility, `${row.id} is secret-value but not class secret`).toBe('secret')
      expect(row.grants.kind).toBe('none')
      if (row.grants.kind === 'none') {
        expect(row.grants.reason).toBe('secret-admin-grade')
      }
      expect(row.owner.kind).toBe('none')
    }
    // telegramChatId is NOT a secret and IS per-user state (D15's boundary note).
    const chat = OWNERSHIP_MATRIX_INDEX.get(ROW.telegramChatBinding as string) as MatrixRow
    expect(chat.secret).toBe('preference')
    expect(chat.visibility).toBe<VisibilityClass>('per-user-state')
    expect(chat.secretNote).toMatch(/FAIL CLOSED/)
  })

  it('keeps machines owned compute with see/use/manage, and per-machine facts inheriting', () => {
    const machine = OWNERSHIP_MATRIX_INDEX.get(ROW.machine as string) as MatrixRow
    expect(machine.visibility).toBe<VisibilityClass>('owned-compute')
    expect(grantVerbsOf(ROW.machine as string)).toEqual(['see', 'use', 'manage'])
    // Per-machine facts inherit rather than carrying their own owner (D13.5).
    for (const id of [ROW.repoPrefix, ROW.daemonIdentityFile]) {
      const row = OWNERSHIP_MATRIX_INDEX.get(id as string) as MatrixRow
      expect(row.owner.kind, `${id} should inherit the machine`).toBe('inherits')
      expect(row.visibility).toBe<VisibilityClass>('owned-compute')
    }
    // A machine verb is NEVER a personal read/write, and vice versa (D13.2).
    const personalVerbs = new Set(grantVerbsOf(ROW.issueCore as string))
    expect(personalVerbs.has('use')).toBe(false)
    expect(new Set(grantVerbsOf(ROW.machine as string)).has('read')).toBe(false)
  })

  it('is not multi-tenancy: no instance dimension anywhere, and InstanceId does not replicate', () => {
    const instance = OWNERSHIP_MATRIX_INDEX.get(ROW.instanceId as string) as MatrixRow
    expect(instance.replication).toBe('none')
    expect(instance.visibility).toBe<VisibilityClass>('deployment-substrate')
    // ADR 1 D5 / Amendment 1 D14 / Amendment 2 D18: no tenant discriminator may
    // appear as a consequence of multi-user. Checked against the serialized
    // matrix so a future row cannot smuggle one in as a column value.
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toMatch(/instance_id|instanceId:/)
  })

  it('keeps the tenant-visible floor small and deliberate', () => {
    const substrate = rows.filter((r) => r.visibility === 'deployment-substrate').map((r) => r.id)
    // Every member is one the pack names explicitly. A new member arriving here
    // is a WIDENING and needs an ADR 1 amendment (D9.3's one-way ratchet), so
    // this list is deliberately exhaustive rather than a count.
    expect(new Set(substrate)).toEqual(
      new Set([
        ROW.instanceId,
        ROW.preferencesInstance,
        ROW.configFeatures,
        ROW.locks,
        ROW.changeLog,
        ROW.appliedMutations,
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// The inventory Phase 2 consumes
// ---------------------------------------------------------------------------

describe('visibility mutability inventory (handed to POD-1077)', () => {
  it('declares mutability on every row, with verbs iff mutable', () => {
    for (const row of rows) {
      const m = row.visibilityMutability
      expect(m.note.length, `${row.id} has no mutability note`).toBeGreaterThan(20)
      if (m.mutable) {
        expect(m.verbs.length, `${row.id} is mutable with no verb`).toBeGreaterThan(0)
      } else {
        expect(m.verbs, `${row.id} is immutable but lists verbs`).toEqual([])
      }
    }
  })

  it('marks the change log as mutable — the row the whole inventory exists for', () => {
    const feed = OWNERSHIP_MATRIX_INDEX.get(ROW.changeLog as string) as MatrixRow
    expect(feed.visibilityMutability.mutable).toBe(true)
    expect(feed.visibilityMutability.note).toMatch(/PROTOCOL BREAK/)
    expect(feed.visibilityMutability.note).toMatch(/evict|rescope/)
  })

  it('marks per-user state as NEVER mutable — non-grantable by construction', () => {
    for (const row of rows.filter((r) => r.visibility === 'per-user-state')) {
      expect(row.visibilityMutability.mutable, `${row.id} claims mutable visibility`).toBe(false)
    }
  })

  it('marks secrets and substrate immutable, and personal/owned-compute mutable', () => {
    for (const row of rows.filter((r) => r.visibility === 'secret')) {
      expect(row.visibilityMutability.mutable).toBe(false)
    }
    // The counterfactual: the classes that DO change are the ones Phase 2 must
    // build a signal for, and they are the majority of the matrix.
    const mutable = rows.filter((r) => r.visibilityMutability.mutable)
    expect(mutable.length).toBeGreaterThan(20)
    for (const row of mutable) {
      expect(['personal', 'owned-compute', 'deployment-substrate']).toContain(row.visibility)
    }
  })
})
