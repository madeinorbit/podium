import { shouldPinOnReset } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  blockMatches,
  buildChatRows,
  type PendingItem,
  pairToolResults,
  reconcilePending,
  searchBlocks,
  ticksFromOffsets,
  toolBatchTitle,
} from '../src/features/chat/chat'

const item = (over: Partial<TranscriptItem>): TranscriptItem => ({
  id: Math.random().toString(36).slice(2),
  role: 'assistant',
  text: '',
  ...over,
})

describe('pairToolResults', () => {
  it('folds a result into its tool call by toolUseId', () => {
    const call = item({ id: 'c', role: 'tool', toolName: 'Bash', toolUseId: 't1' })
    const result = item({ id: 'r', role: 'tool', toolResult: 'done', toolUseId: 't1' })
    const blocks = pairToolResults([call, result])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ item: { id: 'c' }, result: 'done' })
  })

  it('keeps orphan results visible standalone', () => {
    const orphan = item({ id: 'r', role: 'tool', toolResult: 'late', toolUseId: 'gone' })
    expect(pairToolResults([orphan])).toHaveLength(1)
  })

  it('passes user/assistant items through in order', () => {
    const blocks = pairToolResults([
      item({ id: 'u', role: 'user', text: 'hi' }),
      item({ id: 'a', role: 'assistant', text: 'hello' }),
    ])
    expect(blocks.map((b) => b.item.id)).toEqual(['u', 'a'])
  })
})

describe('search', () => {
  const blocks = pairToolResults([
    item({ id: 'u', role: 'user', text: 'fix the keyboard bug' }),
    item({
      id: 't',
      role: 'tool',
      toolName: 'Bash',
      toolInput: 'bun test keyboard',
      toolUseId: 'x',
    }),
    item({ id: 'a', role: 'assistant', text: 'All green.' }),
  ])
  it('matches text, tool names, and tool inputs case-insensitively', () => {
    expect(searchBlocks(blocks, 'KEYBOARD')).toEqual([0, 1])
    expect(searchBlocks(blocks, 'green')).toEqual([2])
    expect(searchBlocks(blocks, '')).toEqual([])
  })
  it('blockMatches mirrors the same predicate', () => {
    expect(blockMatches(blocks[0], 'fix the')).toBe(true)
    expect(blockMatches(blocks[2], 'fix the')).toBe(false)
  })
})

describe('ticksFromOffsets', () => {
  it('maps row metadata to linear tick ratios matching scroll space', () => {
    const metas = [
      { role: 'user' as const, answer: false },
      { role: 'assistant' as const, answer: true },
    ]
    const offsets = [
      { index: 0, top: 0, height: 0.1 },
      { index: 1, top: 0.1, height: 0.9 },
    ]
    const ticks = ticksFromOffsets(metas, offsets)
    expect(ticks[0]).toMatchObject({ role: 'user', top: 0, height: 0.1 })
    expect(ticks[1]).toMatchObject({ role: 'assistant', answer: true, top: 0.1 })
  })

  it('skips rows with no matching offset', () => {
    const metas = [
      { role: 'user' as const, answer: false },
      { role: 'assistant' as const, answer: false },
    ]
    const offsets = [{ index: 1, top: 0.5, height: 0.5 }]
    const ticks = ticksFromOffsets(metas, offsets)
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toMatchObject({ index: 1, role: 'assistant', top: 0.5 })
  })
})

