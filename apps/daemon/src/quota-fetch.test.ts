import type { AgentKind, AgentQuotaWire } from '@podium/protocol'
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
