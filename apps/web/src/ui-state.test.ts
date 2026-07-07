import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReplica, type ReplicaInit } from './replica'

// ---------------------------------------------------------------------------
// ONE UI persistence mechanism (issue #15 Phase 4): the replica's versioned
// ui-state collection replaces the ad-hoc localStorage keys. Old keys migrate
// in exactly once (then are removed); reads/writes are synchronous kv.
// ---------------------------------------------------------------------------

function makeStorage(seed: Record<string, string> = {}): {
  storage: NonNullable<ReplicaInit['storage']>
  data: Map<string, string>
} {
  const data = new Map<string, string>(Object.entries(seed))
  return {
    data,
    storage: {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    },
  }
}

let prefixSeq = 0
let prefix = ''
beforeEach(() => {
  prefix = `test.uistate.${++prefixSeq}`
})

describe('replica ui-state collection', () => {
  it('migrates the old ad-hoc localStorage keys once and removes them', () => {
    const { storage, data } = makeStorage({
      'podium.view': 'issues',
      'podium.paneA': 's1',
      'podium.panelMode': '{"s1":"chat"}',
      'podium:sidebar:collapsed:working': 'false',
      'podium:sidebar:width': '320',
      'unrelated.key': 'stays',
    })
    const ui = createReplica({
      storage,
      keyPrefix: prefix,
      enumerateKeys: () => [...data.keys()],
    }).uiState()

    // Every known key (exact + prefix-matched) is readable from the collection…
    expect(ui.get('podium.view')).toBe('issues')
    expect(ui.get('podium.paneA')).toBe('s1')
    expect(ui.get('podium.panelMode')).toBe('{"s1":"chat"}')
    expect(ui.get('podium:sidebar:collapsed:working')).toBe('false')
    expect(ui.get('podium:sidebar:width')).toBe('320')

    // …the old keys are gone, and unrelated keys are untouched.
    expect(data.has('podium.view')).toBe(false)
    expect(data.has('podium.paneA')).toBe(false)
    expect(data.has('podium:sidebar:collapsed:working')).toBe(false)
    expect(data.has('podium:sidebar:width')).toBe(false)
    expect(data.get('unrelated.key')).toBe('stays')

    // The one versioned collection blob holds the state now.
    expect(data.has(`${prefix}.uistate.v1`)).toBe(true)
  })

  it('kv semantics: set/get/delete round-trip and persist across instances', async () => {
    const { storage, data } = makeStorage()
    const a = createReplica({ storage, keyPrefix: prefix, enumerateKeys: () => [] }).uiState()
    expect(a.get('podium.view')).toBeNull()
    a.set('podium.view', 'workspace')
    a.set('podium.split', '1')
    expect(a.get('podium.view')).toBe('workspace')
    await new Promise((r) => setTimeout(r, 0))

    const b = createReplica({
      storage,
      keyPrefix: prefix,
      enumerateKeys: () => [...data.keys()],
    }).uiState()
    expect(b.get('podium.view')).toBe('workspace')
    expect(b.get('podium.split')).toBe('1')

    b.set('podium.split', null)
    expect(b.get('podium.split')).toBeNull()
  })

  it('a collection row wins over a stale legacy key (migration never clobbers)', async () => {
    const { storage, data } = makeStorage()
    const a = createReplica({ storage, keyPrefix: prefix, enumerateKeys: () => [] }).uiState()
    a.set('podium.view', 'settings')
    await new Promise((r) => setTimeout(r, 0))
    // A stale ad-hoc key reappears (e.g. an old tab wrote it post-migration).
    data.set('podium.view', 'home')
    const b = createReplica({
      storage,
      keyPrefix: prefix,
      enumerateKeys: () => [...data.keys()],
    }).uiState()
    expect(b.get('podium.view')).toBe('settings')
    expect(data.has('podium.view')).toBe(false) // still retired
  })

  it('notifies subscribers on writes', () => {
    const { storage } = makeStorage()
    const ui = createReplica({ storage, keyPrefix: prefix, enumerateKeys: () => [] }).uiState()
    const cb = vi.fn()
    const off = ui.subscribe(cb)
    ui.set('podium.dockTab', 'files')
    expect(cb).toHaveBeenCalled()
    off()
    const calls = cb.mock.calls.length
    ui.set('podium.dockTab', 'git')
    expect(cb.mock.calls.length).toBe(calls)
  })

  it('works in private mode (in-memory) without throwing', () => {
    const ui = createReplica({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota')
        },
        removeItem: () => {},
      },
      keyPrefix: prefix,
    }).uiState()
    ui.set('podium.view', 'usage')
    expect(ui.get('podium.view')).toBe('usage')
  })
})
