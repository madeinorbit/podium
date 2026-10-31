import { asMachineId } from '@podium/model'
import { MODEL_CATALOG_MAX_AGE_MS } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { MODEL_CATALOG_VERSION, ModelCatalog, type ModelProbe } from './model-catalog'

describe('ModelCatalog (stale-while-revalidate, machine-keyed)', () => {
  const M = 'machine-a'
  const M2 = 'machine-b'

  it('serves empty immediately and refreshes in the background for that machine', async () => {
    const probe = vi.fn(async () => ({ grok: [{ value: 'g', label: 'g' }] }))
    const cat = new ModelCatalog(probe)
    // First read: stale/empty → returns empty NOW and kicks a bg refresh.
    expect(await cat.get(asMachineId(M))).toEqual({
      machineId: asMachineId(M),
      byAgent: {},
      fetchedAt: 0,
    })
    await cat.refresh(asMachineId(M)) // await the in-flight probe
    expect((await cat.get(asMachineId(M))).byAgent.grok?.[0]?.value).toBe('g')
    expect((await cat.get(asMachineId(M))).machineId).toBe(M)
    expect(probe).toHaveBeenCalledWith(M)
  })

  /**
   * THE multi-machine property (POD-1123). Two machines with different catalogs
   * must not see each other. A single-machine fixture cannot distinguish a
   * per-machine cache from a global one — if this collapses to one snapshot,
   * the second refresh overwrites the first and BOTH reads return the last
   * probe. Measured quantities in the message so a red is greppable.
   */
  it('two machines keep distinct catalogs — neither sees the other', async () => {
    const probe = vi.fn(async (machineId: string) =>
      machineId === M
        ? { grok: [{ value: 'laptop-only', label: 'laptop-only' }] }
        : { grok: [{ value: 'desktop-only', label: 'desktop-only' }] },
    )
    const cat = new ModelCatalog(probe, { now: () => 1 })
    await cat.refresh(asMachineId(M))
    await cat.refresh(asMachineId(M2))
    const a = await cat.get(asMachineId(M))
    const b = await cat.get(asMachineId(M2))
    // Each snapshot names its own machine.
    expect(a.machineId, `machine-a snapshot.machineId=${a.machineId}`).toBe(M)
    expect(b.machineId, `machine-b snapshot.machineId=${b.machineId}`).toBe(M2)
    // Neither reads the other's model list.
    expect(
      a.byAgent.grok?.map((m) => m.value),
      `machine-a models=${JSON.stringify(a.byAgent.grok)} (must be [laptop-only], not desktop)`,
    ).toEqual(['laptop-only'])
    expect(
      b.byAgent.grok?.map((m) => m.value),
      `machine-b models=${JSON.stringify(b.byAgent.grok)} (must be [desktop-only], not laptop)`,
    ).toEqual(['desktop-only'])
    // Cross-read: machine-a must not contain desktop-only, and vice versa.
    expect(a.byAgent.grok?.some((m) => m.value === 'desktop-only')).toBe(false)
    expect(b.byAgent.grok?.some((m) => m.value === 'laptop-only')).toBe(false)
    expect(probe).toHaveBeenCalledWith(M)
    expect(probe).toHaveBeenCalledWith(M2)
  })

  it('serves cached within the TTL without re-probing, refreshes past it', async () => {
    let t = 1000
    const probe = vi.fn(async () => ({ grok: [] }))
    const cat = new ModelCatalog(probe, { ttlMs: 5000, now: () => t })
    await cat.refresh(asMachineId(M))
    await cat.get(asMachineId(M))
    await cat.get(asMachineId(M))
    expect(probe).toHaveBeenCalledTimes(1) // still fresh
    t += 6000 // past TTL
    await cat.get(asMachineId(M)) // kicks a bg refresh
    await cat.refresh(asMachineId(M))
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('uses the selector freshness bound as its default TTL', async () => {
    let t = 1000
    const probe = vi.fn(async () => ({ codex: [] }))
    const cat = new ModelCatalog(probe, { now: () => t })
    await cat.refresh(asMachineId(M))
    t += MODEL_CATALOG_MAX_AGE_MS - 1
    await cat.get(asMachineId(M))
    expect(probe).toHaveBeenCalledTimes(1)
    t += 1
    await cat.get(asMachineId(M))
    await cat.refresh(asMachineId(M))
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good snapshot when a refresh throws', async () => {
    let ok = true
    const probe = vi.fn(async () => {
      if (!ok) throw new Error('cli gone')
      return { grok: [{ value: 'g', label: 'g' }] }
    })
    const cat = new ModelCatalog(probe, { now: () => 1 })
    await cat.refresh(asMachineId(M))
    ok = false
    await cat.refresh(asMachineId(M))
    expect((await cat.get(asMachineId(M))).byAgent.grok?.[0]?.value).toBe('g')
  })

  it('retains omitted agents and their efforts while refreshing reported agents', async () => {
    let t = 1
    const claude = [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low', 'high'] },
    ]
    const grok = [{ value: 'grok-4.5', label: 'Grok 4.5' }]
    const codex = [{ value: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'xhigh'] }]
    const probe = vi
      .fn<ModelProbe>()
      .mockResolvedValue({})
      .mockResolvedValueOnce({
        'claude-code': claude,
        grok,
        codex: [{ value: 'gpt-5.4', label: 'GPT-5.4' }],
      })
      .mockResolvedValueOnce({ codex })
    const save = vi.fn()
    const cat = new ModelCatalog(probe, { now: () => t, save })

    await cat.refresh(asMachineId(M))
    t = 42
    await cat.refresh(asMachineId(M))

    const snapshot = cat.get(asMachineId(M))
    expect(snapshot.byAgent).toEqual({ 'claude-code': claude, grok, codex })
    expect(snapshot.fetchedAt).toBe(42)
    expect(save).toHaveBeenLastCalledWith(snapshot)

    await cat.refresh(asMachineId(M2))
    expect(cat.get(asMachineId(M2)).byAgent).toEqual({})
  })

  it('replaces cached models with a reported empty list', async () => {
    const probe = vi
      .fn<ModelProbe>()
      .mockResolvedValueOnce({
        'claude-code': [{ value: 'claude-sonnet-5', label: 'Claude Sonnet 5' }],
      })
      .mockResolvedValueOnce({ 'claude-code': [] })
    const cat = new ModelCatalog(probe, { now: () => 1 })

    await cat.refresh(asMachineId(M))
    await cat.refresh(asMachineId(M))

    expect(cat.get(asMachineId(M)).byAgent).toEqual({ 'claude-code': [] })
  })

  it('retains persisted models when the first stale refresh omits their agent', async () => {
    const claude = [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low', 'high'] },
    ]
    const codex = [{ value: 'gpt-5.5', label: 'GPT-5.5' }]
    const save = vi.fn()
    const cat = new ModelCatalog(async () => ({ codex }), {
      now: () => 42,
      ttlMs: 10,
      load: () => ({
        machineId: asMachineId(M),
        byAgent: { 'claude-code': claude },
        fetchedAt: 1,
        version: MODEL_CATALOG_VERSION,
      }),
      save,
    })

    cat.get(asMachineId(M))
    await cat.refresh(asMachineId(M))

    expect(cat.get(asMachineId(M)).byAgent).toEqual({ 'claude-code': claude, codex })
    expect(save).toHaveBeenCalledWith({
      machineId: asMachineId(M),
      byAgent: { 'claude-code': claude, codex },
      fetchedAt: 42,
      version: MODEL_CATALOG_VERSION,
    })
  })

  it('dedups concurrent refreshes for the same machine into a single probe', async () => {
    const probe = vi.fn(async () => ({}))
    const cat = new ModelCatalog(probe)
    await Promise.all([
      cat.refresh(asMachineId(M)),
      cat.refresh(asMachineId(M)),
      cat.refresh(asMachineId(M)),
    ])
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
    const a = cat.refresh(asMachineId(M))
    const b = cat.refresh(asMachineId(M2))
    await b
    expect((await cat.get(asMachineId(M2))).byAgent.grok?.[0]?.value).toBe(M2)
    release()
    await a
    expect((await cat.get(asMachineId(M))).byAgent.grok?.[0]?.value).toBe(M)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('seeds from a current-version persisted snapshot for that machine', async () => {
    const persisted = {
      machineId: asMachineId(M),
      byAgent: { grok: [{ value: 'grok-build', label: 'grok-build' }] },
      fetchedAt: 123,
      version: MODEL_CATALOG_VERSION,
    }
    const cat = new ModelCatalog(
      vi.fn(async () => ({})),
      {
        load: (id) => (id === M ? persisted : null),
      },
    )
    // Served immediately — no probe needed for the first open after a restart.
    expect((await cat.get(asMachineId(M))).byAgent.grok?.[0]?.value).toBe('grok-build')
  })

  it('discards a stale-shape or unkeyed persisted snapshot and re-probes', async () => {
    const probe = vi.fn(async () => ({}))
    // A pre-machine-key snapshot has no machineId / old version → must be ignored.
    const cat = new ModelCatalog(probe, {
      load: () =>
        ({
          byAgent: { grok: [{ value: 'old', label: 'old' }] },
          fetchedAt: 123,
        }) as never,
    })
    expect((await cat.get(asMachineId(M))).byAgent).toEqual({}) // not seeded from the stale snapshot
    expect(probe).toHaveBeenCalledWith(M) // get() kicked a re-probe
  })

  /** Independent witness for the VERSION guard: same machineId, pre-split version.
   *  Without this, dropping only `version === MODEL_CATALOG_VERSION` is silent
   *  because the unkeyed fixture also fails the machineId match. */
  it('discards a same-machine snapshot from an older MODEL_CATALOG_VERSION', async () => {
    const probe = vi.fn(async () => ({}))
    const cat = new ModelCatalog(probe, {
      load: () => ({
        machineId: asMachineId(M),
        byAgent: { grok: [{ value: 'pre-split', label: 'pre-split' }] },
        fetchedAt: 123,
        version: MODEL_CATALOG_VERSION - 1,
      }),
    })
    expect(
      (await cat.get(asMachineId(M))).byAgent,
      `seeded pre-split models=${JSON.stringify((await cat.get(asMachineId(M))).byAgent)} (must be empty)`,
    ).toEqual({})
    expect(probe).toHaveBeenCalledWith(M)
  })

  it('discards a persisted snapshot that names a different machine', async () => {
    const probe = vi.fn(async () => ({}))
    const cat = new ModelCatalog(probe, {
      load: () => ({
        machineId: asMachineId(M2),
        byAgent: { grok: [{ value: 'other', label: 'other' }] },
        fetchedAt: 123,
        version: MODEL_CATALOG_VERSION,
      }),
    })
    expect((await cat.get(asMachineId(M))).byAgent).toEqual({})
    expect(probe).toHaveBeenCalledWith(M)
  })

  it('saves each successful refresh with machineId and the current version', async () => {
    const save = vi.fn()
    const cat = new ModelCatalog(
      async () => ({ codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] }),
      { now: () => 42, save },
    )
    await cat.refresh(asMachineId(M))
    expect(save).toHaveBeenCalledWith({
      machineId: asMachineId(M),
      byAgent: { codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
      fetchedAt: 42,
      version: MODEL_CATALOG_VERSION,
    })
  })
})
