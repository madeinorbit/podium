import { types } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createRowOverlay, overlayRow } from './overlay-row'

describe('frozen row overlays', () => {
  it('reuses exactly the same row, overrides and omission identities', () => {
    const row = { title: 'server', stage: 'backlog' }, patch = { title: 'pending' }
    const omit = new Set<PropertyKey>(['stage'])
    const value = overlayRow(row, patch)
    expect(overlayRow(row, patch)).toBe(value)
    expect(overlayRow(row, patch, omit)).toBe(overlayRow(row, patch, omit))
    expect(overlayRow(row, patch, omit)).not.toBe(value)
    expect(overlayRow({ ...row }, patch)).not.toBe(value)
    expect(overlayRow(row, { ...patch })).not.toBe(value)
  })

  it('does not return a stale value after either borrowed input changes', () => {
    const row = { title: 'server', stage: 'backlog' }, patch = { title: 'first' }
    const first = overlayRow(row, patch)
    const changedPatch = overlayRow(row, { title: 'second', stage: 'review' })
    const changedRow = overlayRow({ ...row, stage: 'done' }, patch)
    expect(changedPatch).toEqual({ title: 'second', stage: 'review' })
    expect(changedRow).toEqual({ title: 'first', stage: 'done' })
    expect(first).toEqual({ title: 'first', stage: 'backlog' })
  })

  it('keeps native read-only semantics without a Proxy or accessor reads', () => {
    const value = overlayRow({ id: 'row', title: 'server' }, { title: 'pending' })
    expect(types.isProxy(value)).toBe(false)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(value, 'title')).toEqual({
      value: 'pending', writable: false, configurable: false, enumerable: true,
    })
    expect(() => { value.title = 'bad' }).toThrow(TypeError)
    expect(() => { delete (value as Partial<typeof value>).title }).toThrow(TypeError)
    expect(() => Object.setPrototypeOf(value, { bad: true })).toThrow(TypeError)
    expect(Reflect.set(value, 'title', 'bad')).toBe(false)
    expect(Reflect.deleteProperty(value, 'title')).toBe(false)
    expect(Reflect.defineProperty(value, 'extra', { value: 'bad' })).toBe(false)
    expect(value.title).toBe('pending')
  })

  it('preserves own-key order, symbols, non-enumerable cells and omissions', () => {
    const symbol = Symbol('joined'), row = { id: 'row', sessionFacts: { private: true }, title: 'server' as string | undefined }
    Object.defineProperty(row, 'hidden', { value: 4 })
    const patch = { title: undefined, added: null, [symbol]: 'joined' }
    const value = overlayRow(row, patch, new Set<PropertyKey>(['sessionFacts']))
    expect(Reflect.ownKeys(value)).toEqual(['id', 'title', 'hidden', 'added', symbol])
    expect(Object.keys(value)).toEqual(['id', 'title', 'hidden', 'added'])
    expect('sessionFacts' in value).toBe(false)
    expect(value.sessionFacts).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(value, 'sessionFacts')).toBeUndefined()
    expect({ ...value }).toEqual({ id: 'row', title: undefined, hidden: 4, added: null, [symbol]: 'joined' })
    expect(JSON.stringify(value)).toBe('{"id":"row","hidden":4,"added":null}')
  })

  it('preserves prototypes without invoking inherited setters during the merge', () => {
    let setterCalls = 0
    const prototype = { inherited: 'base', set title(_value: string) { setterCalls++ } }
    const row = Object.create(prototype) as { id: string; title: string; inherited: string }
    row.id = 'row'
    const value = overlayRow(row, { title: 'pending', ['__proto__']: 'cell' })
    expect(Object.getPrototypeOf(value)).toBe(prototype)
    expect(value.inherited).toBe('base')
    expect(value.title).toBe('pending')
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toBe('cell')
    expect(setterCalls).toBe(0)
    const nullRow = Object.assign(Object.create(null), { id: 'null' })
    expect(Object.getPrototypeOf(overlayRow(nullRow, {}))).toBeNull()
  })

  it('reads input cells once at construction and never on subsequent field reads', () => {
    let reads = 0
    const row = { get title() { reads++; return 'server' }, id: 'row' }, patch = { stage: 'review' }
    const value = overlayRow(row, patch)
    expect(reads).toBe(1)
    for (let click = 0; click < 100; click++) {
      expect(value.title).toBe('server')
      expect(value.stage).toBe('review')
      expect(overlayRow(row, patch)).toBe(value)
    }
    expect(reads).toBe(1)
  })
})


describe('addressed overlay values', () => {
  it('reuses fresh equivalent overrides but changes with a field or borrowed row', () => {
    const join = createRowOverlay(), row = { id: 'a', title: 'server' }
    const first = join(row, { title: 'pending' })
    expect(join(row, { title: 'pending' })).toBe(first)
    expect(join(row, { title: 'different' })).not.toBe(first)
    expect(join({ ...row }, { title: 'pending' })).not.toBe(first)
  })
  it('snapshots override fields and keeps omission policies distinct', () => {
    const join = createRowOverlay(), row = { id: 'a', title: 'server' }, patch = { title: 'first' }
    const first = join(row, patch)
    patch.title = 'second'
    const next = join(row, patch)
    expect(first.title).toBe('first')
    expect(next.title).toBe('second')
    expect(next).not.toBe(first)
    const omit = new Set<PropertyKey>(['id'])
    expect(join(row, { title: 'second' }, omit)).not.toBe(next)
    expect(join(row, { title: 'second' }, omit)).toBe(join(row, { title: 'second' }, omit))
  })
})
