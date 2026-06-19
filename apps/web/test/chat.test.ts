import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { blockMatches, pairToolResults, ticksFromOffsets, type PendingItem, reconcilePending, searchBlocks } from '../src/chat'
import { shouldPinOnReset } from '../src/ChatView'

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
  it('maps block offsets to linear tick ratios matching scroll space', () => {
    const blocks = [
      { item: { role: 'user', answer: false } },
      { item: { role: 'assistant', answer: true } },
    ] as any
    const offsets = [
      { index: 0, top: 0, height: 0.1 },
      { index: 1, top: 0.1, height: 0.9 },
    ]
    const ticks = ticksFromOffsets(blocks, offsets)
    expect(ticks[0]).toMatchObject({ role: 'user', top: 0, height: 0.1 })
    expect(ticks[1]).toMatchObject({ role: 'assistant', answer: true, top: 0.1 })
  })

  it('skips blocks with no matching offset', () => {
    const blocks = [
      { item: { role: 'user', answer: false } },
      { item: { role: 'assistant', answer: false } },
    ] as any
    const offsets = [{ index: 1, top: 0.5, height: 0.5 }]
    const ticks = ticksFromOffsets(blocks, offsets)
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toMatchObject({ index: 1, role: 'assistant', top: 0.5 })
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
