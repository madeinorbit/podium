import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { TranscriptComputeClient } from './transcript-compute-client'

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
})
