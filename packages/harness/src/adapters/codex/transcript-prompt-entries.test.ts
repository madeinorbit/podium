import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TranscriptItem } from '@podium/model'
import { transcriptEchoAcceptCorrelation } from '../../accept-correlation.js'
import { codexPromptTextMatches, codexRecordToItems } from './transcript.js'

// Real 0.155.0 rollout records, measured 2026-09-29 (POD-4863, S1/S7/S9).
const lane = new URL(
  '../../../../../docs/measurements/pod-4834-receipt-proof/codex-0.155.0/tui/',
  import.meta.url,
)
const rollout = (scenario: string) =>
  readFileSync(new URL(`${scenario}/rollout-1.jsonl`, lane), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))

const completedPrompts = (scenario: string) =>
  rollout(scenario).filter(
    (record) =>
      record.type === 'event_msg' &&
      record.payload.type === 'item_completed' &&
      record.payload.item?.type === 'UserMessage',
  )

describe('Codex measured prompt entries', () => {
  it('marks only completed UserMessage items as prompt entries, retaining separate repeats', () => {
    const records = completedPrompts('t-idle')
    const items = records.flatMap(codexRecordToItems)
    expect(items.map((item) => item.text)).toEqual([
      'ALPHA idle',
      'SAME text twice',
      'SAME text twice',
    ])
    expect(items.map((item) => item.id)).toEqual(records.map((record) => record.payload.item.id))
    for (const item of items) {
      expect(item).toMatchObject({ role: 'user', promptEntry: true })
      expect(TranscriptItem.parse(item)).toHaveProperty('promptEntry', true)
    }
  })

  it.each([
    ['<turn_aborted>', 't-interrupt-tool'],
    ['<hook_prompt', 't-untyped'],
    ['<environment_context>', 't-untyped'],
  ])('drops response_item user %s records', (marker, scenario) => {
    const records = rollout(scenario).filter(
      (record) =>
        record.type === 'response_item' &&
        record.payload.role === 'user' &&
        JSON.stringify(record.payload.content).includes(marker),
    )
    expect(records.length).toBeGreaterThan(0)
    expect(records.flatMap(codexRecordToItems)).toEqual([])
  })

  it('does not mistake completed HookPrompt items for UserMessage items', () => {
    const records = rollout('t-untyped').filter(
      (record) => record.payload.item?.type === 'HookPrompt',
    )
    expect(records).toHaveLength(1)
    expect(records.flatMap(codexRecordToItems)).toEqual([])
  })

  it('never expands compacted replacement_history into new prompt entries', () => {
    const records = rollout('t-untyped')
    const compacted = records.filter((record) => record.type === 'compacted')
    expect(compacted).toHaveLength(1)
    expect(JSON.stringify(compacted[0].payload.replacement_history)).toContain('ONE first')
    expect(compacted.flatMap(codexRecordToItems)).toEqual([])
    const prompts = records.flatMap(codexRecordToItems).filter((item) => item.role === 'user')
    expect(prompts.map((item) => item.text)).toEqual([
      'ONE first',
      'FEEDBACK please',
      'RACE-A first',
      'RACE-B second',
    ])
    expect(prompts.every((item) => item.promptEntry === true)).toBe(true)
  })

  it('keeps the interrupt action visible while excluding it from prompt matching', () => {
    const records = rollout('t-interrupt-tool').filter(
      (record) => record.type === 'event_msg' && record.payload.type === 'turn_aborted',
    )
    expect(records.length).toBeGreaterThan(0)
    for (const item of records.flatMap(codexRecordToItems)) {
      expect(item).toMatchObject({ role: 'user', event: 'interrupt', promptEntry: false })
      expect(transcriptEchoAcceptCorrelation.accepts(item)).toBe(false)
    }
  })
})

describe('Codex measured text tolerance', () => {
  it('allows only the outer-whitespace trimming measured in the terminal', () => {
    const records = completedPrompts('t-text')
    const inputs = [
      '  lead and trail spaces  ',
      'pasted line1\n\n  line3 indented\nline4\ttab\n',
      Array.from({ length: 400 }, (_, i) => `long ${i} ${'y'.repeat(30)}`).join('\n'),
      'nfc:é nfd:é emoji:👩‍👩‍👧 rtl:שלום zwsp:[\u200b] nbsp:[\u00a0]',
    ]
    expect(records).toHaveLength(inputs.length)
    records.forEach((record, index) => {
      const input = inputs[index]!
      const [item] = codexRecordToItems(record)
      expect(item?.text).toBe(input.trim())
      expect(codexPromptTextMatches(input, item!.text)).toBe(true)
    })
  })

  it.each([
    ['one\n\ntwo', 'one\ntwo'],
    ['one\ttwo', 'one    two'],
    ['one  two', 'one two'],
    ['one\r\ntwo', 'one\ntwo'],
    ['e\u0301', 'é'],
    ['x\u200by', 'xy'],
    ['first', 'first extra'],
  ])('rejects an unmeasured change from %j to %j', (submitted, recorded) => {
    expect(codexPromptTextMatches(submitted, recorded)).toBe(false)
  })

  it('does not credit empty or whitespace-only text', () => {
    expect(codexPromptTextMatches('', '')).toBe(false)
    expect(codexPromptTextMatches(' \n\t ', '')).toBe(false)
  })
})
