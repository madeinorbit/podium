import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  buildChatRows,
  dedupeByCursor,
  isBatchableTool,
  mergeByCursor,
  pairToolResults,
} from './chat'

const tool = (toolName: string, id: string): TranscriptItem => ({
  id,
  role: 'tool',
  text: '',
  toolName,
})

describe('isBatchableTool', () => {
  it('folds ordinary tools', () => {
    expect(isBatchableTool(tool('Read', 'r'))).toBe(true)
  })
  it('does not fold AskUserQuestion or SendUserFile', () => {
    expect(isBatchableTool(tool('AskUserQuestion', 'a'))).toBe(false)
    expect(isBatchableTool(tool('SendUserFile', 's'))).toBe(false)
  })
})

describe('buildChatRows with SendUserFile', () => {
  it('renders SendUserFile as its own row, breaking a tool run', () => {
    const blocks = pairToolResults([
      tool('Read', 'r1'),
      tool('SendUserFile', 'suf'),
      tool('Read', 'r2'),
    ])
    const rows = buildChatRows(blocks)
    // Read | SendUserFile (single) | Read — three rows, SendUserFile not folded.
    expect(rows.map((r) => r.kind)).toEqual(['tools', 'block', 'tools'])
    const mid = rows[1]
    expect(mid?.kind === 'block' && mid.block.item.toolName).toBe('SendUserFile')
  })
})

const it_ = (id: string, cursor?: string): TranscriptItem => ({
  id,
  ...(cursor !== undefined ? { cursor } : {}),
  role: 'assistant',
  text: id,
})

describe('mergeByCursor', () => {
  it('appends delta items not already present (by cursor)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeByCursor(prev, [it_('c', 'c3')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes a delta item whose cursor is already in prev (live repeats read window)', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    // c2 repeats the last read-window item; only the genuinely new c3 appends.
    const merged = mergeByCursor(prev, [it_('b', 'c2'), it_('c', 'c3')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns prev unchanged when every delta item is a duplicate', () => {
    const prev = [it_('a', 'c1'), it_('b', 'c2')]
    const merged = mergeByCursor(prev, [it_('b', 'c2')])
    expect(merged).toBe(prev)
  })

  it('falls back to id when a cursor is missing', () => {
    const prev = [it_('a')]
    const merged = mergeByCursor(prev, [it_('a'), it_('b')])
    expect(merged.map((i) => i.id)).toEqual(['a', 'b'])
  })
})

describe('dedupeByCursor', () => {
  it('drops later items sharing a cursor with an earlier one (paging/live seam)', () => {
    // [...older, ...items] where the boundary item overlaps.
    const seam = [it_('a', 'c1'), it_('b', 'c2'), it_('b', 'c2'), it_('c', 'c3')]
    expect(dedupeByCursor(seam).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('preserves order and items without cursors (dedupes by id)', () => {
    const list = [it_('a'), it_('a'), it_('b', 'c2')]
    expect(dedupeByCursor(list).map((i) => i.id)).toEqual(['a', 'b'])
  })
})
