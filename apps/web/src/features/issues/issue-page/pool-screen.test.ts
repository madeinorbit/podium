import { expect, it, vi } from 'vitest'
import { issuePagePoolScreen as screen } from './pool-screen'

const mocks = vi.hoisted(() => ({ source: vi.fn(), stop: vi.fn() }))
vi.mock('@podium/client-graph/issue-page-source', () => ({ attachIssuePageSource: mocks.source }))

it('always attaches the addressed page source and releases its owner', async () => {
  expect(screen.initialize).toBeUndefined()
  expect(screen.enabled).toBeUndefined()
  const runtime = {} as never,
    pool = {} as never
  mocks.source.mockReturnValue(mocks.stop)
  const stop = await screen.attach!(runtime, pool)
  expect(mocks.source).toHaveBeenCalledExactlyOnceWith(pool, runtime)
  stop!()
  expect(mocks.stop).toHaveBeenCalledTimes(1)
})
