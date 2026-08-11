/**
 * THE ARBITRATION RULES — tested against REAL matrix rows, not a fixture matrix.
 *
 * The rowIds below are looked up in `@podium/model`'s shipped ownership matrix,
 * so a row whose declared conflict rule changes fails here rather than silently
 * changing how the Authority arbitrates it. A fixture matrix would have made
 * every case below a test of the fixture.
 *
 * WHY THIS FILE IS SUSPICIOUS OF ITSELF: POD-351 found every one of its
 * revocation tests passing because OPERATOR has scope 'all' and short-circuits
 * `authorize()` before the owner is ever read — they would have passed against an
 * implementation with NO ownership check at all. The equivalent trap here is a
 * test that passes because the rule it names is never reached. So each rule has
 * BOTH an accepting and a rejecting case over the same row, which is the
 * counterfactual: a detector stuck on one answer fails one of the pair.
 */

import { conflictRuleFor, OWNERSHIP_MATRIX, type MatrixRow } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { arbitrate, type ArbitrationRequest } from './arbitration'

/** The first real row declaring `rule`, so the tests bind to shipped data. */
function rowWith(rule: string): MatrixRow {
  const row = OWNERSHIP_MATRIX.find((r) => r.conflict === rule)
  if (!row) throw new Error(`no shipped matrix row declares conflict '${rule}'`)
  return row
}

const at = (eventTime: number) => ({ eventTime })

describe('the rows this suite binds to are real', () => {
  it('resolves each rule to a shipped matrix row', () => {
    // Non-vacuity guard. If the matrix ever failed to import, every `rowWith`
    // below would throw and the failures would look like arbitration bugs; if it
    // imported EMPTY, `find` would return undefined and this says so first.
    for (const rule of ['exp-rev', 'field-LWW', 'single-writer', 'append', 'cmd']) {
      const row = rowWith(rule)
      expect(conflictRuleFor(row.id)).toBe(rule)
    }
  })
})

describe('exp-rev — ADR 1 D2, the default', () => {
  const rowId = rowWith('exp-rev').id

  it('accepts a matching expected revision', () => {
    const verdict = arbitrate({
      rowId,
      attempt: { ...at(100), expectedRevision: 7 },
      current: { revision: 7 },
    })
    expect(verdict).toEqual({ kind: 'accept', rule: 'exp-rev' })
  })

  it('REJECTS a mismatched one — the client rebases (POD-316)', () => {
    const verdict = arbitrate({
      rowId,
      attempt: { ...at(100), expectedRevision: 6 },
      current: { revision: 7 },
    })
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'revision-mismatch' })
  })

  it('REJECTS an update that carries no expected revision at all', () => {
    // D2's "silent whole-aggregate LWW is not the default", at the one place it
    // could leak in: a client that simply omits the field must not get
    // last-write-wins for free on the rows most protected against it.
    const verdict = arbitrate({ rowId, attempt: at(100), current: { revision: 7 } })
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'expected-revision-required' })
  })

  it('accepts omitted update preconditions only when a caller opts into compatibility', () => {
    expect(
      arbitrate({
        rowId,
        attempt: at(100),
        current: { revision: 7 },
        omittedExpectedRevision: 'accept',
      }),
    ).toEqual({ kind: 'accept', rule: 'exp-rev' })
  })

  it('accepts a CREATE with no expected revision', () => {
    // There is no revision to have expected. Demanding one would make it
    // impossible to create anything on the default rule — i.e. on most rows.
    expect(arbitrate({ rowId, attempt: at(100) })).toEqual({ kind: 'accept', rule: 'exp-rev' })
  })

  it('REJECTS a create whose caller expected an existing revision', () => {
    // A caller that believes it is updating a row that does not exist has a
    // stale view, and accepting would silently turn its update into a create.
    const verdict = arbitrate({ rowId, attempt: { ...at(100), expectedRevision: 1 } })
    expect(verdict).toMatchObject({ kind: 'reject', reason: 'revision-mismatch' })
  })

  it('does not accept revision 0 as "absent"', () => {
    // The falsy-zero trap: `if (!expectedRevision)` would read a legitimate
    // revision 0 as "none supplied" and take the create arm.
    expect(
      arbitrate({ rowId, attempt: { ...at(100), expectedRevision: 0 }, current: { revision: 0 } }),
    ).toEqual({ kind: 'accept', rule: 'exp-rev' })
    expect(
      arbitrate({ rowId, attempt: { ...at(100), expectedRevision: 0 }, current: { revision: 1 } }),
    ).toMatchObject({ kind: 'reject', reason: 'revision-mismatch' })
  })
})

