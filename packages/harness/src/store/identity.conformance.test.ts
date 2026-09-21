import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from '../adapters/claude-code/transcript.js'
import { codexRecordToItems } from '../adapters/codex/transcript.js'
import { cursorRecordToItems } from '../adapters/cursor/transcript.js'
import { decodeCursor, encodeCursor, recordUuid, stampCursors } from './cursor-codec'
import { fileIdFor } from './file-chain'
import { grokRecordToItems } from '../adapters/grok/transcript.js'
import type { OpencodeMessagePartRow } from '../adapters/opencode/transcript.js'
import { piRecordToItems } from '../adapters/pi/transcript.js'
import { readFileItems, readTranscriptSlice } from './slice'
import { opencodeFileId, stampOpencodeItems } from '../adapters/opencode/transcript.js'
import { sliceItemsByAnchor } from './source'
import { streamItemIdOf } from './stream-identity'

type Mapper = (record: unknown) => TranscriptItem[]
const content = [{ type: 'text', text: 'same words' }]
const families: [string, Mapper, object][] = [
  ['claude-sdk replay', claudeRecordToItems, { type: 'assistant', message: { content } }],
  [
    'codex',
    codexRecordToItems,
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content } },
  ],
  ['cursor', cursorRecordToItems, { role: 'assistant', message: { content } }],
  ['pi', piRecordToItems, { type: 'message', message: { role: 'assistant', content } }],
  ['grok-acp', grokRecordToItems, { role: 'assistant', content }],
]
const ids = (items: TranscriptItem[]) => items.map((item) => item.id)
const coordinates = (items: TranscriptItem[]) => items.map(({ id, cursor }) => ({ id, cursor }))
const namespaces = [
  fileIdFor('session-identity'),
  opencodeFileId('session-identity'),
  'session:/自由 namespace\0archive:2',
]

