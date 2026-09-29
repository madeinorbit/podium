import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { opencodePromptTextMatches } from './transcript.js'

const lane = new URL(
  '../../../../../docs/measurements/pod-4834-receipt-proof/opencode-1.18.33/tui/',
  import.meta.url,
)
const history = JSON.parse(readFileSync(new URL('session-history-final.json', lane), 'utf8')) as {
  role: string
  parts: string
}[]
const recordedText = (prefix: string): string => {
  const texts = history
    .filter((message) => message.role === 'user')
    .flatMap((message) => JSON.parse(message.parts) as { type: string; text?: string }[])
    .filter((part) => part.type === 'text' && part.text?.startsWith(prefix))
  expect(texts).toHaveLength(1)
  const text = texts[0]?.text
  if (text === undefined) throw new Error(`Missing measured text for ${prefix}`)
  return text
}

describe('OpenCode measured text tolerance', () => {
  it('preserves spaces on a normally typed prompt', () => {
    const input = '  S7 lead and trail spaces  '
    expect(recordedText('  S7 lead')).toBe(input)
    expect(opencodePromptTextMatches(input, input)).toBe(true)
  })

  it('allows the final newline of the measured multiline paste to become one space', () => {
    const pasted = readFileSync(new URL('paste-ml.txt', lane), 'utf8')
    const recorded = recordedText('S7 PASTE')
    expect(pasted.endsWith('\n')).toBe(true)
    expect(recorded).toBe(`${pasted.slice(0, -1)} `)
    expect(opencodePromptTextMatches(pasted, recorded)).toBe(true)
  })

  it('allows one appended space on the measured long single-line paste', () => {
    // The lane retained the full pasted part in prompt-history; that file alone
    // is not receipt proof. Compare it to the independently recorded user part.
    const promptHistory = readFileSync(new URL('prompt-history.jsonl', lane), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const pasted = promptHistory
      .flatMap((entry) => entry.parts)
      .find((part) => part.type === 'text' && part.text.startsWith('S7 LONGPASTE')).text
    // Both committed history snapshots abbreviate long text. The fake-model
    // request retains the full content, and the native part's suffix records
    // its unabridged length. Neither is used here to classify a prompt entry.
    const requests = readFileSync(new URL('model-requests.jsonl', lane), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const recorded = requests
      .flatMap((request) => request.messages)
      .find(
        (message) => message.role === 'user' && message.content.startsWith('S7 LONGPASTE'),
      ).content
    const timeline = readFileSync(new URL('timeline.jsonl', lane), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const native = timeline.find(
      (entry) =>
        entry.kind === 'db' &&
        entry.table === 'part' &&
        entry.row.data.text?.startsWith('S7 LONGPASTE'),
    ).row.data.text
    expect(pasted.length).toBe(16_902)
    expect(native.endsWith('…(16903 chars)')).toBe(true)
    expect(recorded).toBe(`${pasted} `)
    expect(opencodePromptTextMatches(pasted, recorded)).toBe(true)
  })

  it.each([
    ['prompt', 'prompt  '],
    ['prompt ', 'prompt'],
    [' prompt', 'prompt'],
    ['prompt\n', 'prompt'],
    ['one\n\ntwo', 'one\ntwo '],
    ['one\ttwo', 'one    two '],
    ['one  two', 'one two'],
    ['one\r\ntwo', 'one\ntwo'],
    ['e\u0301', 'é'],
    ['x\u200by', 'xy'],
    ['prompt', 'prompt extra'],
    ['', ' '],
  ])('rejects an unmeasured change from %j to %j', (submitted, recorded) => {
    expect(opencodePromptTextMatches(submitted, recorded)).toBe(false)
  })
})
