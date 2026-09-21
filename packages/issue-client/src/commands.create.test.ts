/**
 * `podium issue create` prints the full prefixed id so a caller can copy it
 * into later flags without confusing sequence numbers across repos.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IssueTrpc } from './client.js'
import { ISSUE_COMMANDS } from './commands.js'

const command = (name: string) => {
  const entry = ISSUE_COMMANDS.find((c) => c.name === name)
  if (!entry) throw new Error(`missing ${name} command`)
  return entry
}

function createClient(result: { seq: number; title: string; displayRef?: string }) {
  return {
    issues: { create: { mutate: vi.fn(async () => result) } },
  } as unknown as IssueTrpc
}

describe('issue create printed id', () => {
  it('prints the prefixed displayRef as one token', async () => {
    const trpc = createClient({ seq: 12, title: 'Found bug', displayRef: 'POD-12' })
    const result = await command('create').run(trpc, {
      repoPath: '/home/u/podium',
      title: 'Found bug',
    })
    expect(result.text).toBe('created POD-12 Found bug')
    expect(result.data).toEqual(expect.objectContaining({ displayRef: 'POD-12', seq: 12 }))
  })

  it('keeps two repos distinguishable when their sequence numbers collide', async () => {
    const podium = await command('create').run(
      createClient({ seq: 12, title: 'Podium bug', displayRef: 'POD-12' }),
      { repoPath: '/home/u/podium', title: 'Podium bug' },
    )
    const other = await command('create').run(
      createClient({ seq: 12, title: 'Other bug', displayRef: 'OTH-12' }),
      { repoPath: '/home/u/other', title: 'Other bug' },
    )
    expect(podium.text).toBe('created POD-12 Podium bug')
    expect(other.text).toBe('created OTH-12 Other bug')
  })

  it('falls back to #seq when the payload has no displayRef', async () => {
    const result = await command('create').run(createClient({ seq: 8, title: 'T' }), {
      repoPath: '/r',
      title: 'T',
    })
    expect(result.text).toBe('created #8 T')
  })
})
