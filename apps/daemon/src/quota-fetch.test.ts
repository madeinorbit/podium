import type { AgentKind, AgentQuotaWire } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { makeQuotaFetcher } from './quota-fetch'

const wire = (agent: AgentKind, status: AgentQuotaWire['status']): AgentQuotaWire => ({
  agent,
  status,
  windows: [],
  fetchedAt: '2026-06-19T18:00:00.000Z',
})

describe('makeQuotaFetcher', () => {
  it('aggregates all fetchers and isolates a thrown fetcher as error', async () => {
    const f = makeQuotaFetcher({
      fetchers: [
        { agent: 'claude-code', fetch: async () => wire('claude-code', 'ok') },
        {
          agent: 'codex',
          fetch: async () => {
            throw new Error('boom')
          },
        },
      ],
    })
    const r = await f.getAgentQuota()
    expect(r.map((x) => [x.agent, x.status])).toEqual([
      ['claude-code', 'ok'],
      ['codex', 'error'],
    ])
    expect(r[1]?.error).toContain('boom')
  })

  it('serves a cached value within TTL and refetches after it / on refresh', async () => {
    let t = 1000
    const spy = vi.fn(async () => wire('claude-code', 'ok'))
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ agent: 'claude-code', fetch: spy }],
    })
    await f.getAgentQuota() // miss → 1 call
    t = 1050
    await f.getAgentQuota() // within TTL → cached
    expect(spy).toHaveBeenCalledTimes(1)
    await f.getAgentQuota(true) // refresh bypasses cache
    expect(spy).toHaveBeenCalledTimes(2)
    t = 1200
    await f.getAgentQuota() // TTL elapsed → refetch
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('uses a default TTL longer than the 60s client poll so the memo survives a poll', async () => {
    // The client polls every 60s; at a 60s TTL the memo is always exactly stale by
    // the next poll and re-fetches every time. The default TTL must exceed 60s so a
    // second call within the poll window is served from the memo.
    let t = 0
    const spy = vi.fn(async () => wire('claude-code', 'ok'))
    const f = makeQuotaFetcher({
      // no ttlMs override → exercises DEFAULT_TTL_MS
      now: () => t,
      fetchers: [{ agent: 'claude-code', fetch: spy }],
    })
    await f.getAgentQuota() // miss → 1 call
    t = 60_000 // a full client poll interval later
    await f.getAgentQuota() // still within the default TTL → served from memo
    expect(spy).toHaveBeenCalledTimes(1)
    t = 120_000 // at the TTL boundary → memo expired → refetch
    await f.getAgentQuota()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('serves the STALE value immediately once the TTL lapses and refreshes behind it', async () => {
    // POD-1624: the whole cost of quota.summary is three live vendor HTTP calls
    // (measured on ludovico: claude 239-479ms, codex 349-537ms, grok 535-1171ms,
    // run concurrently). A plain TTL memo still makes ONE caller every 120s pay
    // that latency in full — that caller is the top bar on a page load, which is
    // exactly the freeze this issue is about. Past the TTL we must hand back the
    // last good value at once and let the refetch land out of band.
    let t = 1000
    let release: (w: AgentQuotaWire) => void = () => {}
    const spy = vi.fn(
      () =>
        new Promise<AgentQuotaWire>((resolve) => {
          release = resolve
        }),
    )
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ agent: 'claude-code', fetch: spy }],
    })
    const cold = f.getAgentQuota() // nothing cached → must block
    release({ ...wire('claude-code', 'ok'), fetchedAt: 'first' })
    expect((await cold)[0]?.fetchedAt).toBe('first')

    t = 1200 // TTL lapsed → stale, but a value exists
    const stale = await f.getAgentQuota() // must NOT wait on the pending fetch
    expect(stale[0]?.fetchedAt).toBe('first')
    expect(spy).toHaveBeenCalledTimes(2) // refresh was kicked off behind it

    release({ ...wire('claude-code', 'ok'), fetchedAt: 'second' })
    await vi.waitFor(async () => expect((await f.getAgentQuota())[0]?.fetchedAt).toBe('second'))
  })

  it('collapses concurrent stale refreshes into one in-flight fetch', async () => {
    let t = 1000
    let calls = 0
    const spy = vi.fn(async () => {
      calls += 1
      return { ...wire('claude-code', 'ok'), fetchedAt: `v${calls}` }
    })
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ agent: 'claude-code', fetch: spy }],
    })
    await f.getAgentQuota()
    t = 1200
    await Promise.all([f.getAgentQuota(), f.getAgentQuota(), f.getAgentQuota()])
    // three stale reads, one refresh — not a stampede of vendor calls
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not cache an errored fetcher (retries on the next call within TTL)', async () => {
    let t = 1000
    const spy = vi.fn(async () => {
      throw new Error('blip')
    })
    const f = makeQuotaFetcher({
      ttlMs: 100,
      now: () => t,
      fetchers: [{ agent: 'claude-code', fetch: spy }],
    })
    const r1 = await f.getAgentQuota()
    expect(r1[0]?.status).toBe('error')
    t = 1050 // still within TTL
    await f.getAgentQuota()
    expect(spy).toHaveBeenCalledTimes(2) // re-invoked because the error was not cached
  })
})
