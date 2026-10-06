import { expect, it, vi } from 'vitest'
import type { TranscriptItem } from '@podium/model'
import { createSideCache } from './side-cache'

it('serializes streaming cache snapshots once per settle window and flushes the unload tail', () => {
  vi.useFakeTimers()
  const storage = { getItem: () => null, setItem: vi.fn(), removeItem: () => {} }
  const side = createSideCache({ storage, enumerateKeys: () => [], transcriptSettleMs: 250 })
  const stringify = vi.spyOn(JSON, 'stringify')
  const serializations = () => stringify.mock.calls.filter(([value]) =>
    value && typeof value === 'object' && 'items' in value && 'savedAt' in value).length
  const sample = []
  try {
    for (let token = 0; token < 20; token++) {
      const before = serializations()
      side.putTranscriptWindow('busy', [{ id: 'stream', role: 'assistant', text: `token ${token}` }] as TranscriptItem[])
      vi.advanceTimersByTime(16)
      sample.push(serializations() - before)
    }
    expect(serializations()).toBe(1)
    expect(side.transcriptWindow('busy')?.items[0]?.text).toBe('token 19')
    side.dispose()
    expect(serializations()).toBe(2)
    vi.advanceTimersByTime(1000)
    expect(serializations()).toBe(2)
    console.log('[transcript cache serialization per frame]', JSON.stringify({ frames: sample,
      stream: 1, unload: 1, unchangedIdle: 0 }))
  } finally {
    side.dispose()
    stringify.mockRestore()
    vi.useRealTimers()
  }
})
