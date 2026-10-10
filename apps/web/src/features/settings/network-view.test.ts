import type { Trpc } from '@/app/trpc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkSettingsView } from './network-view'

const views: NetworkSettingsView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('network health refresh', () => {
  it('polls while visible, refreshes after returning, and stops when the view closes', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const query = vi.fn().mockResolvedValue({ mode: 'server', networkOption: 'cloudflare-tunnel' })
    const view = new NetworkSettingsView({ setup: { info: { query } } } as unknown as Pick<Trpc, 'setup'>)
    views.push(view)
    view.open()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(query).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(query).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledTimes(3)
    view.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(query).toHaveBeenCalledTimes(3)
  })
})
