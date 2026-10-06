import type { TranscriptItem } from '@podium/model'
import { expect, it } from 'vitest'
import { insideReader, measureWork } from '../../../../packages/worklist-proto/harness/src/work-meter'
import { buildMobileTranscript, matchMobileTranscript } from './transcript-feed'

/** The snapshot algorithm is the negative control for the retained model work. */
it('records phone snapshot shaping and search work at 1x/4x history', async () => {
  const count = async (name: string, action: () => unknown) => {
    const result = await measureWork(async () => insideReader(name, action), { trace: true })
    return { ...result.work, sites: Object.fromEntries(result.sites ?? []) }
  }
  const item = (index: number): TranscriptItem => ({
    id: `item-${index}`, cursor: String(index).padStart(8, '0'),
    role: index % 4 === 0 ? 'user' : 'assistant',
    answer: index % 4 === 3, text: index === 5 ? 'needle' : `Settled message ${index}`,
  })
  const samples = []
  for (const scale of [1, 4]) {
    const items = Array.from({ length: 128 * scale }, (_, index) => item(index))
    const tail = items.at(-1)!
    const streamed = { ...tail, text: `${tail.text} token` }
    const incoming = item(items.length)
    const older = [item(-2), item(-1)]
    const model = buildMobileTranscript(items, { includeEmpty: true })
    // Closed Find keeps its order model on same-ID streaming. Active Find
    // currently rebuilds the snapshot from ids/byId on each render.
    const phoneOpenStream = await count('phone.open-stream', () => buildMobileTranscript(
      [...items.slice(0, -1), streamed], { includeEmpty: true },
    ))
    const phoneIncoming = await count('phone.incoming', () => buildMobileTranscript([...items, incoming], { includeEmpty: true }))
    const phoneOlder = await count('phone.loadOlder', () => buildMobileTranscript([...older, ...items], { includeEmpty: true }))
    const phoneSearch = await count('phone.search', () => {
      const fresh = buildMobileTranscript(items.slice(), { includeEmpty: true })
      return matchMobileTranscript(fresh, 'needle')
    })
    const phoneClosedSearch = await count('phone.closed-Find', () => matchMobileTranscript(model, ''))
    samples.push({ scale, history: items.length,
      phoneClosedStream: 'Code-read: unchanged ids retain the closed-Find model; shared intake counted separately',
      phoneOpenStream, phoneIncoming, phoneOlder, phoneSearch, phoneClosedSearch,
      phoneVerbosity: 'not exposed by the phone list' })
  }
  expect(samples[1]!.phoneIncoming.elements).toBeGreaterThan(samples[0]!.phoneIncoming.elements * 3)
  expect(samples[1]!.phoneClosedSearch.elements).toBe(0)
  console.log('[phone-transcript-snapshot-work]', JSON.stringify(samples))
})
