import { createSideCache, memoryStorage } from '@podium/client-core/replica'
import { createRoutedUiState, type ReplicatedUiStatePort } from '@podium/client-core/ui-state'
import { MobxPool } from '@podium/client-graph'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { autorun } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { createReplicatedLayoutController } from '../../../../../packages/client-core/src/engine/replicated-layout'
import { ACCOUNT_TIP_IDS, AccountTipLog } from './account-tip-log'

vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null }))
const AT = '2026-10-27T18:00:00.000Z'
const disposers: Array<() => void> = []
afterEach(() => {
  for (const stop of disposers.splice(0)) stop()
})

function account() {
  const data = new Map<string, unknown>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  const replicated: ReplicatedUiStatePort = {
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value)
      for (const listener of listeners) listener(new Set([key]))
    },
    clear: (key) => {
      data.delete(key)
    },
    hydrate: async () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const device = (hydrate = replicated.hydrate, now = () => AT) => {
    const local = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }).uiState()
    const ui = createRoutedUiState({ local, replicated })
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    attachPreferenceSource(pool, ui)
    const log = new AccountTipLog(pool, ui, hydrate, now)
    disposers.push(() => pool.dispose())
    // Keep all seven moments observed, as the guide does, and assert reactive answers.
    const rendered = { ready: false, enabled: false, seen: [] as boolean[] }
    disposers.push(
      autorun(() => {
        rendered.ready = log.ready
        rendered.enabled = log.enabled
        rendered.seen = ACCOUNT_TIP_IDS.map((id) => log.isSeen(id))
      }),
    )
    return { log, rendered, local }
  }
  return { data, device }
}

it('waits for authoritative hydration even when preference rows have cached defaults', async () => {
  const f = account()
  let finish!: () => void
  const d = f.device(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const loading = d.log.load()
  await Promise.resolve()
  expect(d.rendered.ready).toBe(false)
  d.log.record('first-prompt', 'finished')
  d.log.setEnabled(false)
  expect(f.data.size).toBe(0)
  finish()
  await loading
  await vi.waitFor(() => expect(d.rendered.ready).toBe(true))
  expect(d.rendered.seen.every((seen) => !seen)).toBe(true)
})

it('shown does not mark seen; terminal outcomes mark one moment and preserve its original time', async () => {
  const f = account()
  const now = vi.fn(() => AT)
  const d = f.device(undefined, now)
  await d.log.load()
  d.log.record('first-prompt', 'shown')
  expect(f.data.size).toBe(0)
  d.log.record('first-prompt', 'finished')
  d.log.record('first-send', 'dismissed')
  now.mockReturnValue('2026-10-28T18:00:00.000Z')
  d.log.record('first-prompt', 'dismissed')
  expect(Object.fromEntries(f.data)).toEqual({
    'tips.seen.first-prompt': AT,
    'tips.seen.first-send': AT,
  })
  expect(d.log.isSeen('ask-anything')).toBe(false)
})

it('different devices keep independent moments, remote changes repaint, and accounts are isolated', async () => {
  const f = account()
  const a = f.device(),
    b = f.device(),
    other = account().device()
  await Promise.all([a.log.load(), b.log.load(), other.log.load()])
  a.log.record('first-prompt', 'finished')
  b.log.record('first-send', 'dismissed')
  await vi.waitFor(() => expect(a.rendered.seen.slice(0, 2)).toEqual([true, true]))
  await vi.waitFor(() => expect(b.rendered.seen.slice(0, 2)).toEqual([true, true]))
  expect(other.rendered.seen.every((seen) => !seen)).toBe(true)
  a.log.setEnabled(false)
  await vi.waitFor(() => expect(b.rendered.enabled).toBe(false))
  b.log.setEnabled(true)
  await vi.waitFor(() => expect(a.rendered.enabled).toBe(true))
  expect(a.log.isSeen('first-prompt')).toBe(true)
  expect(a.local.get('tips.enabled')).toBeNull()
})

it('skip all logs every moment and disables; re-enabling retains all progress across reloads', async () => {
  const f = account()
  const d = f.device()
  await d.log.load()
  d.log.record('first-prompt', 'skipped-all')
  expect(d.rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
  expect(d.rendered.enabled).toBe(false)
  d.log.setEnabled(true)
  const reload = f.device()
  await reload.log.load()
  expect(reload.rendered.enabled).toBe(true)
  expect(reload.rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
})

it('failed hydration stays unready and can be retried', async () => {
  const hydrate = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(undefined)
  const d = account().device(hydrate)
  await expect(d.log.load()).rejects.toThrow('offline')
  expect(d.rendered.ready).toBe(false)
  await d.log.load()
  expect(d.rendered.ready).toBe(true)
})

it('retires with the account pool even when hydration resolves after teardown', async () => {
  const f = account()
  let finish!: () => void
  const d = f.device(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const loading = d.log.load()
  d.log.dispose()
  finish()
  await loading
  expect(d.rendered.ready).toBe(false)
  d.log.record('first-prompt', 'finished')
  d.log.setEnabled(false)
  expect(f.data.size).toBe(0)
})

it('keeps upgraded-account tips seen when a remote layout snapshot replaces hydrated state', async () => {
  const seeded = Object.fromEntries(ACCOUNT_TIP_IDS.map((id) => [`tips.seen.${id}`, AT]))
  const snapshot = { ...seeded, 'tips.enabled': 'false' }
  type Init = Parameters<typeof createReplicatedLayoutController>[0]
  const replicated = createReplicatedLayoutController({
    api: { layout: { get: { query: async () => snapshot } } } as unknown as Init['api'],
    outbox: { awaiting: () => [], pending: () => [] } as unknown as Init['outbox'],
    notices: { error: () => {}, info: () => {} } as Init['notices'],
  })
  const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
  disposers.push(() => side.dispose())
  const ui = createRoutedUiState({ local: side.uiState(), replicated })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  attachPreferenceSource(pool, ui)
  disposers.push(() => pool.dispose())
  const log = new AccountTipLog(pool, ui, () => replicated.hydrate())
  const rendered = { ready: false, seen: [] as boolean[] }
  disposers.push(
    autorun(() => {
      rendered.ready = log.ready
      rendered.seen = ACCOUNT_TIP_IDS.map((id) => log.isSeen(id))
    }),
  )
  await log.load()
  expect(rendered.ready).toBe(true)
  expect(rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
  // Server migration/feed regression checks this complete account slice. Feed
  // delivery replaces the base, so omitting seeded rows would erase seen-state.
  replicated.replace({ ...snapshot, dockTab: 'files' })
  await vi.waitFor(() => expect(replicated.get('dockTab')).toBe('files'))
  expect(rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
  expect(log.enabled).toBe(false)
})
