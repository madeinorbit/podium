import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { inventoryErrors, productionUntrackedReads, scanUntrackedReads } from './check-untracked-reads'

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
