import { describe, expect, it, vi } from 'vitest'
import { MODEL_CATALOG_VERSION, ModelCatalog } from './model-catalog'

describe('ModelCatalog (stale-while-revalidate, machine-keyed)', () => {
  const M = 'machine-a'
  const M2 = 'machine-b'

  it('serves empty immediately and refreshes in the background for that machine', async () => {
    const probe = vi.fn(async () => ({ grok: [{ value: 'g', label: 'g' }] }))
    const cat = new ModelCatalog(probe)
    // First read: stale/empty → returns empty NOW and kicks a bg refresh.
    expect(cat.get(M)).toEqual({ machineId: M, byAgent: {}, fetchedAt: 0 })
    await cat.refresh(M) // await the in-flight probe
    expect(cat.get(M).byAgent.grok?.[0]?.value).toBe('g')
    expect(cat.get(M).machineId).toBe(M)
    expect(probe).toHaveBeenCalledWith(M)
  })

  it('keeps separate snapshots per machineId', async () => {
    const probe = vi.fn(async (machineId: string) =>
      machineId === M
        ? { grok: [{ value: 'a', label: 'a' }] }
        : { grok: [{ value: 'b', label: 'b' }] },
    )
    const cat = new ModelCatalog(probe, { now: () => 1 })
    await cat.refresh(M)
    await cat.refresh(M2)
    expect(cat.get(M).byAgent.grok?.[0]?.value).toBe('a')
    expect(cat.get(M2).byAgent.grok?.[0]?.value).toBe('b')
    expect(probe).toHaveBeenCalledWith(M)
    expect(probe).toHaveBeenCalledWith(M2)
  })

  it('serves cached within the TTL without re-probing, refreshes past it', async () => {
    let t = 1000
    const probe = vi.fn(async () => ({ grok: [] }))
    const cat = new ModelCatalog(probe, { ttlMs: 5000, now: () => t })
    await cat.refresh(M)
    cat.get(M)
    cat.get(M)
    expect(probe).toHaveBeenCalledTimes(1) // still fresh
    t += 6000 // past TTL
    cat.get(M) // kicks a bg refresh
    await cat.refresh(M)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good snapshot when a refresh throws', async () => {
    let ok = true
    const probe = vi.fn(async () => {
      if (!ok) throw new Error('cli gone')
      return { grok: [{ value: 'g', label: 'g' }] }
    })
    const cat = new ModelCatalog(probe, { now: () => 1 })
    await cat.refresh(M)
    ok = false
    await cat.refresh(M)
    expect(cat.get(M).byAgent.grok?.[0]?.value).toBe('g')
  })

  it('dedups concurrent refreshes for the same machine into a single probe', async () => {
    const probe = vi.fn(async () => ({}))
    const cat = new ModelCatalog(probe)
    await Promise.all([cat.refresh(M), cat.refresh(M), cat.refresh(M)])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not share inflight probes across machines', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const probe = vi.fn(async (machineId: string) => {
      if (machineId === M) await gate
      return { grok: [{ value: machineId, label: machineId }] }
    })
    const cat = new ModelCatalog(probe, { now: () => 1 })
    const a = cat.refresh(M)
    const b = cat.refresh(M2)
    await b
    expect(cat.get(M2).byAgent.grok?.[0]?.value).toBe(M2)
    release()
    await a
    expect(cat.get(M).byAgent.grok?.[0]?.value).toBe(M)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('seeds from a current-version persisted snapshot for that machine', () => {
    const persisted = {
      machineId: M,
      byAgent: { grok: [{ value: 'grok-build', label: 'grok-build' }] },
      fetchedAt: 123,
      version: MODEL_CATALOG_VERSION,
    }
    const cat = new ModelCatalog(vi.fn(async () => ({})), {
      load: (id) => (id === M ? persisted : null),
    })
    // Served immediately — no probe needed for the first open after a restart.
    expect(cat.get(M).byAgent.grok?.[0]?.value).toBe('grok-build')
  })

  it('discards a stale-shape or unkeyed persisted snapshot and re-probes', () => {
    const probe = vi.fn(async () => ({}))
    // A pre-machine-key snapshot has no machineId / old version → must be ignored.
    const cat = new ModelCatalog(probe, {
      load: () =>
        ({
          byAgent: { grok: [{ value: 'old', label: 'old' }] },
          fetchedAt: 123,
        }) as never,
    })
    expect(cat.get(M).byAgent).toEqual({}) // not seeded from the stale snapshot
    expect(probe).toHaveBeenCalledWith(M) // get() kicked a re-probe
  })

  it('discards a persisted snapshot that names a different machine', () => {
    const probe = vi.fn(async () => ({}))
    const cat = new ModelCatalog(probe, {
      load: () => ({
        machineId: M2,
        byAgent: { grok: [{ value: 'other', label: 'other' }] },
        fetchedAt: 123,
        version: MODEL_CATALOG_VERSION,
      }),
    })
    expect(cat.get(M).byAgent).toEqual({})
    expect(probe).toHaveBeenCalledWith(M)
  })

  it('saves each successful refresh with machineId and the current version', async () => {
    const save = vi.fn()
    const cat = new ModelCatalog(
      async () => ({ codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] }),
      { now: () => 42, save },
    )
    await cat.refresh(M)
    expect(save).toHaveBeenCalledWith({
      machineId: M,
      byAgent: { codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
      fetchedAt: 42,
      version: MODEL_CATALOG_VERSION,
    })
  })
})
