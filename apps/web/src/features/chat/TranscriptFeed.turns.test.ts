import type { ChatRow } from '@podium/client-core/viewmodels'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { processClass, turnClass } from './ChatBlockView'
import { isProcessRow, processPosition, turnPosition } from './TranscriptFeed'

// TURN STRUCTURE (POD-376). What the feed spaces tightly and what it spaces
// apart — the rule that turns thirty-one identical siblings into exchanges.

const item = (patch: Partial<TranscriptItem>): TranscriptItem =>
  ({ id: 'x', role: 'assistant', text: '', ...patch }) as TranscriptItem

const blockRow = (patch: Partial<TranscriptItem>): ChatRow => ({
  kind: 'block',
  block: { item: item(patch) },
  blockIndex: 0,
})

const toolRun = (): ChatRow => ({
  kind: 'tools',
  blocks: [{ item: item({ role: 'tool', toolName: 'Read' }) }],
  blockIndices: [0],
  title: 'Read a file',
})

describe('turnPosition', () => {
  it('binds a tool run to the prose that produced it', () => {
    const run = toolRun()
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

describe('processPosition', () => {
  it('groups public narration and tools without folding either one', () => {
    const narration = blockRow({ role: 'assistant', text: 'I am checking the parser.' })
    const tools = toolRun()

    expect(isProcessRow(narration)).toBe(true)
    expect(processPosition(narration, undefined)).toBe('start')
    expect(processPosition(tools, narration)).toBe('continue')
    expect(processClass('start')).toContain('transcript-process-start')
    expect(processClass('continue')).toBe('transcript-process-row')
  })

  it('ends the process region before answers, prompts, and human questions', () => {
    const tools = toolRun()
    expect(processPosition(blockRow({ role: 'assistant', answer: true }), tools)).toBeUndefined()
    expect(processPosition(blockRow({ role: 'user', text: 'continue' }), tools)).toBeUndefined()
    expect(
      processPosition(blockRow({ role: 'tool', toolName: 'AskUserQuestion' }), tools),
    ).toBeUndefined()
    expect(
      processPosition(blockRow({ role: 'system', systemKind: 'duration' }), tools),
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
