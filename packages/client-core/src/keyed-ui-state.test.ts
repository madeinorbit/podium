import { asUserId, layoutRowId } from '@podium/model'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { layoutFixture } from '../test-support/layout'
import { fixtureUi } from '../test-support/ui'
import { loadRecordDeclarations } from './records'
import { memoryStorage } from './replica/contract'
import { openLegacyDeviceKeys } from './ui/draft-storage'
import { createUiKeys } from './ui/keys'
import { SHELL_DENSITY_KEY } from './ui-state'

beforeAll(loadRecordDeclarations)
const user = asUserId('u-1')
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})
function fixture(seed: Readonly<Record<string, unknown>> = {}) {
  const write = vi.fn(async (_kind: string, _input: unknown) => {})
  const path = layoutFixture(user, write, seed)
  const drafts = openLegacyDeviceKeys({ storage: memoryStorage(), keyPrefix: 'keyed-ui' })
  const keys = createUiKeys(() => screen, drafts, path.layout)
  const screen = fixtureUi(keys)
  disposers.push(path.dispose, () => screen.dispose())
  return { ...path, write, keys, screen }
}

it('notifies the canonical key and its declared aliases when the pool record arrives', () => {
  const f = fixture()
  expect(f.keys.get('podium.superOpen.v2')).toBeNull()
  const changes: string[][] = []
  disposers.push(f.keys.subscribe((keys) => changes.push([...keys].sort())))
  f.seed({ superOpen: true })
  expect(changes).toEqual([['podium.superOpen', 'podium.superOpen.v2', 'superOpen']])
  expect(f.keys.get('podium.superOpen.v2')).toBe('true')
})

it('publishes exact device preference keys from their one UiStore map', () => {
  const f = fixture(),
    width = 'podium:sidebar:width'
  const changes: string[][] = []
  disposers.push(f.keys.subscribe((keys) => changes.push([...keys].sort())))
  f.keys.set(SHELL_DENSITY_KEY, 'compact')
  f.keys.set(width, '220')
  f.keys.set(width, '220')
  f.keys.set(SHELL_DENSITY_KEY, null)
  expect(changes).toEqual([[SHELL_DENSITY_KEY], [width], [SHELL_DENSITY_KEY]])
  expect([...f.screen.devicePrefs]).toEqual([[width, '220']])
  expect(f.write).not.toHaveBeenCalled()
})

it('writes one generic record and reads only the value installed in the pool', () => {
  const f = fixture({ dockTab: 'git' })
  expect(f.keys.get('podium.dockTab')).toBe('git')
  f.keys.set('podium.dockTab', 'files')
  expect(f.write.mock.calls).toEqual([
    [
      'recordEdit',
      {
        kind: 'userLayout',
        id: layoutRowId(user, 'dockTab'),
        patch: { value: 'files' },
      },
    ],
  ])
  expect(f.keys.get('podium.dockTab')).toBe('git')
  f.seed({ dockTab: 'files' })
  expect(f.keys.get('podium.dockTab')).toBe('files')
  f.keys.set('podium.dockTab', null)
  expect(f.write.mock.calls[1]).toEqual([
    'recordRemove',
    {
      kind: 'userLayout',
      id: layoutRowId(user, 'dockTab'),
    },
  ])
  f.seed({})
  expect(f.keys.get('podium.dockTab')).toBeNull()
})
