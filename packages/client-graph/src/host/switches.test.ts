import { expect, it, vi } from 'vitest'
import { type PoolSwitchStorage, poolSwitches } from './switches'

// A phone-style store: no URL, just saved key/values and the device setting.
function store(values: Record<string, string>, device = false) {
  const storage = {
    get: vi.fn((key: string) => values[key] ?? null),
    device: vi.fn(() => device),
  } satisfies PoolSwitchStorage
  return { storage, open: vi.fn(() => storage) }
}

it.each([
  ['1', false, 'pool'],
  ['true', false, 'pool'],
  ['0', true, 'legacy'],
  ['false', true, 'legacy'],
  ['yes', true, 'pool'],
  ['yes', false, 'legacy'],
] as const)('override %s over device %s is %s', (value, device, layer) => {
  const { storage, open } = store({ mobxScreen: value }, device)
  const screen = poolSwitches(open)('mobxScreen')
  screen.initialize({ get: () => null })
  expect(screen.layer()).toBe(layer)
  // The device setting is read only when the screen has no override.
  expect(storage.device).toHaveBeenCalledTimes(['1', 'true', '0', 'false'].includes(value) ? 0 : 1)
})

it('is legacy until latched and latches once per app load from the storage the app supplies', () => {
  const first = store({}, true),
    second = store({}, false)
  const ui = { get: () => null }
  const open = vi.fn().mockReturnValueOnce(first.storage).mockReturnValueOnce(second.storage)
  const screen = poolSwitches(open)('mobxScreen', 'mobxScreenCheck')
  expect(screen.layer()).toBe('legacy')
  expect(screen.initialize(ui)).toBe(first.storage)
  expect(open).toHaveBeenCalledExactlyOnceWith(ui)
  expect(screen.initialize({ get: () => null })).toBeUndefined()
  expect(open).toHaveBeenCalledTimes(1)
  expect(screen.layer()).toBe('pool')
})

it('requests the side-by-side check only with the switch on and the check key exactly 1', () => {
  const latch = (values: Record<string, string>, device: boolean, checkKey?: string) => {
    const screen = poolSwitches(store(values, device).open)('mobxScreen', checkKey)
    screen.initialize({ get: () => null })
    return screen.checkRequested()
  }
  expect(latch({ mobxScreenCheck: '1' }, true, 'mobxScreenCheck')).toBe(true)
  expect(latch({ mobxScreenCheck: 'true' }, true, 'mobxScreenCheck')).toBe(false)
  expect(latch({ mobxScreenCheck: '1' }, false, 'mobxScreenCheck')).toBe(false)
  expect(latch({ mobxScreenCheck: '1' }, true)).toBe(false)
})

it('keeps each screen latch independent under one storage', () => {
  const { open } = store({ mobxA: '1', mobxB: '0' })
  const make = poolSwitches(open)
  const a = make('mobxA'),
    b = make('mobxB')
  a.initialize({ get: () => null })
  b.initialize({ get: () => null })
  expect([a.layer(), b.layer()]).toEqual(['pool', 'legacy'])
})