// These are producer-side tests: only the codec/source may inspect fileId.
// Consumers hand anchors back unchanged; no regex, prefix, or width is required.
for (const [family, mapper, record] of families) {
  describe(`${family} identity contract`, () => {
    for (const fileId of namespaces) {
      it(`preserves the free-form namespace ${JSON.stringify(fileId)} across parses and paths`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'transcript-identity-'))
        try {
          const a = join(directory, 'original.jsonl')
          const b = join(directory, 'copied.jsonl')
          const bytes = `${JSON.stringify(record)}\n`.repeat(3)
          await writeFile(a, bytes)
          await writeFile(b, bytes)
          const first = await readFileItems(a, fileId, mapper)
          expect(first).toHaveLength(3)
          expect(new Set(ids(first)).size).toBe(3)
          expect(first.map((item) => item.text)).toEqual(['same words', 'same words', 'same words'])
          expect(coordinates(await readFileItems(a, fileId, mapper))).toEqual(coordinates(first))
          expect(coordinates(await readFileItems(b, fileId, mapper))).toEqual(coordinates(first))
          for (const item of first) expect(decodeCursor(item.cursor ?? '')?.fileId).toBe(fileId)
          const anchor = first[1]?.cursor
          expect(anchor).toBeDefined()
          const page = await readTranscriptSlice([{ path: b, fileId }], mapper, {
            anchor,
            direction: 'after',
            limit: 10,
          })
          expect(ids(page.items)).toEqual(ids(first.slice(2)))
          // Namespace matching is exact equality, never a decoded prefix or hash slice.
          // This cursor names a different session with a shared readable prefix.
          const foreignAnchor = encodeCursor({
            fileId: `${fileId}:different-session`,
            offset: 0,
            uuid: null,
            sub: 0,
          })
          const foreign = await readTranscriptSlice([{ path: b, fileId }], mapper, {
            anchor: foreignAnchor,
            direction: 'after',
            limit: 10,
          })
          expect(coordinates(foreign.items)).toEqual(coordinates(first))
          // Editing text in place must not remint the first positional identity.
          await writeFile(a, bytes.replaceAll('same words', 'other text'))
          expect(ids(await readFileItems(a, fileId, mapper))).toEqual(ids(first))
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      })
    }

    it('keeps live and archived session generations distinct and stable', () => {
      const session = 'native-session-identity'
      const generations = [undefined, 1, 2].map((sequence) => fileIdFor(session, sequence))
      expect(new Set(generations).size).toBe(3)
      for (const [index, namespace] of generations.entries()) {
        const parse = () =>
          stampCursors(mapper(JSON.parse(JSON.stringify(record))), namespace, 0, null)
        const first = parse()
        expect(first).toHaveLength(1)
        expect(coordinates(parse())).toEqual(coordinates(first))
        expect(namespace).toBe(fileIdFor(session, [undefined, 1, 2][index]))
        expect(namespace).not.toBe(fileIdFor('another-native-session', [undefined, 1, 2][index]))
        expect(decodeCursor(first[0]?.cursor ?? '')?.fileId).toBe(namespace)
      }
    })

    it('reanchors the saved UUID after a rewrite moves its byte offset', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'transcript-rewrite-'))
      try {
        const path = join(directory, 'fixture.jsonl')
        const fileId = fileIdFor('session-identity')
        const records = [0, 1, 2].map((index) => ({
          ...record,
          uuid: `record-${index}`,
          id: `record-${index}`,
        }))
        const bytes = `${records.map((value) => JSON.stringify(value)).join('\n')}\n`
        await writeFile(path, bytes)
        const first = await readFileItems(path, fileId, mapper)
        expect(first).toHaveLength(3)
        expect(coordinates(await readFileItems(path, fileId, mapper))).toEqual(coordinates(first))
        const anchor = first[1]?.cursor
        expect(anchor).toBeDefined()
        // A new ignored record makes the old offset point at different bytes.
        await writeFile(
          path,
          `${JSON.stringify({ ignored: 'prefix changes all byte offsets' })}\n${bytes}`,
        )
        const rewritten = await readFileItems(path, fileId, mapper)
        expect(coordinates(await readFileItems(path, fileId, mapper))).toEqual(
          coordinates(rewritten),
        )
        const after = await readTranscriptSlice([{ path, fileId }], mapper, {
          anchor,
          direction: 'after',
          limit: 10,
        })
        const before = await readTranscriptSlice([{ path, fileId }], mapper, {
          anchor,
          direction: 'before',
          limit: 10,
        })
        expect(coordinates(after.items)).toEqual(coordinates(rewritten.slice(2)))
        expect(coordinates(before.items)).toEqual(coordinates(rewritten.slice(0, 1)))
        expect(rewritten[1]?.cursor).not.toBe(anchor)
        expect(streamItemIdOf(rewritten[1] as TranscriptItem)).toBe(
          streamItemIdOf(first[1] as TranscriptItem),
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  })
}

describe('recorded mapper replay', () => {
  for (const [fixture, mapper] of [
    ['codex-rollout.jsonl', codexRecordToItems],
    ['codex-provider-identity.jsonl', codexRecordToItems],
    ['claude-bash-edit.json', claudeRecordToItems],
    ['claude-corpus-shapes.json', claudeRecordToItems],
  ] as const) {
    it(`${fixture}: every recorded shape repeats its ids and item slots`, async () => {
      const bytes = await readFile(new URL(`./__fixtures__/${fixture}`, import.meta.url), 'utf8')
      const records: unknown[] = fixture.endsWith('.jsonl')
        ? bytes
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : fixture === 'claude-corpus-shapes.json'
          ? JSON.parse(bytes).shapes.map((shape: { record: unknown }) => shape.record)
          : JSON.parse(bytes)
      let count = 0
      for (const [index, record] of records.entries()) {
        const input = JSON.stringify(record)
        const parse = () =>
          stampCursors(
            mapper(JSON.parse(input)),
            fileIdFor('recorded-session'),
            index,
            recordUuid(record),
          )
        const first = parse()
        count += first.length
        expect(coordinates(parse())).toEqual(coordinates(first))
        expect(new Set(ids(first)).size).toBe(first.length)
      }
      expect(count).toBeGreaterThan(0)
    })
  }
})

