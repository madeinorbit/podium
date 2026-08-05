import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { ChatRow } from './chat'
import { applyChatVerbosity, parseChatVerbosity, rowSurvivesSummary } from './chat-verbosity'

const item = (over: Partial<TranscriptItem>): TranscriptItem => ({
  id: over.id ?? 'x',
  role: over.role ?? 'assistant',
  text: over.text ?? '',
  ...over,
})

const blockRow = (over: Partial<TranscriptItem>): ChatRow => ({
  kind: 'block',
  block: { item: item(over) },
  blockIndex: 0,
})

const toolsRow = (results: (string | undefined)[]): ChatRow => ({
  kind: 'tools',
  blocks: results.map((result, i) => ({
    item: item({ id: `t${i}`, role: 'tool', toolName: 'Bash' }),
    ...(result !== undefined ? { result } : {}),
  })),
  blockIndices: results.map((_, i) => i),
  title: 'Ran commands',
})

describe('parseChatVerbosity', () => {
  it('defaults to normal so an untouched device sees today’s feed', () => {
    expect(parseChatVerbosity(null)).toBe('normal')
    expect(parseChatVerbosity(undefined)).toBe('normal')
    expect(parseChatVerbosity('nonsense')).toBe('normal')
  })
  it('reads the two non-default modes', () => {
    expect(parseChatVerbosity('summary')).toBe('summary')
    expect(parseChatVerbosity('verbose')).toBe('verbose')
  })
})

describe('summary keeps what the reader is actually asking for', () => {
  it('keeps prompts and prose', () => {
    expect(rowSurvivesSummary(blockRow({ role: 'user', text: 'do the thing' }))).toBe(true)
    expect(rowSurvivesSummary(blockRow({ role: 'assistant', text: 'done', answer: true }))).toBe(
      true,
    )
  })
  it('keeps a call that addressed the human, on any harness', () => {
    expect(rowSurvivesSummary(blockRow({ role: 'tool', toolName: 'AskUserQuestion' }))).toBe(true)
    expect(rowSurvivesSummary(blockRow({ role: 'tool', toolName: 'mcp__x__interview' }))).toBe(true)
  })
  it('drops a run in which everything succeeded', () => {
    expect(rowSurvivesSummary(toolsRow(['ok', 'fine']))).toBe(false)
    expect(rowSurvivesSummary(toolsRow([undefined]))).toBe(false)
  })
  // Failure is never hidden by a fold, and must not be hidden by a mode either.
  it('keeps a run that contains a failure', () => {
    expect(rowSurvivesSummary(toolsRow(['ok', 'error: boom']))).toBe(true)
    expect(rowSurvivesSummary(toolsRow(['exit code 1']))).toBe(true)
  })
})

describe('applyChatVerbosity', () => {
  const rows: ChatRow[] = [
    blockRow({ role: 'user', text: 'go' }),
    toolsRow(['ok']),
    blockRow({ role: 'assistant', text: 'done', answer: true }),
  ]

  it('is referentially inert outside summary — verbose changes rendering, not rows', () => {
    expect(applyChatVerbosity(rows, 'normal')).toBe(rows)
    expect(applyChatVerbosity(rows, 'verbose')).toBe(rows)
  })

  it('drops quiet successful work in summary', () => {
    const out = applyChatVerbosity(rows, 'summary')
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.kind === 'block')).toBe(true)
  })

  it('returns the same array when summary drops nothing', () => {
    const onlyProse = [rows[0]!, rows[2]!]
    expect(applyChatVerbosity(onlyProse, 'summary')).toBe(onlyProse)
  })
})
