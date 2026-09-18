import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@podium/model'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { createEffectiveChanges, type EffectiveAddress, type EffectiveLocalState, type EffectivePublication, type EffectiveReadView } from './effective-changes'
import { foldOverlays } from './overlay'

const address: EffectiveAddress = { kind: 'sessions', id: 's' }
const row = (name: string) => ({ sessionId: 's', name }) as SessionMeta
function view(sessions: SessionMeta[], local: Partial<EffectiveLocalState> = {}): EffectiveReadView {
  const commit = { sessions, ...local }
  return {
    commit,
    row: <K extends ReplicaKind>(kind: K, id: string) =>
      (kind === 'sessions' ? sessions.find((s) => s.sessionId === id) : undefined) as ReplicaRows[K] | undefined,
    ids: (kind) => kind === 'sessions' ? sessions.map((s) => s.sessionId) : [],
    local: (key) => local[key] as EffectiveLocalState[typeof key],
  }
}
function setup() {
  const source = createEffectiveChanges(view([row('old')]))
  const events: EffectivePublication[] = []
  source.subscribe((event) => events.push(event))
  return { source, events }
}

describe('effective-state change contract (unwired reference publisher)', () => {
  it('seeds atomically and publishes normal addressed updates with existing identity', () => {
    const { source, events } = setup()
    const next = view([row('new')])
    source.publish({ type: 'update', view: next, rows: [address], local: [] })
    expect(events.map((e) => e.type)).toEqual(['replace', 'update'])
    expect(events[1]!.view.commit).toBe(next.commit)
    expect(events[1]!.view.row('sessions', 's')?.name).toBe('new')
    expect(events[1]).toMatchObject({ rows: [{ ...address, presence: 'present' }] })
  })

  it('collapses multiple operations on one id to its final batch value', () => {
    const { source, events } = setup()
    // The owner completes update/delete/reinsert before publishing its batch.
    source.publish({ type: 'update', view: view([row('reinserted')]), rows: [address, address, address, { kind: 'issues', id: 's' }], local: [] })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ rows: [{ ...address, presence: 'present' }, { kind: 'issues', id: 's', presence: 'absent' }] })
    expect(events[1]!.view.row('sessions', 's')?.name).toBe('reinserted')
  })

  it('rejects a raw-base reader and accepts an overlay-only effective change', () => {
    const base = [row('server')]
    const painted = foldOverlays(base, [{ op: 'patch', entity: 'sessions', id: 's', key: 'mutation', patch: { name: 'pressed' }, coveredBy: () => false }], (s) => s.sessionId).rows
    const assertPainted = (v: EffectiveReadView) => expect(v.row('sessions', 's')?.name).toBe('pressed')
    expect(() => assertPainted(view(base))).toThrow()
    const { source, events } = setup()
    source.publish({ type: 'update', view: view(painted), rows: [address], local: [] })
    assertPainted(events[1]!.view)
    source.publish({ type: 'update', view: view(base), rows: [address], local: [] })
    expect(events[2]!.view.row('sessions', 's')?.name).toBe('server')
    expect(base[0]!.name).toBe('server')
  })

  it('invalidates absence and same-object same-id readmission', () => {
    const original = row('same')
    const source = createEffectiveChanges(view([original]))
    const presence: string[] = []
    source.subscribe((e) => { if (e.type === 'update') presence.push(e.rows[0]!.presence) })
    source.publish({ type: 'update', view: view([]), rows: [address], local: [] })
    source.publish({ type: 'update', view: view([original]), rows: [address], local: [] })
    expect(presence).toEqual(['absent', 'present'])
  })

  it('replaces the whole scope once, including empty kinds and local selection', () => {
    const { source, events } = setup()
    const next = view([], { drafts: { s: 'draft' }, selectedIssueId: null })
    source.publish({ type: 'replace', reason: 'rescope', view: next })
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ type: 'replace', reason: 'rescope', view: next })
    expect(events[1]!.view.ids('sessions')).toEqual([])
    expect(events[1]!.view.row('sessions', 's')).toBeUndefined()
    expect(events[1]!.view.local('drafts')).toEqual({ s: 'draft' })
    source.publish({ type: 'replace', reason: 'bootstrap', view: next })
    expect(events).toHaveLength(3)
  })

  it('deduplicates local invalidations without inventing row changes', () => {
    const { source, events } = setup()
    source.publish({ type: 'update', view: view([], { drafts: { s: 'text' }, selectedIssueId: null }), rows: [], local: ['drafts', 'selectedIssueId', 'drafts'] })
    expect(events[1]).toMatchObject({ rows: [], local: ['drafts', 'selectedIssueId'] })
  })

  it('delivers a write during seed without a subscription gap', () => {
    const source = createEffectiveChanges(view([]))
    const types: string[] = []
    source.subscribe((e) => {
      types.push(e.type)
      if (e.type === 'replace') source.publish({ type: 'update', view: view([row('seed-write')]), rows: [address], local: [] })
    })
    expect(types).toEqual(['replace', 'update'])
  })

  it('queues nested commits, pins reads, and seeds late listeners at the latest accepted commit', () => {
    const source = createEffectiveChanges(view([]))
    const seen: string[] = []
    source.subscribe((e) => {
      if (e.type !== 'update') return
      const name = e.view.row('sessions', 's')!.name!
      seen.push(`a:${name}`)
      if (name === 'one') {
        source.publish({ type: 'update', view: view([row('two')]), rows: [address], local: [] })
        source.subscribe((late) => seen.push(`late:${late.type}:${late.view.row('sessions', 's')!.name}`))
      }
    })
    source.subscribe((e) => { if (e.type === 'update') seen.push(`b:${e.view.row('sessions', 's')!.name}`) })
    source.publish({ type: 'update', view: view([row('one')]), rows: [address], local: [] })
    expect(seen).toEqual(['a:one', 'late:replace:two', 'b:one', 'a:two', 'b:two'])
  })

  it('unsubscribes before queued delivery and isolates listener errors', () => {
    const source = createEffectiveChanges(view([]))
    let calls = 0
    let off = () => {}
    source.subscribe((e) => { if (e.type === 'update') { off(); throw new Error('listener') } })
    off = source.subscribe((e) => { if (e.type === 'update') calls++ })
    source.subscribe((e) => { if (e.type === 'update') calls++ })
    expect(() => source.publish({ type: 'update', view: view([]), rows: [], local: [] })).toThrow(AggregateError)
    expect(calls).toBe(1)
    off(); off()
  })

  it('destroy discards queued commits and poisons late writers/subscribers', () => {
    const source = createEffectiveChanges(view([]))
    let calls = 0
    source.subscribe((e) => {
      if (e.type !== 'update') return
      source.publish({ type: 'update', view: view([]), rows: [], local: [] })
      source.destroy()
    })
    source.subscribe((e) => { if (e.type === 'update') calls++ })
    source.publish({ type: 'update', view: view([]), rows: [], local: [] })
    source.destroy()
    source.publish({ type: 'replace', reason: 'rescope', view: view([]) })
    source.subscribe(() => calls++)()
    expect(calls).toBe(0)
  })
})
