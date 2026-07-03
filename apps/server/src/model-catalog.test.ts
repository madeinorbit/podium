import { describe, expect, it, vi } from 'vitest'
import { ModelCatalog } from './model-catalog'

describe('ModelCatalog (stale-while-revalidate)', () => {
  it('serves empty immediately and refreshes in the background', async () => {
    const probe = vi.fn(async () => ({ grok: [{ value: 'g', label: 'g' }] }))
    const cat = new ModelCatalog(probe)
    // First read: stale/empty → returns empty NOW and kicks a bg refresh.
    expect(cat.get()).toEqual({ byAgent: {}, fetchedAt: 0 })
    await cat.refresh() // await the in-flight probe
    expect(cat.get().byAgent.grok?.[0]?.value).toBe('g')
    expect(probe).toHaveBeenCalled()
  })

  it('serves cached within the TTL without re-probing, refreshes past it', async () => {
    let t = 1000
    const probe = vi.fn(async () => ({ grok: [] }))
    const cat = new ModelCatalog(probe, { ttlMs: 5000, now: () => t })
    await cat.refresh()
    cat.get()
    cat.get()
    expect(probe).toHaveBeenCalledTimes(1) // still fresh
    t += 6000 // past TTL
    cat.get() // kicks a bg refresh
    await cat.refresh()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good snapshot when a refresh throws', async () => {
    let ok = true
    const probe = vi.fn(async () => {
      if (!ok) throw new Error('cli gone')
      return { grok: [{ value: 'g', label: 'g' }] }
    })
    const cat = new ModelCatalog(probe, { now: () => 1 })
    await cat.refresh()
    ok = false
    await cat.refresh()
    expect(cat.get().byAgent.grok?.[0]?.value).toBe('g')
  })

  it('dedups concurrent refreshes into a single probe', async () => {
    const probe = vi.fn(async () => ({}))
    const cat = new ModelCatalog(probe)
    await Promise.all([cat.refresh(), cat.refresh(), cat.refresh()])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('seeds from a persisted snapshot on construction (instant, non-cold first open)', () => {
    const persisted = {
      byAgent: { grok: [{ value: 'grok-build', label: 'grok-build' }] },
      fetchedAt: 123,
    }
    const cat = new ModelCatalog(
      vi.fn(async () => ({})),
      { load: () => persisted },
    )
    // Served immediately — no probe needed for the first open after a restart.
    expect(cat.get().byAgent.grok?.[0]?.value).toBe('grok-build')
  })

  it('saves each successful refresh so it survives the next restart', async () => {
    const save = vi.fn()
    const cat = new ModelCatalog(
      async () => ({ codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] }),
      {
        now: () => 42,
        save,
      },
    )
    await cat.refresh()
    expect(save).toHaveBeenCalledWith({
      byAgent: { codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
      fetchedAt: 42,
    })
  })
})
