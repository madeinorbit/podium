import { classifyMailCommand } from '@podium/commands/mail-command'
import type { TranscriptItem } from '@podium/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptGraph } from '../conversation/transcript-graph'
import {
  isBatchableTool,
  isQuietNote,
  isStretchItem,
  presentToolBlock,
  toolActivityCount,
  toolCategory,
  toolMailCommand,
  toolSubject,
  transcriptActivityFacts,
} from './chat'
import { parseEnvelopeBatch } from './message-envelope'

vi.mock('./message-envelope', async (original) => {
  const actual = await original<typeof import('./message-envelope')>()
  return { ...actual, parseEnvelopeBatch: vi.fn(actual.parseEnvelopeBatch) }
})
vi.mock('@podium/commands/mail-command', async (original) => {
  const actual = await original<typeof import('@podium/commands/mail-command')>()
  return { ...actual, classifyMailCommand: vi.fn(actual.classifyMailCommand) }
})

const frame = (id: string, to = 'issue:POD-34', question = false): string =>
  `[podium message ${id} · from issue:POD-12 · to ${to}]\nReady for review\n${question ? '[this is a question: answer the sender]\n' : ''}[end podium message ${id}]`
const note = (text = `${frame('one')}\n${frame('two')}`): TranscriptItem => ({
  id: 'note',
  role: 'user',
  text,
})
const mail = (): TranscriptItem => ({
  id: 'mail',
  role: 'tool',
  text: '',
  toolName: 'Bash',
  toolInput: 'podium issue mail send POD-12 --body "Ready for review"',
})

beforeEach(() => vi.clearAllMocks())

describe('shared activity facts', () => {
  it('parses received notes once across membership, counts and rendering reads', () => {
    const item = note()
    const facts = transcriptActivityFacts(item)
    expect(facts.envelopes?.envelopes.map((envelope) => envelope.id)).toEqual(['one', 'two'])
    expect(facts.envelopes?.operatorText).toBe('')
    expect(isQuietNote(item)).toBe(true)
    expect(isStretchItem(item)).toBe(true)
    expect(toolActivityCount(item)).toBe(2)
    expect(transcriptActivityFacts(item)).toBe(facts)
    expect(parseEnvelopeBatch).toHaveBeenCalledTimes(1)
  })

  it('keeps operator questions and accompanying human prose outside stretches', () => {
    expect(isStretchItem(note(frame('ask', 'the operator', true)))).toBe(false)
    expect(isStretchItem(note(frame('agent-ask', 'issue:POD-34', true)))).toBe(true)
    const mixed = note(`${frame('note')}\n\nPlease wait before landing.`)
    expect(isStretchItem(mixed)).toBe(false)
    expect(transcriptActivityFacts(mixed).envelopes?.operatorText).toBe(
      'Please wait before landing.',
    )
  })

  it('shares parsed mail between category, subject, membership and block presentation', () => {
    const item = mail()
    expect(toolCategory(item)).toEqual({ verb: 'Sent', noun: 'note' })
    expect(toolSubject(item)).toBeUndefined()
    expect(isBatchableTool(item)).toBe(false)
    expect(isStretchItem(item)).toBe(true)
    expect(toolActivityCount(item)).toBe(1)
    expect(toolMailCommand(item)?.op).toBe('send')
    expect(presentToolBlock({ item }).mail?.op).toBe('note')
    expect(classifyMailCommand).toHaveBeenCalledTimes(1)
  })

  it('invalidates replacement revisions without conflating identical IDs', () => {
    const item = note()
    const before = transcriptActivityFacts(item)
    const replacement = { ...item, text: 'A human follow-up.' }
    expect(transcriptActivityFacts(replacement).stretch).toBe(false)
    expect(transcriptActivityFacts(item)).toBe(before)
    expect(before.eventCount).toBe(2)
    expect(toolActivityCount(replacement)).toBe(1)
    expect(parseEnvelopeBatch).toHaveBeenCalledTimes(2)
  })

  it('invalidates in-place classification inputs but ignores result-only changes', () => {
    const item = mail()
    const before = transcriptActivityFacts(item)
    item.toolResult = 'error: failed'
    expect(transcriptActivityFacts(item)).toBe(before)
    expect(presentToolBlock({ item }).mail).toBeUndefined()
    item.toolInput = 'git status'
    expect(toolMailCommand(item)).toBeNull()
    expect(toolSubject(item)).toBe('git status')
    expect(isBatchableTool(item)).toBe(true)
    item.toolInputJson = JSON.stringify({ kind: 'shell-command', command: 'podium mail inbox' })
    expect(toolMailCommand(item)?.op).toBe('inbox')
    const received = note()
    expect(isQuietNote(received)).toBe(true)
    received.text = 'Please stop.'
    expect(isQuietNote(received)).toBe(false)
    received.role = 'tool'
    received.toolName = 'AskUserQuestion'
    expect(isStretchItem(received)).toBe(false)
  })

  it('reuses ingestion facts and refreshes row membership after an item revision', () => {
    const item = note()
    const command: TranscriptItem = { id: 'command', role: 'tool', text: '', toolName: 'Read' }
    const graph = new TranscriptGraph([item, command])
    try {
      expect(graph.run('note')?.count).toBe(2)
      expect(graph.run('note')?.summary).toContain('2 notes')
      expect(transcriptActivityFacts(graph.block('note')!.item).envelopes?.envelopes).toHaveLength(
        2,
      )
      expect(parseEnvelopeBatch).toHaveBeenCalledTimes(1)
      graph.apply({ changed: [{ ...item, text: 'A human follow-up.' }] })
      expect(graph.structuralRows.map((row) => row.kind)).toEqual(['block', 'tools'])
      expect(graph.run('command')?.count).toBe(1)
      expect(parseEnvelopeBatch).toHaveBeenCalledTimes(2)
    } finally {
      graph.dispose()
    }
  })
})