describe('field-LWW — ADR 1 D3, opt-in and clock-defined', () => {
  const rowId = rowWith('field-LWW').id

  it('accepts a strictly later Authority event time', () => {
    expect(arbitrate({ rowId, attempt: at(200), current: { eventTime: 100 } })).toEqual({
      kind: 'accept',
      rule: 'field-LWW',
    })
  })

  it('REJECTS an earlier one as a stale write', () => {
    expect(arbitrate({ rowId, attempt: at(50), current: { eventTime: 100 } })).toMatchObject({
      kind: 'reject',
      reason: 'stale-write',
    })
  })

  it('REJECTS A TIE — the incumbent stays', () => {
    // "Last" must mean STRICTLY later or the rule is a coin flip at millisecond
    // resolution, decided by which write the scheduler happened to run second.
    // A coin flip is exactly what D3's "defined clock" condition rules out.
    expect(arbitrate({ rowId, attempt: at(100), current: { eventTime: 100 } })).toMatchObject({
      kind: 'reject',
      reason: 'stale-write',
    })
  })

  it('accepts against a row with no recorded event time', () => {
    expect(arbitrate({ rowId, attempt: at(1), current: {} })).toEqual({
      kind: 'accept',
      rule: 'field-LWW',
    })
  })

  it('ignores the expected revision entirely on an LWW row', () => {
    // The counterfactual that catches a rule dispatch falling through to the
    // exp-rev arm: a mismatched expected revision would be REJECTED there, and
    // is irrelevant here.
    expect(
      arbitrate({
        rowId,
        attempt: { ...at(200), expectedRevision: 999 },
        current: { revision: 1, eventTime: 100 },
      }),
    ).toEqual({ kind: 'accept', rule: 'field-LWW' })
  })
})

describe('single-writer — only the home source', () => {
  const rowId = rowWith('single-writer').id

  it('accepts the declared home source', () => {
    expect(
      arbitrate({ rowId, attempt: { ...at(1), writer: 'daemon' }, singleWriter: 'daemon' }),
    ).toEqual({ kind: 'accept', rule: 'single-writer' })
  })

  it('REJECTS anyone else — "clients cannot forge status"', () => {
    expect(
      arbitrate({ rowId, attempt: { ...at(1), writer: 'operator' }, singleWriter: 'daemon' }),
    ).toMatchObject({ kind: 'reject', reason: 'not-the-single-writer' })
  })

  it('REJECTS a write that names no writer at all', () => {
    // Default-closed: an unnamed writer is not the home source, so it loses.
    expect(arbitrate({ rowId, attempt: at(1), singleWriter: 'daemon' })).toMatchObject({
      kind: 'reject',
      reason: 'not-the-single-writer',
    })
  })

  it('THROWS when the request names no home source', () => {
    // Waving it through would make `single-writer` mean nothing on exactly the
    // rows that chose it. A throw is the only answer that cannot be misread.
    expect(() => arbitrate({ rowId, attempt: { ...at(1), writer: 'daemon' } })).toThrow(
      /names no home source/,
    )
  })
})

describe('append — create-only classes', () => {
  const rowId = rowWith('append').id

  it('accepts a create', () => {
    expect(arbitrate({ rowId, attempt: at(1) })).toEqual({ kind: 'accept', rule: 'append' })
  })

  it('REJECTS a write against an entity that already exists', () => {
    expect(arbitrate({ rowId, attempt: at(1), current: { revision: 1 } })).toMatchObject({
      kind: 'reject',
      reason: 'append-only',
    })
  })

  it('rejects on EXISTENCE, not on a revision comparison', () => {
    // An append row need not carry a revision at all, so a rule that compared
    // one would accept every second write on a row with no revision recorded.
    expect(arbitrate({ rowId, attempt: at(1), current: {} })).toMatchObject({
      kind: 'reject',
      reason: 'append-only',
    })
  })
})