describe('buildChatRows', () => {
  const tool = (toolName: string, over: Partial<TranscriptItem> = {}) =>
    item({ role: 'tool', toolName, ...over })

  it('folds a run of consecutive tool calls into one batch row, breaking on text', () => {
    const blocks = pairToolResults([
      item({ role: 'user', text: 'go' }),
      tool('Read'),
      tool('Read'),
      tool('Bash'),
      item({ role: 'assistant', text: 'done', answer: true }),
    ])
    const rows = buildChatRows(blocks)
    expect(rows.map((r) => r.kind)).toEqual(['block', 'tools', 'block'])
    const batch = rows[1]
    expect(batch.kind === 'tools' && batch.blocks).toHaveLength(3)
    expect(batch.kind === 'tools' && batch.title).toBe('Read 2 files, ran a command')
    // blockIndices map back into the flat stream so search can find the row.
    expect(batch.kind === 'tools' && batch.blockIndices).toEqual([1, 2, 3])
  })

  it('keeps an AskUserQuestion as its own row (it breaks a batch)', () => {
    const blocks = pairToolResults([tool('Bash'), tool('AskUserQuestion'), tool('Bash')])
    expect(buildChatRows(blocks).map((r) => r.kind)).toEqual(['tools', 'block', 'tools'])
  })
})

describe('toolBatchTitle', () => {
  const tool = (toolName: string, over: Partial<TranscriptItem> = {}) => ({
    item: item({ role: 'tool', toolName, ...over }),
  })
  const title = (...names: string[]) => toolBatchTitle(names.map((n) => tool(n)))

  it('counts a single tool kind', () => {
    expect(title('Bash', 'Bash', 'Bash', 'Bash', 'Bash')).toBe('Ran 5 commands')
    expect(title('Write', 'Write', 'Write', 'Write')).toBe('Created 4 files')
    expect(title('Read', 'Read', 'Read')).toBe('Read 3 files')
  })

  it('joins mixed kinds in first-appearance order, only the first capitalized', () => {
    expect(title('Read', 'Read', 'Bash')).toBe('Read 2 files, ran a command')
    expect(title('Bash', 'Read')).toBe('Ran a command, read a file')
    expect(title('Bash', 'Task', 'Task', 'Task')).toBe('Ran a command, ran 3 agents')
  })

  it('quotes a lone command using the agent description, then the shell, else generic', () => {
    expect(
      toolBatchTitle([tool('Bash', { toolTitle: 'Render the three chat-view mockups to PNG' })]),
    ).toBe('Ran "Render the three chat-view mockups to PNG"')
    expect(toolBatchTitle([tool('Bash', { toolInput: 'bun test' })])).toBe('Ran "bun test"')
    expect(toolBatchTitle([tool('Bash')])).toBe('Ran a command')
  })

  it('uses the generic article form for a lone file op', () => {
    expect(title('Read')).toBe('Read a file')
    expect(title('Write')).toBe('Created a file')
    expect(title('Edit')).toBe('Edited a file')
    expect(title('Task')).toBe('Ran an agent')
  })
})

const pend = (text: string, id = text): PendingItem => ({ id, text, at: 0, state: 'sending' })

describe('shouldPinOnReset', () => {
  it('always re-pins on a reset regardless of current pin state', () => {
    expect(shouldPinOnReset(true, false)).toBe(true)
    expect(shouldPinOnReset(true, true)).toBe(true)
  })
  it('preserves the current pin state on an incremental append', () => {
    expect(shouldPinOnReset(false, true)).toBe(true)
    expect(shouldPinOnReset(false, false)).toBe(false)
  })
})

describe('reconcilePending', () => {
  it('drops a pending entry once a matching new user text appears', () => {
    const out = reconcilePending([pend('run the tests')], ['run the tests'])
    expect(out).toEqual([])
  })
  it('keeps pending entries with no matching new user text', () => {
    const out = reconcilePending([pend('hello')], ['something else'])
    expect(out).toEqual([pend('hello')])
  })
  it('consumes one real occurrence per pending (FIFO) for duplicate texts', () => {
    const out = reconcilePending([pend('ok', 'a'), pend('ok', 'b')], ['ok'])
    expect(out).toEqual([pend('ok', 'b')])
  })
  it('matches on trimmed text', () => {
    expect(reconcilePending([pend('hi')], ['  hi  '])).toEqual([])
  })
})
