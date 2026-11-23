import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  inventoryErrors,
  productionSideState,
  productionUntrackedReads,
  scanSideStateConstructors,
  scanUntrackedReads,
  sideStateErrors,
} from './check-untracked-reads'

it('clock.ts lists every production untracked and peek tag with a reason', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const reads = productionUntrackedReads(root)
  expect(reads.length).toBeGreaterThan(20)
  expect(inventoryErrors(reads)).toEqual([])
})

it('rejects bare reads, including aliased and namespace MobX imports', () => {
  const reads = scanUntrackedReads('example.ts', `
import { untracked as snapshot } from 'mobx'
import * as mobx from 'mobx'
untracked(read)
snapshot(read)
mobx.untracked(read)
pool.row('issue', id, 'peek')
`)
  expect(reads).toHaveLength(4)
  expect(inventoryErrors(reads, {})).toHaveLength(4)
})

it('accepts one tag for an untracked peek and requires a unique inventoried reason', () => {
  const reads = scanUntrackedReads('example.ts', `
// untracked-read: seed
const row = untracked(() => pool.row('issue', id, 'peek'))
`)
  expect(reads).toHaveLength(1)
  expect(inventoryErrors(reads, { seed: 'Publication maintains this snapshot.' })).toEqual([])
  expect(inventoryErrors(reads, {})).toHaveLength(1)
  expect(inventoryErrors([...reads, ...reads], { seed: 'Publication maintains this snapshot.' })).toHaveLength(1)
  expect(inventoryErrors([], { seed: 'Publication maintains this snapshot.' })).toHaveLength(1)
  expect(inventoryErrors(reads, { seed: 'Two\nlines' })).toHaveLength(1)
})

it('ignores comments, strings and type-level peek declarations', () => {
  expect(scanUntrackedReads('example.ts', `
// untracked(read)
const text = "untracked(read)"
type AbsentRead = 'peek'
function row(entity: string, id: string, absent: 'peek'): object | undefined
`)).toEqual([])
})

it('does not allow a distant tag to license a new read', () => {
  const reads = scanUntrackedReads('example.ts', `
// untracked-read: seed
const other = 1
untracked(read)
`)
  expect(reads[0]?.tag).toBeUndefined()
})

it('counts independent reads on one line and shares a multiline nested peek with its escape', () => {
  const reads = scanUntrackedReads('example.ts', `
// untracked-read: first
untracked(read); untracked(other)
// untracked-read: nested
untracked(() =>
  pool.row('issue', id, 'peek'))
`)
  expect(reads).toHaveLength(3)
  expect(inventoryErrors(reads, { first: 'First reason.', nested: 'Nested reason.' }))
    .toEqual([expect.stringContaining('duplicate call-site tag first')])
})

it('finds tags on chained peek reads at the method call', () => {
  const reads = scanUntrackedReads('example.ts', `
const rows = pool.queries.indexed(question)
  // untracked-read: spawn-sort-peek
  .map(id => pool.row('issue', id, 'peek'))
`)
  expect(reads).toEqual([{ file: 'example.ts', line: 4, tag: 'spawn-sort-peek' }])
})

it('every held Map/Set in the client graph and the replica is guarded or carries a reviewed allow', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  expect(sideStateErrors(productionSideState(root))).toEqual([])
})

it('finds held collections: class fields, constructor fields, module values and their callbacks', () => {
  const found = scanSideStateConstructors(
    'example.ts',
    `
const table = new Map<string, number>()
export const bySet = { a: new Set<string>() }
const built = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]))
class Owner {
  private readonly seen = new Set<string>()
  private readonly guarded = new SideMap<string, number>('owner.guarded')
  private later: Map<string, number>
  constructor() {
    this.later = new Map()
    const local = new Map()
  }
  read() { const scratch = new Set(); return scratch }
  private readonly factory = () => { const inner = new Map(); return inner }
}
function make() { return new Map() }
`,
  )
  expect(found.map((entry) => [entry.line, entry.collection])).toEqual([
    [2, 'Map'],
    [3, 'Set'],
    [4, 'Map'],
    [6, 'Set'],
    [10, 'Map'],
  ])
  expect(sideStateErrors(found)).toHaveLength(5)
})

it('accepts an allow comment above the declaration or the constructor, with a known category', () => {
  const found = scanSideStateConstructors(
    'example.ts',
    `
// side-state: declaration: fixed kind table
const KINDS = new Set(['a'])
const pair = {
  // side-state: signal: the atoms readers observe
  atoms: new Map(),
  // side-state: whatever: no such category
  other: new Map(),
}
// side-state: identity:
const empty = new Map()
`,
  )
  expect(found.map((entry) => entry.allow?.category)).toEqual([
    'declaration',
    'signal',
    'whatever',
    undefined,
  ])
  expect(sideStateErrors(found)).toEqual([
    expect.stringContaining('unknown side-state category whatever'),
    expect.stringContaining('example.ts:11: a held Map is a SideMap'),
  ])
})

it('tags signalledRead call sites like untracked reads', () => {
  const reads = scanUntrackedReads(
    'example.ts',
    `
import { signalledRead as covered } from '@podium/sync/side-state'
// untracked-read: exit-kind
const exit = covered(() => replica.exitKind(entity, id))
signalledRead(() => map.get(key))
`,
  )
  expect(reads.map((read) => read.tag)).toEqual(['exit-kind', undefined])
})
