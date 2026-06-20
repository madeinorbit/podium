import type { TranscriptItem } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { buildChatRows, isBatchableTool, pairToolResults } from './chat'

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
