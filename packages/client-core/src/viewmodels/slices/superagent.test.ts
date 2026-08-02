import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createSlicePublisher } from './publish'
import { superagentSlice, threadById, type SuperThreadView } from './superagent'

// ---------------------------------------------------------------------------
// POD-330 audit item zero — the superagent view's shadow mirror is gone.
//
// What was deleted, and what these tests hold in place:
//   - a view-local `SuperThread` interface (a second declaration of a shape the
//     client already had);
//   - a view-local `useState` copy of the list, fetched by the view itself;
//   - a `superRefreshKey` COUNTER that actions bumped from across the app to
//     make the view refetch.
//
// The counter is the interesting one. It is a hand-written subscription that
// cannot say WHAT changed, so every bump refetched everything and a bump nobody
// remembered to add was a silently stale list. `refreshSuperThreads()` says what
// it does; the store publishes the result.
// ---------------------------------------------------------------------------

function thread(id: string, over: Partial<SuperThreadView> = {}): SuperThreadView {
  return { id, kind: 'global', ...over }
}

const source = (threads: SuperThreadView[], superThreadId = 'global') => ({
  superThreads: threads,
  superThreadId,
})

describe('superagentSlice', () => {
  it('publishes the threads and resolves the active one', () => {
    const global = thread('global', { podiumSessionId: asSessionId('sess-1') })
    const btw = thread('btw_x', { kind: 'btw' })
    let snapshot = source([global, btw])
    const pub = createSlicePublisher(() => snapshot)
    const value = pub.read(superagentSlice)
    expect(value.threads).toEqual([global, btw])
    expect(value.active).toBe(global)
    expect(value.activeSessionId).toBe('sess-1')
  })

  it('an active thread that has not arrived is UNDEFINED, not an error and not a deletion', () => {
    // The user just opened a btw thread; the list has not caught up. The view
    // renders its empty composer — it does not report a missing thread, and
    // nothing here fabricates a stand-in row.
    let snapshot = source([thread('global')], 'btw_not-yet')
    const pub = createSlicePublisher(() => snapshot)
    const value = pub.read(superagentSlice)
    expect(value.active).toBeUndefined()
    expect(value.activeSessionId).toBeUndefined()
    expect(value.threads).toHaveLength(1)
  })

  it('is derived once per store change, not once per reader', () => {
    let snapshot = source([thread('global')])
    const pub = createSlicePublisher(() => snapshot)
    pub.read(superagentSlice)
    pub.read(superagentSlice)
    pub.read(superagentSlice)
    expect(pub.derivations().superagent).toBe(1)
    snapshot = source([thread('global'), thread('btw_y', { kind: 'btw' })])
    expect(pub.read(superagentSlice).threads).toHaveLength(2)
    expect(pub.derivations().superagent).toBe(2)
  })

  it('keeps its value identity when the thread list did not change', () => {
    const list = [thread('global')]
    let snapshot = source(list)
    const pub = createSlicePublisher(() => snapshot)
    const first = pub.read(superagentSlice)
    // A new store snapshot for an unrelated reason: same list, same active
    // thread, so readers must not re-render.
    snapshot = source(list)
    expect(pub.read(superagentSlice)).toBe(first)
  })

  it('changes value when the user SWITCHES thread, even though the list did not move', () => {
    // Same list object, different active id. A value guard that compared only
    // the list would keep the old value here and leave the column rendering the
    // previous conversation.
    const list = [thread('global'), thread('btw_z', { kind: 'btw' })]
    let snapshot = source(list, 'global')
    const pub = createSlicePublisher(() => snapshot)
    const first = pub.read(superagentSlice)
    expect(first.active?.id).toBe('global')
    snapshot = source(list, 'btw_z')
    const second = pub.read(superagentSlice)
    expect(second).not.toBe(first)
    expect(second.active?.id).toBe('btw_z')
  })

  it('threadById takes the LIST, so it cannot reach a thread the user was not sent', () => {
    // Superagent state is per-user and private (doc §3.1.6 S2). The defence is
    // structural: there is no lookup here that takes a bare id and goes looking,
    // so there is nothing to point at another user's thread.
    const mine = [thread('global'), thread('btw_mine', { kind: 'btw' })]
    expect(threadById(mine, 'btw_mine')?.id).toBe('btw_mine')
    expect(threadById(mine, 'btw_someone-elses')).toBeUndefined()
  })
})
