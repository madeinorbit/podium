import type { MobileTranscriptModel } from './transcript-feed'
import { expect, it } from 'vitest'
import { insideArm, measureWork } from '../../../../packages/worklist-proto/harness/src/work-meter'
import { buildMobileTranscript, matchMobileTranscript, positionMobileTranscriptSearch } from './transcript-feed'

it('keeps closed Find and selected-match lookup flat and detects the former whole-row walk', async () => {
  const samples = []
  for (const scale of [1, 4] as const) {
    let rowReads = 0, blockReads = 0
    const built = buildMobileTranscript(Array.from({ length: 128 * scale }, (_, index) => ({ id: `b${index}`, role: 'assistant' as const, text: index === 5 || index === 10 ? 'needle' : 'Settled' })))
    const model: MobileTranscriptModel = {
      blocks: built.blocks.map(block => ({ ...block, item: { ...block.item, get text() { blockReads++; return block.item.text } } })),
      rows: built.rows.map(row => ({ ...row, get blockIndices() { rowReads++; return row.blockIndices } })),
    }
    const measure = async (action: () => unknown) => {
      rowReads = 0; blockReads = 0
      const result = await measureWork(async () => { insideArm(action) })
      return { work: result.work, rowReads, blockReads }
    }
    const closed = await measure(() => { matchMobileTranscript(model, '') })
    const blank = await measure(() => { matchMobileTranscript(model, '   ') })
    const answer = matchMobileTranscript(model, 'needle')
    const next = await measure(() => { positionMobileTranscriptSearch(answer, 1) })
    const previous = await measure(() => { positionMobileTranscriptSearch(answer, -1) })
    expect(positionMobileTranscriptSearch(answer, 1).activeRow).toBe(10)
    expect(positionMobileTranscriptSearch(answer, 2).activeRow).toBe(5)
    const control = await measure(() => {
      // The former implementation walked every row even for a closed query.
      const matches: number[] = []
      model.rows.forEach(row => { row.blockIndices.some(index => matches.includes(index)) })
    })
    const actions = { closed, blank, next, previous }
    for (const action of Object.values(actions)) {
      expect(action.rowReads).toBe(0)
      expect(action.blockReads).toBe(0)
      expect(action.work.derivations).toBe(0) // These are pure functions, not MobX reactions.
      expect(action.work.elements).toBe(0)
      expect(action.work.visits).toBe(0)
    }
    expect(control.rowReads).toBe(128 * scale)
    samples.push({ scale, actions, control })
  }
  expect(samples[1]!.actions).toEqual(samples[0]!.actions)
  expect(samples[1]!.control.rowReads).toBe(samples[0]!.control.rowReads * 4)
  console.log('[phone Find lookup work1x4x]', JSON.stringify(samples))
})