describe('opencode identity contract', () => {
  const sessionId = 'session:variable-length/自由'
  const rows: OpencodeMessagePartRow[] = [0, 1, 2].map((index) => ({
    sessionId,
    messageId: `message-${index}`,
    partId: `part-${index}`,
    timeCreated: 100 + index,
    timeUpdated: 200 + index,
    messageData: JSON.stringify({ role: 'assistant' }),
    partData: JSON.stringify({ type: 'text', text: 'same words' }),
  }))
  it('reads the same row fixture under two storage paths without reminting identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opencode-identity-'))
    try {
      const a = join(directory, 'original.json')
      const b = join(directory, 'relocated.json')
      const bytes = JSON.stringify(rows)
      await writeFile(a, bytes)
      await writeFile(b, bytes)
      const parse = async (path: string) =>
        stampOpencodeItems(JSON.parse(await readFile(path, 'utf8')), sessionId)
      const first = await parse(a)
      expect(coordinates(await parse(a))).toEqual(coordinates(first))
      expect(coordinates(await parse(b))).toEqual(coordinates(first))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('gives tool call and result distinct stable slots that join their live identities', () => {
    const row: OpencodeMessagePartRow = {
      ...(rows[0] as OpencodeMessagePartRow),
      partData: JSON.stringify({
        type: 'tool',
        tool: 'read',
        callID: 'call-1',
        state: { input: {}, output: 'same words' },
      }),
    }
    const parse = () => stampOpencodeItems(JSON.parse(JSON.stringify([row])), sessionId)
    const first = parse()
    expect(first).toHaveLength(2)
    expect(coordinates(parse())).toEqual(coordinates(first))
    expect(new Set(ids(first)).size).toBe(2)
    for (const [sub, item] of first.entries()) {
      const liveId = encodeCursor({
        fileId: opencodeFileId(sessionId),
        offset: 0,
        uuid: row.partId,
        sub,
      })
      expect(item.id).toBe(liveId)
      expect(first.filter((candidate) => candidate.id === liveId)).toHaveLength(1)
      expect(streamItemIdOf(item)).toBe(liveId)
    }
  })
  it('replays distinct positional ids, reanchors rewritten rows, and joins stream items', () => {
    const bytes = JSON.stringify(rows)
    const parse = () => stampOpencodeItems(JSON.parse(bytes), sessionId)
    const first = parse()
    expect(first).toHaveLength(3)
    expect(coordinates(parse())).toEqual(coordinates(first))
    expect(new Set(ids(first)).size).toBe(3)
    expect(first.map((item) => item.text)).toEqual(['same words', 'same words', 'same words'])
    const rewritten = stampOpencodeItems(
      rows.map((row) => ({
        ...row,
        timeCreated: row.timeCreated + 500,
        partData: row.partData.replace('same words', 'other text'),
      })),
      sessionId,
    )
    expect(ids(rewritten)).toEqual(ids(first))
    const anchor = first[1]?.cursor
    expect(anchor).toBeDefined()
    const foreignAnchor = encodeCursor({
      fileId: `${opencodeFileId(sessionId)}:different-session`,
      offset: 101,
      uuid: 'part-1',
      sub: 0,
    })
    expect(
      coordinates(
        sliceItemsByAnchor(first, { anchor: foreignAnchor, direction: 'after', limit: 10 }).items,
      ),
    ).toEqual(coordinates(first))
    expect(opencodeFileId(sessionId)).toBe(opencodeFileId(sessionId))
    expect(opencodeFileId(sessionId)).not.toBe(opencodeFileId(`${sessionId}:different-session`))
    expect(ids(sliceItemsByAnchor(first, { anchor, direction: 'after', limit: 10 }).items)).toEqual(
      ids(first.slice(2)),
    )
    expect(
      ids(sliceItemsByAnchor(rewritten, { anchor, direction: 'after', limit: 10 }).items),
    ).toEqual(ids(first.slice(2)))
    expect(
      ids(sliceItemsByAnchor(rewritten, { anchor, direction: 'before', limit: 10 }).items),
    ).toEqual(ids(first.slice(0, 1)))
    for (const [index, item] of first.entries()) {
      expect(decodeCursor(item.cursor ?? '')?.fileId).toBe(opencodeFileId(sessionId))
      const deltaId = encodeCursor({
        fileId: opencodeFileId(sessionId),
        offset: 0,
        uuid: `part-${index}`,
        sub: 0,
      })
      expect(streamItemIdOf(item)).toBe(deltaId)
      expect(item.id).toBe(deltaId)
    }
  })
})

