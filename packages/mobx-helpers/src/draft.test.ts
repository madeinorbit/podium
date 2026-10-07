import { autorun, configure, observable, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { draft } from './draft'

interface Row { title: string; stage: string; owner: string }

/** Shaped like our models: a plain class over an observable row, fields as
 * prototype getters, never a MobX observable object itself. */
class Item {
  constructor(readonly row: Row) {}
  get title() { return this.row.title }
  get stage() { return this.row.stage }
  get owner() { return this.row.owner }
}

function fixture() {
  const row = observable<Row>({ title: 'Fix login', stage: 'backlog', owner: 'ann' })
  const source = new Item(row)
  const save = vi.fn((_changes: object) => 'tx-1')
  const d = draft(source, { fields: ['title', 'stage'], save })
  const change = (patch: Partial<Row>) => runInAction(() => Object.assign(row, patch))
  return { row, source, save, d, change }
}

afterEach(() => configure({ enforceActions: 'never' }))

describe('draft', () => {
  it('reads the live source for an untouched field and the local value for an edited one', () => {
    const { d, change } = fixture()
    expect([d.title, d.stage]).toEqual(['Fix login', 'backlog'])
    d.title = 'Fix login page'
    change({ title: 'Fix the login', stage: 'planning' })
    expect(d.title).toBe('Fix login page')
    expect(d.stage).toBe('planning')
  })

  it('reports dirty state per field and as a whole', () => {
    const { d } = fixture()
    expect(d.isDirty).toBe(false)
    expect(d.changedValues).toEqual(new Map())
    d.stage = 'review'
    expect(d.isDirty).toBe(true)
    expect(d.isPropertyDirty('stage')).toBe(true)
    expect(d.isPropertyDirty('title')).toBe(false)
    expect(d.changedValues).toEqual(new Map([['stage', 'review']]))
  })

  it('un-dirties a field set back to the source value', () => {
    const { d, change } = fixture()
    d.title = 'Other'
    d.title = 'Fix login'
    expect(d.isDirty).toBe(false)
    d.title = 'Other'
    change({ title: 'Moved' })
    d.title = 'Moved'
    expect(d.isPropertyDirty('title')).toBe(false)
    expect(d.title).toBe('Moved')
  })

  it('resets one field or all of them back to the live source', () => {
    const { d, change } = fixture()
    d.title = 'A'
    d.stage = 'review'
    d.resetProperty('title')
    change({ title: 'Live' })
    expect([d.title, d.stage, d.isDirty]).toEqual(['Live', 'review', true])
    d.reset()
    expect([d.title, d.stage, d.isDirty]).toEqual(['Live', 'backlog', false])
  })

  it('submits exactly the changes in one save call, then clears them', () => {
    const { d, save, source } = fixture()
    d.title = 'Fix login page'
    d.stage = 'review'
    expect(d.submit()).toBe('tx-1')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ title: 'Fix login page', stage: 'review' })
    expect(d.isDirty).toBe(false)
    expect(d.title).toBe(source.title)
  })

  it('saves nothing when clean, and keeps the edits when the save throws', () => {
    const { d, save } = fixture()
    expect(d.submit()).toBeUndefined()
    expect(save).not.toHaveBeenCalled()
    save.mockImplementationOnce(() => { throw new Error('refused') })
    d.title = 'Bad'
    expect(() => d.submit()).toThrow('refused')
    expect(d.changedValues).toEqual(new Map([['title', 'Bad']]))
  })

  it('exposes the source as model and refuses a field named like a draft member', () => {
    const { d, source } = fixture()
    expect(d.model).toBe(source)
    expect(() => draft({ isDirty: 1 }, { fields: ['isDirty'], save: () => {} })).toThrow(TypeError)
  })

  it('works over a plain object and leaves an edited value unconverted', () => {
    const source = { labels: ['a'], name: 'x' }
    const d = draft(source, { fields: ['labels', 'name'], save: () => {} })
    const labels = ['a', 'b']
    d.labels = labels
    expect(d.labels).toBe(labels)
    source.name = 'y'
    expect(d.name).toBe('y')
  })

  it('writes in actions, so strict enforceActions accepts a plain assignment', () => {
    configure({ enforceActions: 'always' })
    const { d } = fixture()
    const seen: string[] = []
    const stop = autorun(() => seen.push(d.title))
    try {
      d.title = 'Edited'
      d.resetProperty('title')
      d.title = 'Again'
      d.submit()
      d.reset()
      expect(seen).toEqual(['Fix login', 'Edited', 'Fix login', 'Again', 'Fix login'])
    } finally { stop() }
  })

  it('wakes an observer on the draft fields it reads, not on source fields it does not', () => {
    const { d, change } = fixture()
    const runs: string[] = []
    const stop = autorun(() => runs.push(d.title))
    try {
      change({ stage: 'planning', owner: 'bob' })
      d.stage = 'review'
      expect(runs).toEqual(['Fix login'])
      d.title = 'Edited'
      change({ title: 'Live' })
      expect(runs).toEqual(['Fix login', 'Edited'])
      d.resetProperty('title')
      expect(runs).toEqual(['Fix login', 'Edited', 'Live'])
    } finally { stop() }
  })

  it('wakes a dirty indicator on edits and resets only', () => {
    const { d, change } = fixture()
    const dirty: boolean[] = []
    const stop = autorun(() => dirty.push(d.isDirty))
    try {
      change({ title: 'Live' })
      d.title = 'Edited'
      d.stage = 'review'
      d.submit()
      expect(dirty).toEqual([false, true, false])
    } finally { stop() }
  })
})
