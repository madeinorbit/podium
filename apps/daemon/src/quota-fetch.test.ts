import type { AgentKind, AgentQuotaWire } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { makeQuotaFetcher } from './quota-fetch'

const wire = (agent: AgentKind, status: AgentQuotaWire['status']): AgentQuotaWire => ({
  agent, status, windows: [], fetchedAt: '2026-06-19T18:00:00.000Z',
})

describe('makeQuotaFetcher', () => {
  it('aggregates all fetchers and isolates a thrown fetcher as error', async () => {
    const f = makeQuotaFetcher({
      fetchers: [
        { agent: 'claude-code', fetch: async () => wire('claude-code', 'ok') },
        { agent: 'codex', fetch: async () => { throw new Error('boom') } },
      ],
    })
    const r = await f.getAgentQuota()
    expect(r.map((x) => [x.agent, x.status])).toEqual([
      ['claude-code', 'ok'],
      ['codex', 'error'],
    ])
    expect(r[1].error).toContain('boom')
  })

  it('serves a cached value within TTL and refetches after it / on refresh', async () => {
    let t = 1000
    const spy = vi.fn(async () => wire('claude-code', 'ok'))
    const f = makeQuotaFetcher({ ttlMs: 100, now: () => t, fetchers: [{ agent: 'claude-code', fetch: spy }] })
    await f.getAgentQuota()           // miss → 1 call
    t = 1050
    await f.getAgentQuota()           // within TTL → cached
    expect(spy).toHaveBeenCalledTimes(1)
    await f.getAgentQuota(true)       // refresh bypasses cache
    expect(spy).toHaveBeenCalledTimes(2)
    t = 1200
    await f.getAgentQuota()           // TTL elapsed → refetch
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('does not cache an errored fetcher (retries on the next call within TTL)', async () => {
    let t = 1000
    const spy = vi.fn(async () => { throw new Error('blip') })
    const f = makeQuotaFetcher({ ttlMs: 100, now: () => t, fetchers: [{ agent: 'claude-code', fetch: spy }] })
    const r1 = await f.getAgentQuota()
    expect(r1[0].status).toBe('error')
    t = 1050 // still within TTL
    await f.getAgentQuota()
    expect(spy).toHaveBeenCalledTimes(2) // re-invoked because the error was not cached
  })
})