// ID-site inventory, including pass-through writes and shared generators:
// Claude 17; Codex 5; Cursor 4; Pi 10 (8 writes + user/bash generators);
// Grok 5 (4 reachable writes + baseId); OpenCode 6 (5 writes + itemId).
// Grok's additional systemItems.id is unreachable: the public switch drops
// system records and never calls systemItems. It is not claimed as covered.
// Every fixture below asserts raw mapper IDs BEFORE cursor stamping can replace
// fallback IDs, then the normalized IDs. Both UUID-less and provider-ID forms
// are exercised. The internal-site mutation sweep is recorded in issue evidence.
const call = { type: 'tool_use', name: 'Read', input: { path: 'same words' } }
const result = { type: 'tool_result', content: 'same words' }
const claudeCases: [string, object][] = [
  [
    'meta image',
    { type: 'user', isMeta: true, message: { content: '[Image: source: /tmp/picture.png]' } },
  ],
  [
    'orphan effects',
    { type: 'user', message: { content: 'same words' }, toolUseResult: { newEffect: true } },
  ],
  ['duration', { type: 'system', subtype: 'turn_duration', durationMs: 42 }],
  ['stop hooks', { type: 'system', subtype: 'stop_hook_summary', hookCount: 1 }],
  ['away summary', { type: 'system', subtype: 'away_summary', content: 'same words' }],
  ['system text', { type: 'system', content: 'same words' }],
  [
    'edited file',
    { type: 'attachment', attachment: { type: 'edited_text_file', filename: '/tmp/a' } },
  ],
  ['file attachment', { type: 'attachment', attachment: { type: 'file', filename: '/tmp/a' } }],
  ['user string', { type: 'user', message: { content: 'same words' } }],
  ['user array and result', { type: 'user', message: { content: [...content, result] } }],
  [
    'queued command',
    {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'same words' },
    },
  ],
  ['assistant text and call', { type: 'assistant', message: { content: [...content, call] } }],
]
const codexCases: [string, object][] = [
  ['interrupt', { type: 'event_msg', payload: { type: 'turn_aborted' } }],
  ['legacy user', { type: 'event_msg', payload: { type: 'user_message', message: 'same words' } }],
  [
    'completed user',
    {
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content } },
    },
  ],
  [
    'assistant',
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content } },
  ],
  ...['function_call', 'custom_tool_call'].map((type): [string, object] => [
    type,
    { type: 'response_item', payload: { type, name: 'Read', arguments: {}, input: 'same words' } },
  ]),
  ...['function_call_output', 'custom_tool_call_output'].map((type): [string, object] => [
    type,
    { type: 'response_item', payload: { type, output: 'same words' } },
  ]),
]
const piCases: [string, object][] = [
  ['user', { role: 'user', content }],
  ['bash call and result', { role: 'bashExecution', command: 'echo hello', output: 'same words' }],
  ['custom displayed', { role: 'custom', display: true, content }],
  ['compaction summary', { role: 'compactionSummary', summary: 'same words' }],
  ['branch summary', { role: 'branchSummary', summary: 'same words' }],
  [
    'assistant text and tool',
    { role: 'assistant', content: [...content, { type: 'toolCall', name: 'Read', arguments: {} }] },
  ],
  ['assistant error', { role: 'assistant', stopReason: 'error', errorMessage: 'same words' }],
  ['tool result', { role: 'toolResult', content }],
].map(([name, message]) => [name as string, { type: 'message', message }])
const cursorCases: [string, object][] = [
  ['user', { role: 'user', message: { content } }],
  [
    'assistant text call result',
    { role: 'assistant', message: { content: [...content, call, result] } },
  ],
]
const grokCases: [string, object][] = [
  ['user', { role: 'user', content }],
  ['assistant content calls', { role: 'assistant', content: [...content, call, result] }],
  ['assistant tool_calls', { role: 'assistant', content, tool_calls: [call] }],
  ['top-level call', call],
  ['top-level result', result],
]

