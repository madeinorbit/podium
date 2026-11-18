import { describe, expect, it } from 'vitest'
import { stubFieldsOf, stubOfValue } from './holdings'
import { StubTable } from './stub-table'

const ISSUE = 'issueProjection'
const FIELDS = stubFieldsOf(ISSUE)

type Row = Record<string, unknown>

/** The old answers: rebuilt from every row on each read (replica.ts before POD-7094). */
function oldAnswers(rows: ReadonlyMap<string, Row>) {
  const stubs = new Map([...rows].map(([id, value]) => [id, stubOfValue(ISSUE, value)]))
  const children = new Map<string, string[]>()
  const references = new Map<string, string>()
  for (const [id, value] of rows) {
    const parent = value['parentId']
    if (typeof parent === 'string' && parent !== '')
      children.set(parent, [...(children.get(parent) ?? []), id])
    const { repoId, seq } = value
    if (typeof repoId === 'string' && typeof seq === 'number') {
      const key = `${repoId}:${seq}`
      const held = references.get(key)
      if (held === undefined || id < held) references.set(key, id)
    }
  }
  return { stubs, children, references }
}

function newAnswers(
  table: StubTable,
  ids: readonly string[],
  parents: readonly string[],
  refs: readonly [string, number][],
) {
  return {
    stubs: new Map(
      ids.flatMap((id) => {
        const stub = table.stubOf(id)
        return stub === undefined ? [] : [[id, stub] as const]
      }),
    ),
    children: new Map(
      parents.flatMap((parent) => {
        const list = [...table.childrenOf(parent)]
        return list.length === 0 ? [] : [[parent, list] as const]
      }),
    ),
    references: new Map(
      refs.flatMap(([repo, seq]) => {
        const id = table.idAt(repo, seq)
        return id === undefined ? [] : [[`${repo}:${seq}`, id] as const]
      }),
    ),
    rows: new Map(table.rows().map((row) => [row.id, row.stub])),
  }
}

/** A deterministic sequence of writes and removals over a few repos, parents and numbers. */
function sequence(steps: number, seed: number) {
  let state = seed
  const next = (n: number) => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % n
  }
  const out: ({ kind: 'put'; id: string; value: Row } | { kind: 'remove'; id: string })[] = []
  for (let step = 0; step < steps; step++) {
    const id = `i${next(40)}`
    if (next(5) === 0) out.push({ kind: 'remove', id })
    else
      out.push({
        kind: 'put',
        id,
        value: {
          id,
          repoId: `r${next(3)}`,
          seq: next(20),
          stage: ['backlog', 'in_progress', 'done'][next(3)],
          closedReason: next(2) ? null : 'done',
          archived: next(4) === 0,
          deletedAt: next(6) === 0 ? '2026-01-01T00:00:00Z' : null,
          isDraftVessel: false,
          audience: next(2) ? 'human' : 'agent',
          parentId: next(3) === 0 ? null : `i${next(40)}`,
          title: `title ${step}`,
          priority: next(4),
        },
      })
  }
  return out
}

function compare(table: StubTable, rows: ReadonlyMap<string, Row>) {
  const ids = Array.from({ length: 40 }, (_, n) => `i${n}`)
  const refs = Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 20 }, (_, s) => [`r${r}`, s] as [string, number]),
  ).flat()
  const before = oldAnswers(rows)
  const after = newAnswers(table, ids, ids, refs)
  const sortedChildren = (map: Map<string, readonly string[]>) =>
    new Map([...map].map(([k, v]) => [k, [...v].sort()]))
  expect(after.stubs).toEqual(before.stubs)
  expect(after.rows).toEqual(before.stubs)
  expect(sortedChildren(after.children)).toEqual(sortedChildren(before.children))
  expect(after.references).toEqual(before.references)
}

describe('the stub table equals the old rebuild over every row (POD-7094)', () => {
  it('declares the issue stub', () => {
    expect(FIELDS).toEqual(expect.arrayContaining(['id', 'repoId', 'seq', 'stage', 'parentId']))
  })

  for (const seed of [1, 7, 4443])
    it(`after every step of a write sequence (seed ${seed})`, () => {
      const table = new StubTable(FIELDS, 'parentId')
      const rows = new Map<string, Row>()
      for (const step of sequence(400, seed)) {
        if (step.kind === 'put') {
          rows.set(step.id, step.value)
          table.put(step.id, step.value)
        } else {
          rows.delete(step.id)
          table.remove(step.id)
        }
        compare(table, rows)
      }
    })

  it('keeps one rows array until a stub field changes', () => {
    const table = new StubTable(FIELDS, 'parentId')
    table.put('a', { id: 'a', repoId: 'r', seq: 1, stage: 'backlog', title: 'one' })
    const rows = table.rows()
    table.put('a', { id: 'a', repoId: 'r', seq: 1, stage: 'backlog', title: 'renamed' })
    expect(table.rows()).toBe(rows)
    table.put('a', { id: 'a', repoId: 'r', seq: 1, stage: 'done', title: 'renamed' })
    expect(table.rows()).not.toBe(rows)
  })

  it('fails the comparison when the new answer is wrong (a planted fault)', () => {
    const table = new StubTable(FIELDS, 'parentId')
    const rows = new Map<string, Row>()
    for (const step of sequence(200, 7)) {
      if (step.kind === 'put') {
        rows.set(step.id, step.value)
        table.put(step.id, step.value)
      }
    }
    // Planted: a removal the table never hears of.
    const [gone] = [...rows.keys()]
    rows.delete(gone!)
    expect(() => compare(table, rows)).toThrow()
    // Planted: a parent move the table never hears of.
    table.remove(gone!)
    compare(table, rows)
    const [moved, value] = [...rows].find(([, row]) => typeof row['parentId'] === 'string')!
    rows.set(moved, { ...value, parentId: null })
    expect(() => compare(table, rows)).toThrow()
  })
})
