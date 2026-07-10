import { describe, expect, it } from 'vitest'
import { parseChangesSinceResult } from './sync'

// Semantic validation of fetched changesSince results [spec:SP-3fe2] (#247
// round 2): shape-valid results can still lie — wrong embedded identity,
// non-contiguous seqs, or a cursor past the last change are permanent replica
// corruption/gaps if installed. All must reject (null → snapshot escalation).

// A fully schema-valid SessionMeta: known-kind values must parse the STRICT
// arm, so semantic rejections below are attributable to the semantic layer,
// not to shape failures.
const sessionValue = (sessionId: string) =>
  ({
    sessionId,
    agentKind: 'claude-code',
    title: 't',
    cwd: '/w',
    status: 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  }) as unknown

const delta = (changes: unknown[], cursor: number) => ({ kind: 'delta', changes, cursor })

const sessionUpsert = (seq: number, id: string, value: unknown = sessionValue(id)) => ({
  seq,
  entity: 'session',
  id,
  op: 'upsert',
  value,
})

describe('parseChangesSinceResult semantic validation', () => {
  it('accepts a contiguous, identity-consistent delta ending at the cursor', () => {
    const res = parseChangesSinceResult(delta([sessionUpsert(5, 'a'), sessionUpsert(6, 'b')], 6), {
      fromCursor: 4,
    })
    expect(res?.kind).toBe('delta')
  })

  it('rejects an embedded wire id disagreeing with the change id', () => {
    // Installing value{sessionId:b} under change id a strands it: a later
    // remove of 'a' can never remove the mis-keyed entity.
    const res = parseChangesSinceResult(delta([sessionUpsert(5, 'a', sessionValue('b'))], 5), {
      fromCursor: 4,
    })
    expect(res).toBeNull()
  })

  it('rejects a non-contiguous seq run (internal gap)', () => {
    const res = parseChangesSinceResult(delta([sessionUpsert(5, 'a'), sessionUpsert(7, 'b')], 7), {
      fromCursor: 4,
    })
    expect(res).toBeNull()
  })

  it('rejects a first seq that is not fromCursor + 1', () => {
    const res = parseChangesSinceResult(delta([sessionUpsert(6, 'a')], 6), { fromCursor: 4 })
    expect(res).toBeNull()
  })

  it('rejects a cursor past the last change (skipped-tail gap)', () => {
    const res = parseChangesSinceResult(delta([sessionUpsert(5, 'a')], 9), { fromCursor: 4 })
    expect(res).toBeNull()
  })

  it('accepts an empty delta with any cursor (nothing to validate)', () => {
    expect(parseChangesSinceResult(delta([], 42), { fromCursor: 42 })?.kind).toBe('delta')
  })

  it('unknown entity kinds skip identity validation but still count for contiguity', () => {
    const res = parseChangesSinceResult(
      delta(
        [sessionUpsert(5, 'a'), { seq: 6, entity: 'machine', id: 'm1', op: 'upsert', value: 1 }],
        6,
      ),
      { fromCursor: 4 },
    )
    expect(res?.kind).toBe('delta')
  })

  it('removes carry no value and skip identity validation', () => {
    const res = parseChangesSinceResult(
      delta([{ seq: 5, entity: 'session', id: 'a', op: 'remove' }], 5),
      { fromCursor: 4 },
    )
    expect(res?.kind).toBe('delta')
  })
})