// Add IDs at the provider locations, leaving nested call/result IDs absent in
// one variant to exercise record+slot fallbacks as well as native tool IDs.
function withProviderIds(record: object, nested: boolean): object {
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((entry, index) => visit(entry, `${path}-${index}`))
    if (value === null || typeof value !== 'object') return value
    const input = value as Record<string, unknown>
    const out = Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [key, visit(entry, `${path}-${key}`)]),
    )
    if (
      path === 'record' ||
      nested ||
      path === 'record-payload' ||
      path === 'record-payload-item'
    ) {
      out.id = `${path}-id`
      out.uuid = `${path}-uuid`
      out.call_id = `${path}-call`
      out.tool_use_id = `${path}-tool`
      out.toolCallId = `${path}-tool`
    }
    return out
  }
  return visit(record, 'record') as object
}

for (const [family, mapper, fixtures] of [
  ['claude', claudeRecordToItems, claudeCases],
  ['codex', codexRecordToItems, codexCases],
  ['cursor', cursorRecordToItems, cursorCases],
  ['pi', piRecordToItems, piCases],
  ['grok', grokRecordToItems, grokCases],
] as [string, Mapper, [string, object][]][]) {
  describe(`${family} internal ID sites`, () => {
    for (const [site, record] of fixtures) {
      for (const [variant, input] of [
        ['uuid-less', record],
        ['record identity', withProviderIds(record, false)],
        ['native tool identity', withProviderIds(record, true)],
      ] as const) {
        it(`${site}: ${variant} repeats raw and stamped IDs`, () => {
          const bytes = JSON.stringify(input)
          const parse = () => mapper(JSON.parse(bytes))
          const first = parse()
          expect(first.length).toBeGreaterThan(0)
          // Raw IDs may be fallback sentinels shared by siblings. They must be
          // deterministic, and become unique only after position stamping.
          expect(ids(parse())).toEqual(ids(first))
          const stamped = stampCursors(first, fileIdFor('internal-sites'), 42, recordUuid(input))
          expect(
            coordinates(stampCursors(parse(), fileIdFor('internal-sites'), 42, recordUuid(input))),
          ).toEqual(coordinates(stamped))
          expect(new Set(ids(stamped)).size).toBe(stamped.length)
        })
      }
    }
  })
}

describe('opencode internal ID sites', () => {
  for (const [site, message, part, count] of [
    [
      'interrupt',
      { role: 'assistant', error: { name: 'MessageAborted' } },
      { type: 'interrupt' },
      1,
    ],
    ['user text', { role: 'user' }, { type: 'text', text: 'same words' }, 1],
    ['assistant text', { role: 'assistant' }, { type: 'text', text: 'same words' }, 1],
    [
      'call and result',
      { role: 'assistant' },
      { type: 'tool', tool: 'read', state: { input: {}, output: 'same words' } },
      2,
    ],
  ] as const) {
    it(`${site}: repeats raw and stamped IDs`, () => {
      const row: OpencodeMessagePartRow = {
        sessionId: 'site-session',
        messageId: 'message',
        partId: 'part',
        timeCreated: 12,
        timeUpdated: 15,
        messageData: JSON.stringify(message),
        partData: JSON.stringify(part),
      }
      const bytes = JSON.stringify([row])
      const parse = () => stampOpencodeItems(JSON.parse(bytes), row.sessionId)
      const first = parse()
      expect(first).toHaveLength(count)
      expect(coordinates(parse())).toEqual(coordinates(first))
      expect(new Set(ids(first)).size).toBe(count)
      for (const [sub, item] of first.entries()) {
        expect(item.id).toBe(
          encodeCursor({ fileId: opencodeFileId(row.sessionId), offset: 0, uuid: row.partId, sub }),
        )
      }
    })
  }
})
