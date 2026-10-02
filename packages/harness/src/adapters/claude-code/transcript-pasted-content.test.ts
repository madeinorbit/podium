import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claudeRecordReceipts, claudeRecordToItems } from './transcript.js'

// Actual TUI records, scratch HOME and localhost fake model, on both versions
// seen in production. The cached paste-tag gate is enabled in these runs.
const LANE = fileURLToPath(
  new URL('../../../../../docs/measurements/pod-4982-claude-pasted-content/', import.meta.url),
)
type Measured = {
  case: string
  input: string
  record: {
    uuid: string
    timestamp: string
    version: string
    promptId?: string
    message: { role: string; content: string }
  }
  enqueue?: {
    type: string
    operation: string
    timestamp: string
    content: string
  }
}
const measured: Measured[] = readdirSync(LANE)
  .filter((file) => /-gate-on.*\.jsonl$/.test(file))
  .flatMap((file) =>
    readFileSync(join(LANE, file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Measured),
  )

describe('Claude pasted content recorded text (POD-4982)', () => {
  it.each(measured.map((row) => [row.record.version, row.case, row] as const))(
    '%s %s: shows the submitted words with the native item id',
    (_version, _name, row) => {
      const promptId = (row.record as { promptId?: string }).promptId
      expect(claudeRecordToItems(row.record)).toEqual([
        {
          id: row.record.uuid,
          ts: row.record.timestamp,
          role: 'user',
          text: row.input.trim(),
          ...(promptId ? { harnessRef: [{ kind: 'claude-prompt', id: promptId }] } : {}),
        },
      ])
    },
  )

  // The same recorded text also reaches the array-content and queued-command
  // paths (shapes measured in POD-4862); neither may expose recorder markup.
  it.each(['array', 'queued-string', 'queued-array'] as const)(
    'reads a wrapped prompt through %s without changing its id',
    (shape) => {
      const row = measured.find((row) => row.case === 'multiline-323')
      if (!row) throw new Error('missing wrapped multiline measurement')
      expect(row.record.message.content).toContain('<pasted_content id=')
      const block = { type: 'text', text: row.record.message.content }
      const promptId = (row.record as { promptId?: string }).promptId
      const record =
        shape === 'array'
          ? { ...row.record, type: 'user', message: { role: 'user', content: [block] } }
          : {
              type: 'attachment',
              uuid: row.record.uuid,
              timestamp: row.record.timestamp,
              attachment: {
                type: 'queued_command',
                commandMode: 'prompt',
                origin: { kind: 'human' },
                prompt: shape === 'queued-string' ? block.text : [block],
              },
            }
      expect(claudeRecordToItems(record)).toEqual([
        {
          id: row.record.uuid,
          ts: row.record.timestamp,
          role: 'user',
          text: row.input,
          ...(shape === 'array' && promptId
            ? { harnessRef: [{ kind: 'claude-prompt', id: promptId }] }
            : {}),
        },
      ])
    },
  )

  // A QUEUED paste is recorded TRIMMED (POD-5269, measured on 2.1.283/2.1.285
  // while busy): `<pasted_content id="x">\n<body>\n</pasted_content id="x">`
  // with no leading "\n\n" and no trailing "\n". The reader must accept the
  // wrapper at the start/end of the prompt as well as between separators.
  // Synthetic bodies only -- never the live user's message text.
  it.each([
    [
      '<pasted_content id="abcd">\nqueued synthetic body\n</pasted_content id="abcd">',
      'queued synthetic body',
    ],
    [
      '<pasted_content id="abcd">\nqueued synthetic body\n</pasted_content id="abcd">\n',
      'queued synthetic body',
    ],
    [
      '\n\n<pasted_content id="abcd">\nqueued synthetic body\n</pasted_content id="abcd">',
      'queued synthetic body',
    ],
    [
      'typed prefix: \n\n<pasted_content id="abcd">\nqueued synthetic body\n</pasted_content id="abcd">',
      'typed prefix: queued synthetic body',
    ],
  ])('unwraps the trimmed queued wrapper: %j', (text, expected) => {
    expect(
      claudeRecordToItems({ type: 'user', uuid: 'queued', message: { content: text } }),
    ).toEqual([{ id: 'queued', role: 'user', ts: undefined, text: expected }])
  })

  // A prompt the busy turn absorbs (`queue-operation remove
  // reason=absorbed_mid_turn`) never becomes a `user` record: its only history
  // entry is the queued_command attachment, carrying the same trimmed wrapper
  // (live: POD-5270 audit, 7 cases on 2.1.283).
  it('unwraps the trimmed wrapper in an absorbed queued_command', () => {
    const record = {
      type: 'attachment',
      uuid: 'absorbed',
      timestamp: '2026-10-02T00:00:00.000Z',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        prompt: '<pasted_content id="abcd">\nqueued synthetic body\n</pasted_content id="abcd">',
      },
    }
    expect(claudeRecordToItems(record)).toEqual([
      { id: 'absorbed', ts: '2026-10-02T00:00:00.000Z', role: 'user', text: 'queued synthetic body' },
    ])
  })

  it.each([
    '<pasted_content id="abcd">\nqueued synthetic body\n</pasted_content id="abcd">',
    '\n\n<pasted_content id="abcd">\nqueued synthetic body\n</pasted_content id="abcd">',
  ])('reads the trimmed queued wrapper through queue-operation without markup: %j', (content) => {
    const items = claudeRecordReceipts({ type: 'queue-operation', operation: 'enqueue', content })
    expect(items).toEqual([
      expect.objectContaining({ text: 'queued synthetic body', queued: true }),
    ])
  })

  it('unwraps the measured queued enqueue to the submitted words (POD-5269)', () => {
    const queued = measured.filter((row) => row.enqueue)
    expect(queued.length).toBeGreaterThan(0)
    for (const row of queued) {
      const enqueue = row.enqueue as { content: string }
      expect(enqueue.content).toContain('<pasted_content id=')
      const items = claudeRecordReceipts({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-10-02T00:00:00.000Z',
        content: enqueue.content,
      })
      expect(items).toEqual([
        expect.objectContaining({ text: row.input.trim(), queued: true }),
      ])
    }
  })

  it.each([
    '\n\n<pasted_content id="abcd">\nbody\n</pasted_content id="dcba">\n',
    '\n\n<pasted_content id="abcde">\nbody\n</pasted_content id="abcde">\n',
    '\n\n<pasted_content id="GHIJ">\nbody\n</pasted_content id="GHIJ">\n',
    '\n\n<pasted_content id="abcd">body\n</pasted_content id="abcd">\n',
    '\n\n<pasted_content id="abcd">\nbody </pasted_content id="abcd">\n',
    '\n\n<pasted_content id="abcd">\nbody\n',
  ])('keeps text outside the complete measured wrapper grammar: %j', (text) => {
    expect(
      claudeRecordToItems({ type: 'user', uuid: 'literal', message: { content: text } }),
    ).toEqual([{ id: 'literal', role: 'user', ts: undefined, text: text.trim() }])
  })

  it('leaves assistant text and tool-result output literal', () => {
    const text = measured.find((row) => row.case === 'multiline-323')?.record.message.content
    if (!text) throw new Error('missing wrapped multiline measurement')
    expect(
      claudeRecordToItems({
        type: 'assistant', uuid: 'answer',
        message: { content: [{ type: 'text', text }] },
      })[0]?.text,
    ).toBe(text.trim())
    expect(
      claudeRecordToItems({
        type: 'user', uuid: 'result',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: text }] },
      })[0]?.toolResult,
    ).toBe(text)
  })
})
