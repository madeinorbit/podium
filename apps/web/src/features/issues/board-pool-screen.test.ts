// @vitest-environment happy-dom
import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const stored = (value: string | null) => ({
  get: vi.fn((key: string) => (key === MOBX_SIDEBAR_KEY ? value : null)),
})
beforeEach(() => {
  vi.resetModules()
  history.replaceState(null, '', '/')
})
afterEach(() => history.replaceState(null, '', '/'))
it.each([
  ['', null, false],
  ['', '1', true],
  ['?mobxBoard=0', '1', false],
  ['?mobxBoard=1', '0', true],
] as const)('latches the independent board switch once with URL precedence: %s', async (query, preference, enabled) => {
  history.replaceState(null, '', `/${query}`)
  const { issueBoardPoolScreen: screen } = await import('./board-pool-screen')
  const { boardDataLayer } = await import('./board-data-layer')
  screen.initialize(stored(preference) as never)
  expect(screen.enabled()).toBe(enabled)
  expect(boardDataLayer()).toBe(enabled ? 'pool' : 'legacy')
  history.replaceState(null, '', enabled ? '/?mobxBoard=0' : '/?mobxBoard=1')
  screen.initialize(stored(enabled ? '0' : '1') as never)
  expect(screen.enabled()).toBe(enabled)
  expect(screen.options?.({} as never)).toMatchObject({
    summaries: { issue: expect.arrayContaining(['description', 'priority']) },
  })
})
