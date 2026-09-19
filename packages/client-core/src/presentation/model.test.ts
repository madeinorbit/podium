import { describe, expect, it, vi } from 'vitest'
import type { IssueWire, SessionMeta } from '@podium/model'
import type { EffectiveChanges, EffectiveLocalState, EffectivePublication, EffectiveReadView } from '../engine/effective-changes'
import { createEffectiveChanges } from '../engine/effective-changes'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { createPresentationModel, FOREGROUND_INPUTS, NAVIGATION_INPUTS } from './model'

const issue = (id: string, title = id) => ({ id, title }) as IssueWire
const session = (id: string, name = id) => ({ sessionId: id, name }) as SessionMeta
function view(issues: IssueWire[] = [], local: Partial<EffectiveLocalState> = {}, sessions: SessionMeta[] = []): EffectiveReadView {
  const state = { view: 'issues', openIssueId: 'a', selectedIssueId: 'b', selectedWorktree: null,
    workspaces: {}, paneA: null, paneB: null, split: false, focusedPane: 'A', dockTab: 'superagent', superOpen: false,
    drafts: {}, ...local } as EffectiveLocalState
  return {
    commit: {},
    ids: kind => kind === 'issues' ? issues.map(r => r.id) : kind === 'sessions' ? sessions.map(r => r.sessionId) : [],
    row: <K extends ReplicaKind>(kind: K, id: string) =>
      (kind === 'issues' ? issues.find(r => r.id === id) : kind === 'sessions' ? sessions.find(r => r.sessionId === id) : undefined) as ReplicaRows[K] | undefined,
    local: key => state[key],
  }
}
const initial = () => view([issue('a'), issue('b')], { drafts: { a: 'old', b: 'untouched' } }, [session('s')])

