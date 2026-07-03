import { describe, expect, it, vi } from 'vitest'
import { MODEL_CATALOG_VERSION, ModelCatalog } from './model-catalog'

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

  it('seeds from a current-version persisted snapshot (instant, non-cold first open)', () => {
    const persisted = {
      byAgent: { grok: [{ value: 'grok-build', label: 'grok-build' }] },
      fetchedAt: 123,
      version: MODEL_CATALOG_VERSION,
    }
    const cat = new ModelCatalog(
      vi.fn(async () => ({})),
      { load: () => persisted },
    )
    // Served immediately — no probe needed for the first open after a restart.
    expect(cat.get().byAgent.grok?.[0]?.value).toBe('grok-build')
  })

  it('discards a stale-shape persisted snapshot (old/absent version) and re-probes', () => {
    const probe = vi.fn(async () => ({}))
    // A pre-`efforts` snapshot has no version → must be ignored, not served.
    const cat = new ModelCatalog(probe, {
      load: () => ({ byAgent: { grok: [{ value: 'old', label: 'old' }] }, fetchedAt: 123 }),
    })
    expect(cat.get().byAgent).toEqual({}) // not seeded from the stale snapshot
    expect(probe).toHaveBeenCalled() // get() kicked a re-probe
  })

  it('saves each successful refresh with the current version', async () => {
    const save = vi.fn()
    const cat = new ModelCatalog(
      async () => ({ codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] }),
      { now: () => 42, save },
    )
    await cat.refresh()
    expect(save).toHaveBeenCalledWith({
      byAgent: { codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
      fetchedAt: 42,
      version: MODEL_CATALOG_VERSION,
    })
  })
})
