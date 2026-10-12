import { describe, expect, it, vi } from 'vitest'
import { draftForReportedModels } from './agent-models'
import { draftForLaunchContext, lastLaunchPick, readLastLaunchPicks, rememberLaunchPick } from './launch-pick'
import { createRoutedUiState, LAST_LAUNCH_PICK_KEY, uiStateRoute } from './ui-state'

const auto = { model: 'auto', effort: 'auto' }
const picks = {
  a: { codex: { model: 'gpt-a', effort: 'high' }, 'claude-code': { model: 'opus-a', effort: 'low' } },
  b: { codex: { model: 'gpt-b', effort: 'low' }, 'claude-code': { model: 'opus-b', effort: 'high' } },
}

describe('remembered launch pair', () => {
  it('routes to the per-user replicated port and reads on another device', () => {
    const rows = new Map<string, unknown>()
    const local = { get: vi.fn(() => null), set: vi.fn(), subscribe: () => () => {} }
    const replicated = { get: (key: string) => rows.get(key),
      set: (key: string, value: unknown) => { rows.set(key, value) },
      clear: (key: string) => { rows.delete(key) }, hydrate: async () => {}, subscribe: () => () => {} }
    const desktop = createRoutedUiState({ local, replicated })
    const phone = createRoutedUiState({ local, replicated })
    expect(uiStateRoute(LAST_LAUNCH_PICK_KEY).home).toBe('per-user-replicated')
    rememberLaunchPick(desktop, { machineId: 'a', harness: 'codex' }, picks.a.codex)
    expect(JSON.parse(rows.get('launch.lastPick') as string)).toEqual({ a: { codex: picks.a.codex } })
    expect(lastLaunchPick(readLastLaunchPicks(phone.get(LAST_LAUNCH_PICK_KEY)),
      { machineId: 'a', harness: 'codex' })).toEqual(picks.a.codex)
    expect(local.set).not.toHaveBeenCalled()
  })

  it('stores all four combinations independently and overwrites a pair with Auto', () => {
    let raw: string | null = null
    const ui = { get: () => raw, set: (_key: string, value: string | null) => { raw = value } }
    for (const [machineId, harnesses] of Object.entries(picks)) {
      for (const [harness, pick] of Object.entries(harnesses)) rememberLaunchPick(ui, { machineId, harness }, pick)
    }
    expect(readLastLaunchPicks(raw)).toEqual(picks)
    rememberLaunchPick(ui, { machineId: 'a', harness: 'codex' }, auto)
    expect(readLastLaunchPicks(raw)).toEqual({ ...picks, a: { ...picks.a, codex: auto } })
  })

  it.each([
    ['a', 'codex', picks.a.codex], ['a', 'claude-code', picks.a['claude-code']],
    ['b', 'codex', picks.b.codex], ['b', 'claude-code', picks.b['claude-code']],
    ['c', 'codex', auto], ['a', 'opencode', auto],
  ])('restores both pills for %s / %s', (machineId, harness, expected) => {
    expect(draftForLaunchContext({ model: 'other', effort: 'max', launchPickTouched: true },
      { machineId: 'old', harness: 'old' }, { machineId, harness }, picks)).toMatchObject(expected)
  })

  it.each([
    { model: 'draft-model', effort: 'high' },
    { model: 'auto', effort: 'high' },
    { ...auto, launchPickTouched: true },
  ])('keeps the saved draft own choice on reload: %j', (draft) => {
    expect(draftForLaunchContext(draft, undefined, { machineId: 'a', harness: 'codex' }, picks)).toEqual(draft)
  })

  it('restores an untouched draft, including when replication arrives after open', () => {
    const context = { machineId: 'a', harness: 'codex' }
    const empty = draftForLaunchContext(auto, undefined, context, {})
    expect(empty).toMatchObject(auto)
    expect(draftForLaunchContext(empty, context, context, picks)).toMatchObject(picks.a.codex)
  })

  it('validates a restored pair after the machine list arrives', () => {
    const restored = draftForLaunchContext(auto, undefined, { machineId: 'a', harness: 'codex' }, picks)
    expect(draftForReportedModels(restored, undefined)).toBeUndefined()
    expect(draftForReportedModels(restored, [{ value: 'new', efforts: ['high'] }])).toMatchObject(auto)
  })

  it('ignores corrupt preferences without losing valid pairs', () => {
    for (const raw of [null, '{', 'null', '[]', '42']) expect(readLastLaunchPicks(raw)).toEqual({})
    expect(readLastLaunchPicks(JSON.stringify({ ...picks, bad: [], c: { codex: { model: null, effort: 'high' } } })))
      .toEqual({ ...picks, c: {} })
  })
})