describe('principal presentation model', () => {
  it('seeds rows, addressed drafts and navigation, sharing cells and immutable row identities', () => {
    const seed = initial()
    const adapter = createPresentationModel(createEffectiveChanges(seed))
    const { model } = adapter
    expect(model.row('issues', 'a')).toBe(model.row('issues', 'a'))
    expect(model.row('issues', 'a').getSnapshot()).toBe(seed.row('issues', 'a'))
    expect(model.draft('a').getSnapshot()).toBe('old')
    for (const key of NAVIGATION_INPUTS) expect(model.navigation(key).getSnapshot()).toBe(seed.local(key))
    expect(model.foregroundIssue().getSnapshot()).toBe(seed.row('issues', 'a'))
    adapter.destroy()
  })

  it('installs the entire update before any row, draft or derived subscriber runs', () => {
    const source = createEffectiveChanges(initial())
    const adapter = createPresentationModel(source)
    const { model } = adapter
    const next = view([issue('a', 'new'), issue('b')], { drafts: { a: 'new' }, view: 'workspace' })
    let calls = 0
    const readAll = () => {
      calls++
      expect(model.row('issues', 'a').getSnapshot()?.title).toBe('new')
      expect(model.draft('a').getSnapshot()).toBe('new')
      expect(model.draft('b').getSnapshot()).toBeUndefined()
      expect(model.navigation('view').getSnapshot()).toBe('workspace')
      expect(model.foregroundIssue().getSnapshot()?.id).toBe('b')
    }
    model.row('issues', 'a').subscribe(readAll)
    model.draft('a').subscribe(readAll)
    model.foregroundIssue().subscribe(readAll)
    source.publish({ type: 'update', view: next, rows: [{ kind: 'issues', id: 'a' }], local: ['drafts', 'view'] })
    expect(calls).toBe(3)
    adapter.destroy()
  })

  it('replaces empty collections and removes drafts on explicit rescope, then readmits the same row', () => {
    const seed = initial()
    const source = createEffectiveChanges(seed)
    const { model, destroy } = createPresentationModel(source)
    const foreground = model.foregroundIssue()
    expect(foreground.getSnapshot()).toBe(seed.row('issues', 'a'))
    source.publish({ type: 'replace', reason: 'rescope', view: view() })
    expect(foreground.getSnapshot()).toBeUndefined()
    expect(model.row('sessions', 's').getSnapshot()).toBeUndefined()
    expect(model.draft('a').getSnapshot()).toBeUndefined()
    source.publish({ type: 'replace', reason: 'bootstrap', view: seed })
    expect(foreground.getSnapshot()).toBe(seed.row('issues', 'a'))
    destroy()
  })

  it.each(['throwing reader', 'mismatched row', 'presence', 'duplicate', 'invalid draft', 'invalid navigation'])('rejects %s before mutating any value or notifying', fault => {
    let notify!: (p: EffectivePublication) => void
    const adapter = createPresentationModel({ subscribe(fn) { notify = fn; fn({ type: 'replace', reason: 'seed', view: initial() }); return () => {} } })
    const cell = adapter.model.row('issues', 'a')
    const old = cell.getSnapshot()
    const subscriber = vi.fn()
    cell.subscribe(subscriber)
    const next = view([issue('a', 'new'), issue('b')], { drafts: { a: 3 } as unknown as Record<string, string>, view: 'invalid' as never })
    let reads = 0
    const original = next.row
    const broken = { ...next, row: (<K extends ReplicaKind>(kind: K, id: string) => {
      reads++
      if (reads === 2 && fault === 'throwing reader') throw new Error('read failed')
      if (reads === 2 && fault === 'mismatched row') return issue('wrong') as ReplicaRows[K]
      return original(kind, id)
    }) }
    expect(() => notify({ type: 'update', view: broken,
      rows: [{ kind: 'issues', id: 'a', presence: 'present' }, { kind: 'issues', id: fault === 'duplicate' ? 'a' : 'b', presence: fault === 'presence' ? 'absent' : 'present' }],
      local: fault === 'invalid draft' ? ['drafts'] : fault === 'invalid navigation' ? ['view'] : [],
    })).toThrow()
    expect(cell.getSnapshot()).toBe(old)
    expect(subscriber).not.toHaveBeenCalled()
    adapter.destroy()
  })

  it('stop/start releases and reseeds; old callbacks cannot enter a restarted or successor model', () => {
    let current = initial()
    const callbacks: Array<(p: EffectivePublication) => void> = []
    let live = 0
    const source: EffectiveChanges = { subscribe(fn) {
      live++; callbacks.push(fn); fn({ type: 'replace', reason: 'seed', view: current })
      return () => { live-- }
    } }
    const old = createPresentationModel(source)
    const held = old.model.draft('a')
    expect(live).toBe(1)
    old.stop(); old.stop()
    expect(live).toBe(0)
    current = view([], { drafts: { a: 'restart' } })
    old.start(); old.start()
    expect(live).toBe(1)
    expect(held.getSnapshot()).toBe('restart')
    const late = { type: 'replace', reason: 'rescope', view: initial() } as const
    callbacks[0]!(late)
    expect(held.getSnapshot()).toBe('restart')
    old.destroy(); old.destroy(); old.start()
    expect(live).toBe(0)
    expect(held.getSnapshot()).toBeUndefined()
    const successor = createPresentationModel(source)
    callbacks[1]!(late)
    expect(successor.model.draft('a').getSnapshot()).toBe('restart')
    expect(held.getSnapshot()).toBeUndefined()
    successor.destroy()
    expect(live).toBe(0)
  })

  it('reentrant writes during reseed wait for complete seed installation; stop during seed releases registration', () => {
    const source = createEffectiveChanges(initial())
    const adapter = createPresentationModel(source)
    const observed: string[] = []
    adapter.model.draft('a').subscribe(() => {
      observed.push(adapter.model.draft('a').getSnapshot()!)
      if (observed.length === 1) source.publish({ type: 'replace', reason: 'bootstrap', view: view([], { drafts: { a: 'nested' } }) })
    })
    adapter.stop()
    source.publish({ type: 'replace', reason: 'bootstrap', view: view([], { drafts: { a: 'seed' } }) })
    adapter.start()
    expect(observed).toEqual(['seed', 'nested'])
    adapter.stop()
    adapter.model.draft('a').subscribe(() => adapter.stop())
    source.publish({ type: 'replace', reason: 'bootstrap', view: initial() })
    adapter.start()
    source.publish({ type: 'replace', reason: 'bootstrap', view: view() })
    expect(adapter.model.draft('a').getSnapshot()).toBe('old')
    adapter.destroy()
  })

  it('isolates observer errors and invalidates unmounted lazy cells', () => {
    const source = createEffectiveChanges(initial())
    const adapter = createPresentationModel(source)
    const cell = adapter.model.foregroundIssue()
    cell.getSnapshot()
    const off = cell.subscribe(() => { throw new Error('observer') })
    const observer = vi.fn()
    cell.subscribe(observer)
    expect(() => source.publish({ type: 'replace', reason: 'rescope', view: view() })).toThrow()
    expect(observer).toHaveBeenCalledOnce()
    expect(cell.getSnapshot()).toBeUndefined()
    off(); adapter.destroy()
  })

  it('measures 200 coarse wakes versus one addressed wake, with no collection enumeration per delta', () => {
    const sessions = Array.from({ length: 200 }, (_, i) => session(`s${i}`))
    const source = createEffectiveChanges(view([], {}, sessions))
    const adapter = createPresentationModel(source)
    let coarse = 0, addressed = 0
    for (const row of sessions) {
      source.subscribe(p => { if (p.type === 'update') coarse++ })
      adapter.model.row('sessions', row.sessionId).subscribe(() => addressed++)
    }
    const next = view([], {}, sessions.map((r, i) => i === 42 ? session(r.sessionId, 'new') : r))
    const ids = vi.spyOn(next, 'ids')
    const row = vi.spyOn(next, 'row')
    source.publish({ type: 'update', view: next, rows: [{ kind: 'sessions', id: 's42' }], local: [] })
    expect(coarse).toBe(200)
    expect(addressed).toBe(1)
    expect(ids).not.toHaveBeenCalled()
    expect(row).toHaveBeenCalledTimes(2) // D2 presence check + D5 prepare.
    // A coarse-notification mutant must fail the isolation gate.
    const isolationGate = (count: number) => expect(count).toBe(1)
    expect(() => isolationGate(coarse)).toThrow()
    isolationGate(addressed)
    console.info('[D5 addressed wake oracle]', JSON.stringify({ coarse, addressed, modelCollectionEnumerations: ids.mock.calls.length, contractAndModelRowReads: row.mock.calls.length }))
    adapter.destroy()
  })
})

