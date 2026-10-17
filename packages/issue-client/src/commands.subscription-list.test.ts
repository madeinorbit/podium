/**
 * `podium subscription list` walks the operator's listing page by page
 * (POD-6209): the server answers one keyset page by default.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const command = (name: string) => {
  const entry = ISSUE_COMMANDS.find((c) => c.name === name)
  if (!entry) throw new Error(`missing ${name} command`)
  return entry
}

const row = (index: number) => ({
  id: `sub_${String(index).padStart(4, '0')}`,
  event: 'issue.closed',
  sourceKind: 'issue',
  sourceRef: `iss_${index}`,
  enabled: true,
  deliverNudge: true,
  deliverNotify: false,
  createdAt: `2026-10-01T00:00:00.${String(index).padStart(3, '0')}Z`,
})

const clientOver = (query: (input: { after?: { id: string }; limit: number }) => Promise<unknown[]>) =>
  ({ issues: { subscriptionList: { query: vi.fn(query) } } }) as unknown as IssueTrpc & {
    issues: { subscriptionList: { query: ReturnType<typeof vi.fn> } }
  }

describe('subscription list', () => {
  it('reads every page of the operator listing, after the last row of each', async () => {
    const all = Array.from({ length: 501 }, (_, index) => row(index))
    const trpc = clientOver(async (input) => {
      const start = input.after ? all.findIndex((r) => r.id === input.after!.id) + 1 : 0
      return all.slice(start, start + input.limit)
    })
    const result = await command('subscription').run(trpc, { sub: 'list' })
    expect((result.data as unknown[]).length).toBe(501)
    expect(trpc.issues.subscriptionList.query.mock.calls).toEqual([
      [{ limit: 500 }],
      [{ after: { createdAt: all[499]!.createdAt, id: 'sub_0499' }, limit: 500 }],
    ])
  })

  it("stops when a page adds nothing: a caller listing its own gets all of it on every call", async () => {
    const own = Array.from({ length: 500 }, (_, index) => row(index))
    const trpc = clientOver(async () => own)
    const result = await command('subscription').run(trpc, { sub: 'list' })
    expect((result.data as unknown[]).length).toBe(500)
    expect(trpc.issues.subscriptionList.query).toHaveBeenCalledTimes(2)
  })
})
