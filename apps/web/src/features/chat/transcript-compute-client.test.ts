import type { TranscriptItem } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptComputeClient } from './transcript-compute-client'

afterEach(() => vi.unstubAllGlobals())

const item = (
  overrides: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role'>,
): TranscriptItem => ({
  text: '',
  ...overrides,
})

describe('TranscriptComputeClient', () => {
  it('keeps the indexed graph stable when only search state changes', () => {
    const client = new TranscriptComputeClient()
    const items = [
      item({ id: 'u1', role: 'user', text: 'Prompt' }),
      item({ id: 'a1', role: 'assistant', text: 'The NEEDLE is here' }),
    ]

    const first = client.computeOnMain({ items, verbosity: 'normal', query: '', cursor: 0 })
    const second = client.computeOnMain({ items, verbosity: 'normal', query: 'needle', cursor: 0 })

    expect(second.blocks).toBe(first.blocks)
    expect(second.rows).toBe(first.rows)
    expect(second.markdownHtml).toBe(first.markdownHtml)
    expect(second.search.matches).toEqual([1])
  })

  it('uses the deferred renderer supplied by the feed when no Worker is available', async () => {
    vi.stubGlobal('Worker', undefined)
    const client = new TranscriptComputeClient()
    const renderOnMain = vi.fn((text: string) => `<p>${text}</p>`)

    await expect(client.computeMarkdown('streaming', renderOnMain)).resolves.toBe(
      '<p>streaming</p>',
    )
    expect(renderOnMain).toHaveBeenCalledOnce()
  })
})
