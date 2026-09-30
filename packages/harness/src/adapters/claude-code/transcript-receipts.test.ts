import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudePromptTextMatches, promptEchoCorrelation } from '../../accept-correlation.js'
import { transcriptReceiptMapperFor } from '../../registry.js'
import { claudeRecordReceipts, claudeRecordToItems } from './transcript.js'

/**
 * WHAT CLAUDE'S HISTORY SAYS ABOUT A TERMINAL SEND (POD-4905), held to the
 * records Claude 2.1.284 wrote in the POD-4862 lane
 * (docs/measurements/pod-4834-receipt-proof/claude-2.1.284/).
 */
const LANE = fileURLToPath(
  new URL(
    '../../../../../docs/measurements/pod-4834-receipt-proof/claude-2.1.284/tui/',
    import.meta.url,
  ),
)
const records = readFileSync(
  `${LANE}transcripts/db6804f3-2a9b-4aca-a640-bd3c9c68544e.jsonl`,
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>)
/** The record at a 1-based line of the lane's transcript. */
const line = (n: number) => records[n - 1]
const sent = (name: string) => readFileSync(`${LANE}sent/${name}.txt`, 'utf8')
const recorded = (n: number) => claudeRecordToItems(line(n))[0]?.text ?? ''

describe("Claude's queue records", () => {
  it('reads an `enqueue` as a proof-only held record carrying the prompt', () => {
    expect(line(34)).toMatchObject({ type: 'queue-operation', operation: 'enqueue' })
    const items = claudeRecordReceipts(line(34))
    expect(items).toEqual([
      {
        id: '',
        role: 'system',
        ts: '2026-09-29T16:13:07.835Z',
        text: 'QUEUED-A1 typed while the tool runs',
        promptEntry: false,
        queued: true,
      },
    ])
    for (const item of items) expect(TranscriptItem.parse(item)).toHaveProperty('queued', true)
  })

  it('reads nothing from `dequeue` or another `remove`, and the display reader shows no queue record', () => {
    for (const n of [35, 77]) {
      expect(line(n)).toMatchObject({ type: 'queue-operation' })
      expect(claudeRecordReceipts(line(n))).toEqual([])
    }
    // `absorbed_mid_turn`: send-now took it into the running turn, not a drop.
    expect(line(77)).toMatchObject({ operation: 'remove', reason: 'absorbed_mid_turn' })
    for (const n of [34, 35, 77, 129]) expect(claudeRecordToItems(line(n))).toEqual([])
  })

  /**
   * A PROMPT A HOOK DROPPED (POD-4887, spec §6.1 N2b), as 2.1.284 recorded it
   * in the lane's A7–A9 runs (timelines/userpromptsubmit-hook-blocks-idle-and-queued.txt):
   * queued, `remove` with `reason: "dropped_by_hook"`; idle, a `system` record
   * "blocked by hook" ending in the prompt. Both proof-only, never shown.
   */
  it('reads a `dropped_by_hook` remove as a proof-only drop carrying the prompt', () => {
    for (const [n, text] of [
      [129, 'BLOCKME A8 queued in tool'],
      [139, 'BLOCKME A9 queued in text'],
    ] as const) {
      expect(line(n)).toMatchObject({ operation: 'remove', reason: 'dropped_by_hook' })
      const items = claudeRecordReceipts(line(n))
      expect(items).toEqual([
        expect.objectContaining({ role: 'system', text, promptEntry: false, dropped: true }),
      ])
      for (const item of items) expect(TranscriptItem.parse(item)).toHaveProperty('dropped', true)
    }
  })

  it('reads the idle "blocked by hook" record as a proof-only drop of the prompt typed', () => {
    expect(line(119)).toMatchObject({ type: 'system', subtype: 'informational' })
    expect(claudeRecordReceipts(line(119))).toEqual([
      {
        id: '',
        role: 'system',
        ts: '2026-09-29T16:15:27.277Z',
        text: 'BLOCKME A7 idle',
        promptEntry: false,
        dropped: true,
      },
    ])
    // Its words are the words sent, within Claude's tolerance.
    expect(claudePromptTextMatches('BLOCKME A7 idle', 'BLOCKME A7 idle')).toBe(true)
    // And the display reader never makes it a prompt entry.
    const echo = promptEchoCorrelation(claudePromptTextMatches)
    for (const item of claudeRecordToItems(line(119))) expect(echo.accepts(item)).toBe(false)
  })

  it('reads no drop from any other informational record', () => {
    const other = { ...line(119), content: 'Some other notice\n\nOriginal prompt: nope' }
    expect(claudeRecordReceipts(other)).toEqual([])
  })

  it('never makes a queue record a prompt entry', () => {
    const echo = promptEchoCorrelation(claudePromptTextMatches)
    // Ours, and one for a background task's notification nobody typed.
    for (const n of [34, 83]) {
      const [item] = claudeRecordReceipts(line(n))
      expect(item).toBeDefined()
      if (item) expect(echo.accepts(item)).toBe(false)
    }
  })

  it("is Claude's declared proof-only reader, and only Claude declares one", () => {
    expect(transcriptReceiptMapperFor('claude-code')).toBe(claudeRecordReceipts)
    for (const kind of ['codex', 'grok', 'opencode', 'cursor', 'pi']) {
      expect(transcriptReceiptMapperFor(kind)).toBeUndefined()
    }
  })

  it('reads nothing from records that are not queue records', () => {
    expect(claudeRecordReceipts(line(37))).toEqual([])
    expect(claudeRecordReceipts(null)).toEqual([])
  })
})

describe("Claude's measured text tolerance (S7)", () => {
  it.each([
    ['A17', 231, 'a tab is recorded as four spaces; outer spaces are trimmed by the reader'],
    ['A21', 253, 'Unicode, combining marks, ZWJ and NBSP are kept exactly'],
    ['A22', 259, 'CRLF is recorded as LF'],
    ['A23', 265, 'U+200B is removed'],
  ])('%s: the record at line %i matches what was typed (%s)', (name, n, _why) => {
    expect(claudePromptTextMatches(sent(name), recorded(n))).toBe(true)
  })

  it('does not match a record holding more than was typed', () => {
    // A18's Enter did not submit (U+200B); A19 was pasted into the same box
    // and both went in as one entry.
    expect(recorded(237)).toContain('LONG-A19')
    expect(claudePromptTextMatches(sent('A18'), recorded(237))).toBe(false)
    expect(claudePromptTextMatches(sent('A19'), recorded(237))).toBe(false)
  })

  it('does not match a record that differs in any other way', () => {
    expect(claudePromptTextMatches('ZWSP-A23 zero width', recorded(265))).toBe(false)
    expect(claudePromptTextMatches(sent('A21').replace(' ', ' '), recorded(253))).toBe(false)
    expect(claudePromptTextMatches('', '')).toBe(false)
    expect(claudePromptTextMatches(' \t\n', '')).toBe(false)
  })
})