describe('explicit input mutation oracles', () => {
  const inputs = ['issues', 'view', 'openIssueId', 'selectedIssueId'] as const
  it('keeps the foreground inventory explicit and complete', () => {
    expect(FOREGROUND_INPUTS).toEqual([
      '["collection","issues"]', '["navigation","view"]', '["navigation","openIssueId"]', '["navigation","selectedIssueId"]',
    ])
  })
  it.each(inputs)('kills the missing %s invalidation mutant', input => {
    function oracle(removeInput: boolean) {
      const base = initial()
      const source = createEffectiveChanges(input === 'selectedIssueId' ? view([issue('a'), issue('b')], { view: 'workspace' }) : base)
      const adapter = createPresentationModel(source)
      const inventory = FOREGROUND_INPUTS as unknown as string[]
      const saved = [...inventory]
      try {
        // Mutate the actual dependency registration, NOT the delivered values.
        if (removeInput) inventory.splice(inputs.indexOf(input), 1)
        const cell = adapter.model.foregroundIssue()
        inventory.splice(0, inventory.length, ...saved)
        cell.getSnapshot() // Warm the shared derived cache; a cold read is not an oracle.
        let calls = 0
        cell.subscribe(() => calls++)
        const next = input === 'issues' ? view([issue('b')])
          : input === 'view' ? view([issue('a'), issue('b')], { view: 'workspace' })
          : input === 'openIssueId' ? view([issue('a'), issue('b')], { openIssueId: 'b' as never })
          : view([issue('a'), issue('b')], { view: 'workspace', selectedIssueId: 'a' as never })
        source.publish({ type: 'update', view: next, rows: input === 'issues' ? [{ kind: 'issues', id: 'a' }] : [], local: input === 'issues' ? [] : [input] })
        expect(calls).toBe(1)
        expect(cell.getSnapshot()?.id).toBe(input === 'issues' ? undefined : input === 'selectedIssueId' ? 'a' : 'b')
      } finally { inventory.splice(0, inventory.length, ...saved); adapter.destroy() }
    }
    oracle(false)
    expect(() => oracle(true)).toThrow()
  })
  it.each(['row', 'draft', ...NAVIGATION_INPUTS] as const)('kills missing direct-cell %s input', input => {
    const oracle = (remove: boolean) => {
      const source = createEffectiveChanges(initial())
      const adapter = createPresentationModel(source)
      try {
        const cell = input === 'row' ? adapter.model.row('sessions', 's') : input === 'draft' ? adapter.model.draft('a') : adapter.model.navigation(input)
        cell.getSnapshot()
        let calls = 0
        cell.subscribe(() => calls++)
        // Replacement-shaped fixture values for all navigation types. The
        // invalidation mutation is ONLY omission from the update inventory.
        const values = { view: 'workspace', openIssueId: 'b', selectedIssueId: 'a', selectedWorktree: '/new', workspaces: { changed: {} }, paneA: 's', paneB: 's', split: true, focusedPane: 'B', dockTab: 'files', superOpen: true }
        const next = view([], { ...values, drafts: { a: 'new' } } as unknown as Partial<EffectiveLocalState>, [session('s', 'new')])
        source.publish({ type: 'update', view: next, rows: !remove && input === 'row' ? [{ kind: 'sessions', id: 's' }] : [], local: remove || input === 'row' ? [] : [input === 'draft' ? 'drafts' : input] })
        expect(calls).toBe(1)
        expect(cell.getSnapshot()).toEqual(input === 'row' ? next.row('sessions', 's') : input === 'draft' ? 'new' : next.local(input))
      } finally { adapter.destroy() }
    }
    oracle(false)
    expect(() => oracle(true)).toThrow()
  })
})
