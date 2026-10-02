/**
 * POD-4971 (step 5d of POD-4949) — CHANGE DETECTION FOR THE TWO ISSUE RECORDS.
 *
 * The dedup baseline drops an upsert whose detection key did not move. The old
 * record (`issue`) has a key that ignores session-derived fields, because its
 * legacy shape embedded them and every heartbeat rewrote it. The normalized
 * record (`issueProjection`) carries no derived field, so its key must be its
 * bytes: an exemption copied onto it would silently drop real changes, and the
 * old arm goes at step 7 while this kind stays.
 */

import { describe, expect, it } from 'vitest'
import { ChangeBaseline, detectionKey } from './change-log'

/** A normalized issue row, in the shape the server publishes. */
const projection = {
  id: 'iss_a',
  seq: 7,
  title: 'A title',
  stage: 'in_progress',
  revision: 3,
  updatedAt: '2026-10-01T00:00:00.000Z',
  parentId: 'iss_parent',
  worktreePath: '/r/.worktrees/a',
}
const key = (entity: 'issueProjection', value: unknown) =>
  detectionKey(entity, value, JSON.stringify(value))

describe('change detection for the normalized issue record (POD-4971)', () => {
  it('keys the normalized record on its serialized bytes', () => {
    expect(key('issueProjection', projection)).toBe(JSON.stringify(projection))
  })

  it.each(Object.keys(projection))('detects a change to %s', (field) => {
    const changed = {
      ...projection,
      [field]: `${String(projection[field as keyof typeof projection])}-moved`,
    }
    expect(key('issueProjection', changed)).not.toBe(key('issueProjection', projection))
  })

  it('never applies the old record’s session exemptions to it', () => {
    // The old arm drops `sessions`, `sessionSummary` and `unread`. A value of the
    // normalized kind that carried a field by one of those names is still a
    // change when it moves; the exemption belongs to the old record only.
    for (const field of ['sessions', 'sessionSummary', 'unread']) {
      const before = { ...projection, [field]: 1 }
      const after = { ...projection, [field]: 2 }
      expect(key('issueProjection', after)).not.toBe(key('issueProjection', before))
    }
  })

  it('records a normalized change and drops only a byte-identical repeat', () => {
    const baseline = new ChangeBaseline()
    const json = JSON.stringify(projection)
    expect(baseline.upsertChanged('issueProjection', projection.id, projection, json)).toBe(true)
    baseline.applyUpsert('issueProjection', projection.id, projection, json)
    expect(baseline.upsertChanged('issueProjection', projection.id, { ...projection }, json)).toBe(
      false,
    )
    const moved = { ...projection, worktreePath: '/r/.worktrees/b' }
    expect(
      baseline.upsertChanged('issueProjection', projection.id, moved, JSON.stringify(moved)),
    ).toBe(true)
  })
})
