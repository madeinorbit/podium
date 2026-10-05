import { expect, it } from 'vitest'
import { insideArm, measureWork } from '../../../../packages/worklist-proto/harness/src/work-meter'
import { buildMobileTranscript } from './transcript-feed'

it('answers the last rendered assistant from its scalar and detects the former full-row copy', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    const model = buildMobileTranscript([
      { id: 'assistant', role: 'assistant', text: 'Answer' },
      ...Array.from({ length: 128 * scale }, (_, index) => ({
        id: `u${index}`,
        role: 'user' as const,
        text: 'Operator',
      })),
    ])
    let key: string | undefined
    const lookup = await measureWork(async () =>
      insideArm(() => {
        key = model.latestAssistantKey
      }),
    )
    expect(key).toBe('assistant')
    const control = await measureWork(async () =>
      insideArm(() => {
        key = [...model.rows]
          .reverse()
          .find((row) => row.kind === 'prose' || row.kind === 'answer')?.key
      }),
    )
    expect(key).toBe('assistant')
    expect(lookup.work).toMatchObject({ derivations: 0, elements: 0, visits: 0 })
    expect(control.work.elements).toBeGreaterThanOrEqual(128 * scale)
    samples.push({ scale, lookup, control })
  }
  expect(samples[1]!.lookup).toEqual(samples[0]!.lookup)
  expect(samples[1]!.control.work.visits).toBeGreaterThan(samples[0]!.control.work.visits * 3)
  console.log('[phone assistant scalar work1x4x]', JSON.stringify(samples))
})
