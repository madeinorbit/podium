import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ source: vi.fn(), check: vi.fn(), stopSource: vi.fn(), stopCheck: vi.fn() }))
vi.mock('@podium/client-graph/issue-page-source', () => ({ attachIssuePageSource: mocks.source }))
vi.mock('@podium/client-graph/diagnostics/issue-page-check', () => ({ startIssuePageCheck: mocks.check }))
const stored = (value: string | null) => ({ get: vi.fn((key: string) => key === MOBX_SIDEBAR_KEY ? value : null) })
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); history.replaceState(null, '', '/')
  mocks.source.mockReturnValue(mocks.stopSource); mocks.check.mockReturnValue(mocks.stopCheck)
})
afterEach(() => history.replaceState(null, '', '/'))

describe('issue page startup registration', () => {
  it.each([ ['', null, false], ['', '1', true], ['?mobxPane=0', '1', false], ['?mobxPane=1', '0', true] ] as const)
    ('shares the pane latch and preserves URL precedence: %s', async (query, preference, enabled) => {
      history.replaceState(null, '', `/${query}`)
      const { issuePagePoolScreen: screen } = await import('./pool-screen')
      const { paneDataLayer } = await import('@/lib/pane-data-layer')
      const ui = stored(preference)
      screen.initialize(ui as never)
      expect(screen.enabled()).toBe(enabled)
      expect(paneDataLayer()).toBe(enabled ? 'pool' : 'legacy')
      history.replaceState(null, '', enabled ? '/?mobxPane=0' : '/?mobxPane=1')
      screen.initialize(stored(enabled ? '0' : '1') as never)
      expect(screen.enabled()).toBe(enabled)
      if (!query) expect(ui.get).toHaveBeenCalledExactlyOnceWith(MOBX_SIDEBAR_KEY)
    })

  it.each([ ['?mobxPane=1', false], ['?mobxPane=0&mobxPaneCheck=1', false], ['?mobxPane=1&mobxPaneCheck=1', true] ] as const)
    ('freezes the page diagnostic opt-in at boot: %s', async (query, checked) => {
      history.replaceState(null, '', `/${query}`)
      const { issuePagePoolScreen: screen } = await import('./pool-screen')
      screen.initialize(stored(null) as never)
      history.replaceState(null, '', checked ? '/' : '/?mobxPane=1&mobxPaneCheck=1')
      screen.initialize(stored('1') as never)
      const stop = await screen.attach!({} as never, {} as never)
      expect(mocks.source).toHaveBeenCalledTimes(1)
      expect(mocks.check).toHaveBeenCalledTimes(checked ? 1 : 0)
      stop!()
      expect(mocks.stopSource).toHaveBeenCalledTimes(1)
      expect(mocks.stopCheck).toHaveBeenCalledTimes(checked ? 1 : 0)
    })

  it('retains the required source when optional diagnostics fail', async () => {
    history.replaceState(null, '', '/?mobxPane=1&mobxPaneCheck=1')
    const { issuePagePoolScreen: screen } = await import('./pool-screen')
    screen.initialize(stored(null) as never)
    mocks.check.mockImplementation(() => { throw new Error('Planted optional failure') })
    const stop = await screen.attach!({} as never, {} as never)
    stop!()
    expect(mocks.stopSource).toHaveBeenCalledTimes(1)
  })
})
