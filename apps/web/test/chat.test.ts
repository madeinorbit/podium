import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { blockMatches, minimapSegments, pairToolResults, searchBlocks } from '../src/chat'

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

describe('minimapSegments', () => {
  it('weights longer content heavier and keeps roles', () => {
    const blocks = pairToolResults([
      item({ id: 'u', role: 'user', text: 'short' }),
      item({ id: 'a', role: 'assistant', text: 'x'.repeat(4000) }),
    ])
    const segs = minimapSegments(blocks)
    expect(segs[0]?.role).toBe('user')
    expect((segs[1]?.weight ?? 0) > (segs[0]?.weight ?? 0)).toBe(true)
  })
})
