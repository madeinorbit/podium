import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './transcript.js'

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
    message: { role: string; content: string }
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
      expect(claudeRecordToItems(row.record)).toEqual([
        { id: row.record.uuid, ts: row.record.timestamp, role: 'user', text: row.input.trim() },
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
        { id: row.record.uuid, ts: row.record.timestamp, role: 'user', text: row.input },
      ])
    },
  )

  it.each([
    '<pasted_content id="abcd">\nquoted example\n</pasted_content id="abcd">',
    '\n\n<pasted_content id="abcd">\nbody\n</pasted_content id="dcba">\n',
    '\n\n<pasted_content id="abcde">\nbody\n</pasted_content id="abcde">\n',
    '\n\n<pasted_content id="GHIJ">\nbody\n</pasted_content id="GHIJ">\n',
    '\n\n<pasted_content id="abcd">body\n</pasted_content id="abcd">\n',
    '\n\n<pasted_content id="abcd">\nbody </pasted_content id="abcd">\n',
    '\n\n<pasted_content id="abcd">\nbody\n',
    '\n\n<pasted_content id="abcd">\nbody\n</pasted_content id="abcd">',
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