describe('cmd — the command documents its own rule (ADR 1 D2)', () => {
  const rowId = rowWith('cmd').id

  it('defers to the supplied rule when it permits', () => {
    expect(
      arbitrate({ rowId, attempt: at(1), commandRule: () => ({ ok: true }) }),
    ).toEqual({ kind: 'accept', rule: 'cmd' })
  })

  it('REJECTS with the rule’s own detail when it refuses', () => {
    const verdict = arbitrate({
      rowId,
      attempt: at(1),
      commandRule: () => ({ ok: false, detail: 'lease held by another session' }),
    })
    expect(verdict).toEqual({
      kind: 'reject',
      rule: 'cmd',
      reason: 'command-rule-refused',
      detail: 'lease held by another session',
    })
  })

  it('hands the rule the attempt AND the current state', () => {
    // Without both, a lease machine cannot tell a renew from a steal, and every
    // `cmd` row would have to re-read the entity it was just handed.
    const seen: unknown[] = []
    arbitrate({
      rowId,
      attempt: { ...at(42), writer: 'operator' },
      current: { revision: 3 },
      commandRule: (attempt, current) => {
        seen.push(attempt, current)
        return { ok: true }
      },
    })
    expect(seen).toEqual([{ eventTime: 42, writer: 'operator' }, { revision: 3 }])
  })

  it('THROWS when the row is `cmd` and no rule was supplied', () => {
    // A `cmd` row with no rule is an UNARBITRATED write, not a permissive one.
    // Accepting would make the whole class a synonym for "unchecked".
    expect(() => arbitrate({ rowId, attempt: at(1) })).toThrow(/supplies none/)
  })
})

describe('the classes that must fail LOUD', () => {
  it('THROWS on a row with no declared conflict rule (ADR 1 D4 totality)', () => {
    // Unlike visibility — where a missing declaration has a safe answer,
    // private — there is no safe default merge policy, and picking one silently
    // is how a class ends up with whole-aggregate LWW that nobody chose.
    expect(() => arbitrate({ rowId: 'no-such-row', attempt: at(1) })).toThrow(/no row for/)
  })

  it('THROWS on `op-stream`, which is reserved and unbuilt', () => {
    // Degrading to LWW would silently drop characters out of collaborative text
    // with nothing downstream able to tell. No SHIPPED row declares `op-stream`
    // — D12 keeps its three members on `field-LWW` — so the arm is reachable
    // only through the injected index, which is exactly why that seam exists.
    const index = new Map<string, MatrixRow>([
      ['fake.op-stream', { conflict: 'op-stream' } as unknown as MatrixRow],
    ])
    expect(() => arbitrate({ rowId: 'fake.op-stream', attempt: at(1), index })).toThrow(
      /RESERVED and .*unbuilt/s,
    )
  })

  it('and the injected index is not a way to WEAKEN a rule', () => {
    // The counterfactual for the seam: it resolves rules, it does not bypass
    // them. A row injected as exp-rev still gets exp-rev's refusals.
    const index = new Map<string, MatrixRow>([
      ['fake.exp-rev', { conflict: 'exp-rev' } as unknown as MatrixRow],
    ])
    expect(
      arbitrate({ rowId: 'fake.exp-rev', attempt: at(1), current: { revision: 2 }, index }),
    ).toMatchObject({ kind: 'reject', reason: 'expected-revision-required' })
  })
})

describe('what arbitration is NOT', () => {
  it('has nowhere to put a principal, a grant, an owner or a capability', () => {
    // Structural, not incidental. Arbitration asks "does this write win"; whether
    // the principal may write AT ALL is authorization, resolved live before this
    // runs. Collapsing them leaks what the consistent-error rule protects — a
    // rejection may carry a reason, a denial may not.
    const request: ArbitrationRequest = { rowId: rowWith('exp-rev').id, attempt: at(1) }
    const keys = new Set(Object.keys(request.attempt))
    for (const forbidden of ['principal', 'userId', 'owner', 'capability', 'grants', 'onBehalfOf']) {
      expect(keys.has(forbidden)).toBe(false)
    }
  })

  it('has nowhere to put a CLIENT clock (ADR 1 D3 condition 1)', () => {
    // `eventTime` is the Authority's, stamped at commit. A second clock field
    // would be the one a client could fill in, and a client that could pick its
    // own event time wins every field-LWW race by picking a large number.
    const request: ArbitrationRequest = { rowId: rowWith('field-LWW').id, attempt: at(1) }
    expect(Object.keys(request.attempt)).toEqual(['eventTime'])
  })
})
