import { describe, expect, it } from 'vitest'
import { RowMirror } from './row-mirror'
import type { EntityRecord } from './types'

const ISSUE = 'issueProjection'
const key = (entity: string, id: string) => `${entity}\u0000${id}`

const whole = (id: string, extra: Record<string, unknown> = {}, seq = 5): EntityRecord => ({
  entity: ISSUE,
  entityId: id,
  value: {
    id,
    repoId: 'r1',
    seq: Number(id.slice(1)),
    stage: 'in_progress',
    title: `T ${id}`,
    ...extra,
  },
  revision: 2,
  provenance: { seq, originId: undefined, causationId: undefined, mutationId: undefined },
  asOf: seq,
})

const stub = (id: string, extra: Record<string, unknown> = {}, seq = 7): EntityRecord => ({
  entity: ISSUE,
  entityId: id,
  value: { id, repoId: 'r1', seq: Number(id.slice(1)), stage: 'done', ...extra },
  revision: 3,
  provenance: { seq, originId: 'o1', causationId: undefined, mutationId: undefined },
  part: 'stub',
  asOf: seq,
})

describe('RowMirror (POD-7115)', () => {
  it('keeps a stub only in its table and gives the same row back', () => {
    const mirror = new RowMirror()
    const row = stub('i1', { parentId: 'i9' })
    mirror.set(key(ISSUE, 'i1'), row)
    expect(mirror.mainRows()).toEqual([])
    expect(mirror.get(key(ISSUE, 'i1'))).toEqual(row)
    expect(mirror.has(key(ISSUE, 'i1'))).toBe(true)
    expect(mirror.size).toBe(1)
    expect(mirror.stubRows()).toEqual([row])
    const table = mirror.stubTable(ISSUE)
    expect(table?.stubOf('i1')).toEqual(row.value)
    expect(table?.childrenOf('i9')).toEqual(['i1'])
    expect(table?.idAt('r1', 1)).toBe('i1')
  })

  it('keeps a whole record as its row, with its stub columns in the table', () => {
    const mirror = new RowMirror()
    const row = whole('i2', { parentId: 'i9' })
    mirror.set(key(ISSUE, 'i2'), row)
    expect(mirror.get(key(ISSUE, 'i2'))).toBe(row)
    expect(mirror.mainRows()).toEqual([row])
    expect(mirror.stubRows()).toEqual([])
    const table = mirror.stubTable(ISSUE)
    expect(table?.stubOf('i2')).toEqual({
      id: 'i2',
      repoId: 'r1',
      seq: 2,
      stage: 'in_progress',
      parentId: 'i9',
    })
    expect(table?.childrenOf('i9')).toEqual(['i2'])
  })

  it('moves a row between its stub and its whole record, and removes either', () => {
    const mirror = new RowMirror()
    mirror.set(key(ISSUE, 'i3'), stub('i3'))
    const filled = whole('i3', {}, 9)
    mirror.set(key(ISSUE, 'i3'), filled)
    expect(mirror.get(key(ISSUE, 'i3'))).toBe(filled)
    expect(mirror.stubRows()).toEqual([])
    expect(mirror.size).toBe(1)
    const back = stub('i3', {}, 11)
    mirror.set(key(ISSUE, 'i3'), back)
    expect(mirror.get(key(ISSUE, 'i3'))).toEqual(back)
    expect(mirror.mainRows()).toEqual([])
    expect(mirror.delete(key(ISSUE, 'i3'))).toBe(true)
    expect(mirror.has(key(ISSUE, 'i3'))).toBe(false)
    expect(mirror.stubTable(ISSUE)?.size).toBe(0)
    expect(mirror.delete(key(ISSUE, 'i3'))).toBe(false)
  })

  it('gives back a stub value carrying an undeclared field as it came', () => {
    const mirror = new RowMirror()
    const odd = stub('i4', { title: 'not a stub field' })
    mirror.set(key(ISSUE, 'i4'), odd)
    expect(mirror.get(key(ISSUE, 'i4'))?.value).toEqual(odd.value)
  })

  it('iterates and copies every row, stubs included', () => {
    const rows = [
      whole('i5'),
      stub('i6'),
      { ...whole('x'), entity: 'session', entityId: 's1', value: { sessionId: 's1' } },
    ]
    const mirror = RowMirror.of(rows)
    expect(new Map(mirror)).toEqual(
      new Map(rows.map((row) => [key(row.entity, row.entityId), row])),
    )
    expect([...mirror.values()]).toHaveLength(3)
    expect(mirror.stubTable('session')).toBeUndefined()
    mirror.clear()
    expect(mirror.size).toBe(0)
    expect(mirror.stubTable(ISSUE)?.rows()).toEqual([])
  })
})
