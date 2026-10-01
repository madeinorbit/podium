import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { podiumFrameId } from '../../accept-correlation.js'
import { codexManifest } from './index.js'
import { codexPromptTextMatches, codexRecordToItems } from './transcript.js'

// POD-4984, Codex 0.159.0: the sent corpus is matrix.ts; recorded text below
// comes from completed native UserMessage objects, never the edit history.
const corpus = new URL(
  '../../../../../docs/measurements/pod-4834-receipt-proof/expanded-input/',
  import.meta.url,
)
const bodies = {
  tabs: 'P4984-tabs\tmiddle\tindented\tEND-tabs',
  crlf: 'P4984-crlf line-1\r\nP4984-crlf line-2\r\nP4984-crlf END',
  'trailing-lf': 'P4984-trailing-lf first\nP4984-trailing-lf END\n',
}
const frameIds = {
  tabs: 'msg_54e39917-0723-4000-8000-1decc0ae1649',
  crlf: 'msg_cb4f2ef3-3b5f-4000-8000-e1088a26b8bd',
  'trailing-lf': 'msg_5c9dbf33-f40f-4000-8000-cf483c4f2404',
}
type Shape = keyof typeof bodies
const submittedText = (shape: Shape, framed: boolean): string =>
  framed
    ? `[podium message ${frameIds[shape]} · from agent · to you]\n${bodies[shape]}\n[end podium message ${frameIds[shape]}]`
    : bodies[shape]

interface NativeRecord {
  label: string
  kind: string
  raw: unknown
  texts: string[]
}
interface CaptureSummary {
  label: string
  inputBytes: number
  inputSha256: string
}
const readJsonLines = <T>(path: string): T[] =>
  readFileSync(new URL(path, corpus), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)

// Literal UTF-8 lengths pin the measured alternatives independently of the
// matching implementation. All six control-byte cases have prompt records.
const paths = [
  { lane: 'codex-terminal', method: 'paste', bytes: [35, 179, 50, 194, 45, 190] },
  { lane: 'codex-terminal', method: 'typed', bytes: [35, 179, 52, 196, 45, 190] },
  { lane: 'codex-terminal-raw', method: 'typed-buffer', bytes: [35, 179, 52, 196, 45, 190] },
  { lane: 'codex-terminal-paced', method: 'typed-paced', bytes: [35, 176, 52, 194, 45, 190] },
]

for (const { lane, method, bytes } of paths) {
  const records = readJsonLines<NativeRecord>(`${lane}/native-records.jsonl`)
  const summaries = readJsonLines<CaptureSummary>(`${lane}/summary.jsonl`)
  const cases = (Object.keys(bodies) as Shape[]).flatMap((shape) =>
    [false, true].map((framed) => ({
      name: `${shape}-${framed ? 'frame' : 'plain'}`,
      shape,
      framed,
    })),
  )

  describe(`Codex captured ${method} text`, () => {
    it.each(cases.map((input, index) => ({ ...input, storedBytes: bytes[index] })))(
      'matches the completed $name record ($storedBytes bytes)',
      ({ name, shape, framed, storedBytes }) => {
        const label = `${method}/${name}`
        const submitted = submittedText(shape, framed)
        const summary = summaries.find((entry) => entry.label === label)
        expect(summary).toBeDefined()
        expect(Buffer.byteLength(submitted)).toBe(summary?.inputBytes)
        expect(createHash('sha256').update(submitted).digest('hex')).toBe(
          summary?.inputSha256,
        )

        const captured = records.filter((entry) => entry.kind === 'prompt' && entry.label === label)
        expect(captured).toHaveLength(1)
        const native = captured[0]
        if (!native) throw new Error(`Missing captured prompt: ${label}`)
        expect(native.raw).toMatchObject({
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'UserMessage' } },
        })
        expect(native.texts).toHaveLength(1)
        const recorded = native.texts[0]
        if (recorded === undefined) throw new Error(`Missing captured text: ${label}`)
        expect(Buffer.byteLength(recorded)).toBe(storedBytes)

        const items = codexRecordToItems(native.raw)
        expect(items).toHaveLength(1)
        const item = items[0]
        if (!item) throw new Error(`Missing prompt entry: ${label}`)
        expect(item.text).toBe(recorded.trim())
        expect(item.promptEntry).toBe(true)
        const correlation = codexManifest.runtime.terminal.acceptCorrelation?.['transcript-echo']
        if (!correlation) throw new Error('Missing Codex terminal echo correlation')
        expect(correlation.accepts(item)).toBe(true)
        expect(correlation.textMatches?.(submitted, correlation.typedText(item))).toBe(true)
        expect(podiumFrameId(recorded)).toBe(framed ? frameIds[shape] : null)
      },
    )
  })
}

describe('Codex control-byte matching limits', () => {
  it.each([
    ['one\n\ntwo', 'one\ntwo'],
    ['one\ntwo', 'one\n\ntwo'],
    ['one\rtwo', 'one\ntwo'],
    ['one\rtwo', 'one\n\ntwo'],
    ['one\r\ntwo\r\nthree', 'one\ntwo\n\nthree'],
    ['one\r\ntwo', 'one\n\n\ntwo'],
    ['one\r\ntwo', 'onetwo'],
    ['one\ntwo', 'one\r\ntwo'],
    ['one\ttwo', 'one two'],
    ['one\ttwo', 'one    two'],
    ['one\ttwo\tthree', 'one\ttwothree'],
    ['one\ttwo\r\nthree', 'onetwo\nthree'],
    ['one\ttwo\r\nthree', 'onetwo\n\nthree'],
    ['onetwo', 'one\ttwo'],
    ['one  two', 'one two'],
    ['e\u0301', 'é'],
    ['x\u200by', 'xy'],
    ['first', 'first extra'],
    ['first second', 'first'],
  ])('rejects an unmeasured change from %j to %j', (submitted, recorded) => {
    expect(codexPromptTextMatches(submitted, recorded)).toBe(false)
  })
})
