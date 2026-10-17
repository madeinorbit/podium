import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TriggersSection } from './TriggersSection'

const subscription = (index: number) => ({
  id: `sub_${String(index).padStart(3, '0')}`,
  subscriberKind: 'issue',
  subscriberId: `iss_${index}`,
  event: 'issue.closed',
  sourceKind: 'issue',
  sourceRef: `iss_src_${index}`,
  deliverNudge: true,
  deliverNotify: false,
  origin: 'custom',
  enabled: true,
  createdAt: `2026-10-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TriggersSection', () => {
  it('reads the triggers a page at a time: a full page offers more, read after the last one shown (POD-6209)', async () => {
    const all = Array.from({ length: 103 }, (_, index) => subscription(index))
    const query = vi.fn(async (input: { after?: { id: string }; limit: number }) => {
      const start = input.after ? all.findIndex((row) => row.id === input.after!.id) + 1 : 0
      return all.slice(start, start + input.limit)
    })
    render(<TriggersSection trpc={{ issues: { subscriptionList: { query } } } as never} />)

    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(100))
    expect(query).toHaveBeenLastCalledWith({ limit: 100 })
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))

    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(103))
    expect(query).toHaveBeenLastCalledWith({
      after: { createdAt: all[99]!.createdAt, id: 'sub_099' },
      limit: 100,
    })
    // A short page is the end of the list.
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })
})
