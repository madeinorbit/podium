import type { ChatRow } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { turnClass } from './ChatBlockView'
import { turnPosition } from './TranscriptFeed'

// TURN STRUCTURE (POD-376). What the feed spaces tightly and what it spaces
// apart — the rule that turns thirty-one identical siblings into exchanges.

const item = (patch: Partial<TranscriptItem>): TranscriptItem =>
  ({ id: 'x', role: 'assistant', text: '', ...patch }) as TranscriptItem

const blockRow = (patch: Partial<TranscriptItem>): ChatRow => ({
  kind: 'block',
  block: { item: item(patch) },
  blockIndex: 0,
})

describe('turnPosition', () => {
  it('binds a tool run to the prose that produced it', () => {
    const run: ChatRow = {
      kind: 'tools',
      blocks: [{ item: item({ role: 'tool', toolName: 'Read' }) }],
      blockIndices: [0],
      title: 'Read a file',
    }
    expect(turnPosition(run)).toBe('bind')
    expect(turnPosition(blockRow({ role: 'tool', toolName: 'Bash' }))).toBe('bind')
    // The turn's own "Churned for …" divider closes the same unit.
    expect(turnPosition(blockRow({ role: 'system', systemKind: 'duration' }))).toBe('bind')
  })

  it('leaves prose, answers and the operator turn on the feed beat', () => {
    expect(turnPosition(blockRow({ role: 'assistant', text: 'narration' }))).toBeUndefined()
    expect(turnPosition(blockRow({ role: 'assistant', answer: true }))).toBeUndefined()
    expect(turnPosition(blockRow({ role: 'user', text: 'do the thing' }))).toBeUndefined()
  })

  it('keeps a question addressed to the human out of the activity band', () => {
    // It stops the turn and waits, so it is not machine activity however it is
    // shaped — including through an MCP server, on any harness.
    expect(turnPosition(blockRow({ role: 'tool', toolName: 'AskUserQuestion' }))).toBeUndefined()
    expect(
      turnPosition(blockRow({ role: 'tool', toolName: 'mcp__impeccable__interview' })),
    ).toBeUndefined()
  })
})

describe('turnClass', () => {
  it('maps a position to the one class that spaces it', () => {
    expect(turnClass('open')).toBe('transcript-turn-open')
    expect(turnClass('bind')).toBe('transcript-turn-bind')
    expect(turnClass(undefined)).toBeUndefined()
  })
})
