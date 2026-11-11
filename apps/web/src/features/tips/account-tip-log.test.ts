import { loadRecordDeclarations } from '@podium/client-core/records'
import { memoryStorage } from '@podium/client-core/replica'
import { layoutFixture } from '@podium/client-core/test-support/layout'
import { openLegacyDeviceKeys } from '@podium/client-core/ui'
import { createRoutedUiState } from '@podium/client-core/ui-state'
import { attachPreferenceSource } from '@podium/client-graph/preference-source'
import { asUserId, parseLayoutRowId } from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ACCOUNT_TIP_IDS, AccountTipLog } from './account-tip-log'

vi.mock('@/app/store-worklist-pool', () => ({ useWorklistPool: () => null }))
beforeAll(loadRecordDeclarations)
const AT = '2026-10-27T18:00:00.000Z'
const disposers: Array<() => void> = []
afterEach(() => {
  for (const stop of disposers.splice(0).reverse()) stop()
})

/** The fake server publishes each account's authoritative rows into real pools. */
function account(initial: Readonly<Record<string, unknown>> = {}) {
  const data = new Map(Object.entries(initial))
  const devices = new Set<ReturnType<typeof layoutFixture>>()
  const deliver = () => {
    for (const target of devices) target.seed(Object.fromEntries(data))
  }
  const device = (options: { loaded?: boolean; now?: () => string } = {}) => {
    const path = layoutFixture(
      asUserId('member'),
      async (kind, input) => {
        expect(input.kind).toBe('userLayout')
        const key = parseLayoutRowId(input.id).key
        if (kind === 'recordEdit' && 'patch' in input) data.set(key, input.patch.value)
        else if (kind === 'recordRemove') data.delete(key)
        else throw new Error(`Unexpected tip write: ${kind}`)
        deliver()
      },
      options.loaded === false ? null : Object.fromEntries(data),
    )
    devices.add(path)
    const local = openLegacyDeviceKeys({ storage: memoryStorage(), keyPrefix: 'tips-fixture' })
    const keys = createRoutedUiState({ local, replicated: path.layout })
    attachPreferenceSource(path.pool, keys)
    const log = path.pool.sources.view(
      'account-tip-log',
      () => new AccountTipLog(path.pool, keys, options.now ?? (() => AT)),
    )
    const rendered = { ready: false, enabled: false, seen: [] as boolean[] }
    disposers.push(() => {
      devices.delete(path)
      path.dispose()
    })
    disposers.push(
      autorun(() => {
        rendered.ready = log.ready
        rendered.enabled = log.enabled
        rendered.seen = ACCOUNT_TIP_IDS.map((id) => log.isSeen(id))
      }),
    )
    return { ...path, log, rendered, local }
  }
  return { data, device, deliver }
}

it('waits for the principal layout to attach before recording or showing a tip', () => {
  const f = account(),
    d = f.device({ loaded: false })
  expect(d.rendered.ready).toBe(false)
  d.log.record('first-prompt', 'finished')
  d.log.setEnabled(false)
  expect(f.data.size).toBe(0)
  f.deliver()
  expect(d.rendered.ready).toBe(true)
  expect(d.rendered.seen.every((seen) => !seen)).toBe(true)
})

it('shown does not mark seen; terminal outcomes preserve their original timestamps', () => {
  const f = account(),
    now = vi.fn(() => AT),
    d = f.device({ now })
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

it('feeds remote changes to both devices while isolating accounts', () => {
  const f = account(),
    a = f.device(),
    b = f.device(),
    other = account().device()
  a.log.record('first-prompt', 'finished')
  b.log.record('first-send', 'dismissed')
  expect(a.rendered.seen.slice(0, 2)).toEqual([true, true])
  expect(b.rendered.seen.slice(0, 2)).toEqual([true, true])
  expect(other.rendered.seen.every((seen) => !seen)).toBe(true)
  a.log.setEnabled(false)
  expect(b.rendered.enabled).toBe(false)
  b.log.setEnabled(true)
  expect(a.rendered.enabled).toBe(true)
  expect(a.local.get('tips.enabled')).toBeNull()
})

it('re-enabling restores one-time tips and the phone promo across devices, with Undo', () => {
  const f = account(),
    d = f.device()
  d.log.record('first-prompt', 'skipped-all')
  expect(d.rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
  expect(d.rendered.enabled).toBe(false)
  f.data.set('mobile.promoDismissed', 'true')
  f.deliver()
  const undo = d.log.setEnabled(true)
  const reload = f.device()
  expect(reload.rendered.ready).toBe(true)
  expect(reload.rendered.enabled).toBe(true)
  expect(reload.rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => false))
  expect(reload.layout.get('mobile.promoDismissed')).toBeUndefined()
  undo?.()
  expect(reload.rendered.enabled).toBe(false)
  expect(reload.rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
  expect(reload.layout.get('mobile.promoDismissed')).toBe('true')
  expect(f.data.get('tips.seen.first-prompt')).toBe(AT)
})

it('retires with the account pool even when rows arrive after teardown', () => {
  const f = account(),
    d = f.device({ loaded: false })
  d.log.dispose()
  f.deliver()
  expect(d.rendered.ready).toBe(false)
  d.log.record('first-prompt', 'finished')
  d.log.setEnabled(false)
  expect(f.data.size).toBe(0)
})

it('keeps upgraded-account tips seen when a new pool snapshot adds other layout rows', () => {
  const seeded = Object.fromEntries(ACCOUNT_TIP_IDS.map((id) => [`tips.seen.${id}`, AT]))
  const f = account({ ...seeded, 'tips.enabled': 'false' }),
    d = f.device()
  expect(d.rendered.ready).toBe(true)
  expect(d.rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
  f.data.set('dockTab', 'files')
  f.deliver()
  expect(d.layout.get('dockTab')).toBe('files')
  expect(d.rendered.seen).toEqual(ACCOUNT_TIP_IDS.map(() => true))
  expect(d.log.enabled).toBe(false)
})
