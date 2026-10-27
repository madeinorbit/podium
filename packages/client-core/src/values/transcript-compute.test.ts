import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { isBatchableTool, toolMailCommand } from './chat'
import { computeTranscript } from './transcript-compute'

const item = (
  overrides: Partial<TranscriptItem> & Pick<TranscriptItem, 'id' | 'role'>,
): TranscriptItem => ({
  text: '',
  ...overrides,
})

describe('computeTranscript', () => {
  it('returns one paired graph and search state for the loaded window', () => {
    const items = [
      item({ id: 'u1', role: 'user', text: 'Please inspect this' }),
      item({ id: 'a1', role: 'assistant', text: 'The NEEDLE is in the result' }),
    ]

    const result = computeTranscript({
      items,
      verbosity: 'normal',
      query: 'needle',
      cursor: 0,
    })

    expect(result.blocks.map((block) => block.item.id)).toEqual(['u1', 'a1'])
    expect(result.rows).toHaveLength(2)
    expect(result.search).toMatchObject({
      matches: [1],
      activeMatch: 1,
      activeRow: 1,
      position: 1,
      total: 1,
      filtering: true,
    })
  })

  it('applies summary filtering before the platform maps rows', () => {
    const result = computeTranscript({
      items: [
        item({ id: 'u1', role: 'user', text: 'Run it' }),
        item({
          id: 't1',
          role: 'tool',
          toolName: 'Bash',
          toolInput: 'bun test',
          toolResult: 'ok',
        }),
        item({ id: 'a1', role: 'assistant', text: 'Done', answer: true }),
      ],
      verbosity: 'summary',
      query: '',
      cursor: 0,
    })

    expect(
      result.rows.map((row) =>
        row.kind === 'block' ? row.block.item.id : (row.blocks[0]?.item.id ?? 'missing'),
      ),
    ).toEqual(['u1', 'a1'])
  })

  /**
   * FILE ORDER IS NOT TURN ORDER [POD-4639]. Claude Code writes the synthetic
   * "Not logged in" reply to its JSONL BEFORE the prompt that caused it (the
   * real bytes, from a signed-out launch: reply at 07:26:46.376, prompt stamped
   * 07:26:45.756 on the line after). Cursors must stay byte order, so the fix is
   * here, where rows are shaped: a prompt lifts above the replies stamped after it.
   */
  describe('a prompt written after its own reply', () => {
    const ids = (items: TranscriptItem[]) =>
      computeTranscript({ items, verbosity: 'normal', query: '', cursor: 0 }).blocks.map(
        (block) => block.item.id,
      )

    it('renders the prompt before the reply the harness flushed first', () => {
      expect(
        ids([
          item({ id: 'u0', role: 'user', ts: '2026-09-23T07:20:00.000Z', text: 'earlier' }),
          item({ id: 'a0', role: 'assistant', ts: '2026-09-23T07:20:05.000Z', text: 'ok' }),
          item({
            id: 'err',
            role: 'assistant',
            ts: '2026-09-23T07:26:46.376Z',
            text: 'Not logged in · Please run /login',
          }),
          item({
            id: 'u1',
            role: 'user',
            ts: '2026-09-23T07:26:45.756Z',
            text: 'What is 8 times 9?',
          }),
        ]),
      ).toEqual(['u0', 'a0', 'u1', 'err'])
    })

    it('keeps file order when the prompt is stamped after the reply above it', () => {
      expect(
        ids([
          item({ id: 'a0', role: 'assistant', ts: '2026-09-23T07:26:45.000Z', text: 'done' }),
          item({ id: 'u1', role: 'user', ts: '2026-09-23T07:26:46.000Z', text: 'next' }),
        ]),
      ).toEqual(['a0', 'u1'])
    })

    it('never lifts a prompt past an unstamped item', () => {
      expect(
        ids([
          item({ id: 'u0', role: 'user', ts: '2026-09-23T07:26:47.000Z', text: 'first' }),
          item({ id: 'x', role: 'assistant', text: 'no stamp' }),
          item({ id: 'u1', role: 'user', ts: '2026-09-23T07:26:45.000Z', text: 'second' }),
        ]),
      ).toEqual(['u0', 'x', 'u1'])
    })

    it('never lifts a prompt past another prompt, whatever their stamps say', () => {
      expect(
        ids([
          item({ id: 'u0', role: 'user', ts: '2026-09-23T07:26:47.000Z', text: 'first' }),
          item({ id: 'u1', role: 'user', ts: '2026-09-23T07:26:45.000Z', text: 'second' }),
        ]),
      ).toEqual(['u0', 'u1'])
    })
  })
})

// The agent's own mail (POD-2146), in the shape each harness adapter emits.
describe('computeTranscript: mail the agent sent', () => {
  const send = `podium issue mail send POD-2128 --body 'Ready for review'`
  const shapes: Array<[string, Partial<TranscriptItem>]> = [
    // Claude Bash keeps the full command as a shell-command payload.
    [
      'Claude Bash',
      {
        toolName: 'Bash',
        toolInput: send,
        toolInputJson: JSON.stringify({ kind: 'shell-command', command: send }),
      },
    ],
    // A Codex exec wrapping one exec_command renders as that call.
    ['Codex single call', { toolName: 'Bash', toolInput: send }],
  ]
  for (const [name, call] of shapes) {
    it(`a ${name} send leaves the work run as its own row`, () => {
      const { rows } = computeTranscript({
        items: [
          item({ id: 'r', role: 'tool', toolName: 'Read', toolInput: 'a.ts', toolUseId: 'r' }),
          item({ id: 's', role: 'tool', toolUseId: 's', ...call }),
          item({
            id: 's-out',
            role: 'tool',
            toolUseId: 's',
            toolResult: 'mail DELIVERED to POD-2128 (msg_1) — confirmed in the recipient’s context',
          }),
          item({ id: 'b', role: 'tool', toolName: 'Bash', toolInput: 'ls', toolUseId: 'b' }),
        ],
        verbosity: 'summary',
        query: '',
        cursor: 0,
      })
      // The read and the ls are quiet work and drop out of summary; the note stays.
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row?.kind === 'block' && toolMailCommand(row.block.item)).toEqual({
        op: 'send',
        to: 'issue:POD-2128',
        preview: 'Ready for review',
      })
    })
  }

  it('a Codex Script with a send inside stays one Script row', () => {
    const { rows } = computeTranscript({
      items: [
        item({
          id: 'x',
          role: 'tool',
          toolName: 'Script',
          toolTitle: '2 commands',
          toolInputJson: JSON.stringify({
            kind: 'script-calls',
            calls: [
              { tool: 'Bash', input: 'git status' },
              { tool: 'Bash', input: send },
            ],
          }),
        }),
      ],
      verbosity: 'normal',
      query: '',
      cursor: 0,
    })
    expect(rows).toEqual([expect.objectContaining({ kind: 'tools' })])
  })

  it('an echo of a send is an ordinary command', () => {
    const echo = item({ id: 'e', role: 'tool', toolName: 'Bash', toolInput: `echo "${send}"` })
    expect(isBatchableTool(echo)).toBe(true)
    expect(toolMailCommand(echo)).toBeNull()
  })
})
