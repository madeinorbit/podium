/**
 * THE FEED IS UNSCOPED, AND THIS FILE SAYS SO OUT LOUD.
 *
 * POD-305 enforces WRITE-side arbitration. It does not scope READS: every
 * subscriber receives every change, and there is no principal anywhere in the
 * Authority's ports. Read-side scoping — per-principal filtering, watermarks and
 * the `evict` op — is POD-1077's, and ADR 2 Amendment 1 D13 is explicit that the
 * filter and the watermark must land TOGETHER: a suppressed row without a
 * watermark is a permanent invisible gap that heal-loops forever.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ABSENCE IS A TEST AND NOT A COMMENT
 * ---------------------------------------------------------------------------
 *
 * Because a green suite is read as a safety claim. Everything else in this
 * package passes; a reader who did not go looking would reasonably conclude the
 * Authority does not broadcast one principal's data to another, and they would be
 * wrong. POD-390 made the same absence explicit the same way — three connections,
 * three distinct principals, all still receiving the broadcast, named so nobody
 * could misread it — and this is the Authority's equivalent.
 *
 * A comment cannot do this job: it does not appear in a run, and it does not
 * FAIL when the situation changes. These tests are written to fail LOUDLY the day
 * scoping lands, with a message pointing at the issue that landed it. That is the
 * point. Deleting them then is the correct action; deleting them before is
 * removing the only record that the gap exists.
 */

import { describe, expect, it } from 'vitest'
import { Authority } from './authority'
import type { StagedChangeSpec } from './change-lifecycle'
import type { ChangeLogStore } from '../change-log'

function memoryStore(): ChangeLogStore {
  const rows: { seq: number; entity: string; entityId: string; op: string; payload: string | null }[] =
    []
  let nextSeq = 1
  return {
    appendChanges(batch) {
      const seqs: number[] = []
      for (const r of batch) {
        rows.push({ seq: nextSeq, ...r })
        seqs.push(nextSeq)
        nextSeq += 1
      }
      return seqs
    },
    maxChangeSeq: () => nextSeq - 1,
    minChangeSeq: () => rows[0]?.seq ?? null,
    changesSince: (cursor) => rows.filter((r) => r.seq > cursor),
    planChangePrune: () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: () => 0,
    latestChangeStates: () => rows,
  }
}

const upsert = (id: string, value: unknown): StagedChangeSpec => ({
  entity: 'session',
  entityId: id,
  op: 'upsert',
  value,
})

describe('READ-SIDE SCOPING IS NOT BUILT — POD-1077 owns it', () => {
  const build = () =>
    new Authority({ store: memoryStore(), now: () => 1, transact: (fn) => fn() })

  it('every subscriber receives every change, whoever they stand for', () => {
    // Three subscribers standing for three different principals. All three get
    // the same rows, including ones nominally "belonging" to the others. This
    // WILL fail when POD-1077 lands per-principal filtering, and that failure is
    // the signal to delete this file — not to weaken it.
    const authority = build()
    const ada: number[] = []
    const grace: number[] = []
    const anonymous: number[] = []
    authority.subscribe((c) => ada.push(...c.map((x) => x.seq)))
    authority.subscribe((c) => grace.push(...c.map((x) => x.seq)))
    authority.subscribe((c) => anonymous.push(...c.map((x) => x.seq)))

    authority.capture([upsert('ada-private', { owner: 'ada' })])
    authority.capture([upsert('grace-private', { owner: 'grace' })])

    expect(ada).toEqual([1, 2])
    expect(grace).toEqual([1, 2])
    expect(anonymous).toEqual([1, 2])
  })

  it('changesSince serves the whole global range to any caller', () => {
    // There is no principal parameter to serve a slice to, which is the point:
    // the port cannot express a scoped read, so no caller can accidentally
    // believe it got one.
    const authority = build()
    authority.capture([upsert('ada-private', { owner: 'ada' })])
    authority.capture([upsert('grace-private', { owner: 'grace' })])
    expect(authority.changesSince(0)).toHaveLength(2)
  })

  it('subscribe() takes NO principal — a scoped feed is unrepresentable today', () => {
    // Asserted against the runtime arity rather than the type, because a type
    // says what the author intended and arity says what the function accepts.
    // When this becomes 2, scoping has arrived.
    expect(build().subscribe.length).toBe(1)
  })

  it('no `evict` op reaches a subscriber, because nothing produces one', () => {
    // `evict` is the per-principal exit (ADR 2 Am1 D14.5) and its absence here is
    // the same gap seen from the other side: with no visibility policy there is
    // no revocation to signal.
    const authority = build()
    const ops: string[] = []
    authority.subscribe((c) => ops.push(...c.map((x) => x.op)))
    authority.capture([
      upsert('s1', { a: 1 }),
      { entity: 'session', entityId: 's1', op: 'remove' },
    ])
    expect(ops).toEqual(['upsert', 'remove'])
    expect(ops).not.toContain('evict')
  })
})
