/**
 * GROK'S TERMINAL HISTORY IS READ FROM `updates.jsonl` (POD-4875).
 *
 * Measured on grok 1.0.44's terminal UI (POD-4865,
 * docs/measurements/pod-4834-receipt-proof/grok-tui-1.0.44/results.md): Grok
 * replaces `chat_history.jsonl` by rename on cancel and resume, rewrites its
 * earlier lines on new prompts and on compaction, and a compaction re-adds an
 * old prompt as a new-looking user record. `updates.jsonl` stayed append-only
 * through all of it, and its `user_message_chunk` was the only record whose
 * presence decided whether a prompt survived a kill and reached the model.
 *
 * These tests read that run's own session files, so the reader is held to what
 * Grok wrote, not to a hand-made shape.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TranscriptItem } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { transcriptEchoAcceptCorrelation } from '../../accept-correlation.js'
import { declaredValue } from '../../manifest.js'
import { decodeCursor } from '../../store/cursor-codec.js'
import { fileIdFor } from '../../store/file-chain.js'
import { readFileItems } from '../../store/slice.js'
import { grokManifest } from './index.js'
import { grokChainPaths, grokRecordToItems, grokRuntime } from './transcript.js'

const RUN = fileURLToPath(
  new URL(
    '../../../../../docs/measurements/pod-4834-receipt-proof/grok-tui-1.0.44/session-files/',
    import.meta.url,
  ),
)
const UPDATES = join(RUN, 'updates.jsonl')
const CHAT_HISTORY = join(RUN, 'chat_history.final.jsonl')
const SESSION = '01a0edee-690d-73c0-bba4-6a60e8bc0ebb'

async function read(path: string): Promise<TranscriptItem[]> {
  return readFileItems(path, fileIdFor(SESSION), grokRecordToItems)
}

const users = (items: TranscriptItem[]) => items.filter((item) => item.role === 'user')

describe('the Grok terminal transcript, read from updates.jsonl', () => {
  it('holds every prompt that reached the conversation, once, in submit order', async () => {
    const prompts = users(await read(UPDATES)).map((item) => item.text)
    // 35 user_message_chunk records; one is Grok's own auto-wake after a
    // background task finished (hideFromScrollback), which nobody typed.
    expect(prompts).toHaveLength(34)
    expect(prompts.slice(0, 7)).toEqual([
      'ALPHA idle prompt',
      'BETA TOOLSLEEP please',
      'GAMMA sent while tool runs',
      'DELTA SLOWTEXT please',
      'EPSILON sent while text streams',
      'ETA TOOLSLEEP please',
      // "send now": Grok wraps it for the model, the chunk keeps the words.
      'ZETA queued then send now',
    ])
    expect(prompts).not.toContainEqual(expect.stringContaining('<system-reminder>'))
    // The same words twice are two prompts, never merged.
    expect(prompts.filter((text) => text === 'OMICRON same text')).toHaveLength(2)
    // The prompt a compaction copied back into chat_history is here once.
    expect(prompts.filter((text) => text === 'OMEGA two')).toHaveLength(1)
    expect(prompts.at(-1)).toBe('SIGMABUSY TOOLSLEEP before term')
  })

  it('leaves out prompts Grok took but lost to a kill, though resume names their promptId', async () => {
    const items = await read(UPDATES)
    const texts = items.map((item) => item.text)
    // RACE20 was killed before the hook, RACE60 after it; both are absent from
    // the resumed conversation. Resume writes `turn_completed interrupted` for
    // RACE60's promptId (b239b967…), which must not read as its prompt.
    expect(texts.some((text) => text.startsWith('RACE20'))).toBe(false)
    expect(texts.some((text) => text.startsWith('RACE60'))).toBe(false)
    // Prompts still in Grok's queue when it died (kill -9, SIGTERM) are gone too.
    expect(texts.some((text) => text.startsWith('QUEUEDATKILL'))).toBe(false)
    expect(texts.some((text) => text.startsWith('HELDTERM'))).toBe(false)
    // The one killed after its chunk was written reached the model.
    expect(texts).toContain('RACEKILL killed right after Enter')
  })

  it("reads a prompt the way it was typed and dates it by Grok's event time", async () => {
    const items = users(await read(UPDATES))
    const alpha = items[0]
    // `_meta.agentTimestampMs` of the ALPHA chunk; the record's own `timestamp`
    // is whole seconds and would not order two prompts in one second.
    expect(alpha?.ts).toBe(new Date(1790698265166).toISOString())
    // A combining accent stays combining (no normalization); a pasted tab
    // reached Grok as 4 spaces.
    expect(items.map((item) => item.text)).toContain(
      'SIGMA \u00fcn\u00efc\u00f6d\u00e9 \u65e5\u672c\u8a9e \u{1f642} e\u0301 tab    here',
    )
    expect(items.map((item) => item.text)).toContain(
      'RHO line one\nline two\n\n  line four indented',
    )
    for (const item of items) expect(item.ts).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('the echo proof accepts each prompt entry and matches it to the typed text', async () => {
    const items = users(await read(UPDATES))
    const beta = items.find((item) => item.text.startsWith('BETA'))
    expect(beta && transcriptEchoAcceptCorrelation.accepts(beta)).toBe(true)
    expect(beta && transcriptEchoAcceptCorrelation.fingerprint(beta)).toBe(
      transcriptEchoAcceptCorrelation.fingerprintText('BETA TOOLSLEEP please'),
    )
  })

  it('shows the replies and the tool calls with their results', async () => {
    const items = await read(UPDATES)
    expect(items.find((item) => item.role === 'assistant')).toMatchObject({
      role: 'assistant',
      text: 'r5w1 r5w2 r5w3',
      ts: new Date(1790698265404).toISOString(),
    })
    const call = items.find((item) => item.toolUseId === 'call_fake8' && item.toolName)
    expect(call).toMatchObject({
      id: 'call_fake8',
      role: 'tool',
      toolName: 'Bash',
      toolInput: 'sleep 8',
      toolTitle: 'wait eight seconds',
    })
    const result = items.find((item) => item.toolUseId === 'call_fake8' && item.toolResult)
    expect(result).toMatchObject({ id: 'call_fake8:out', role: 'tool', toolResult: 'exit: 0' })
    // Grok's reasoning, hooks, turn ends and background-task bookkeeping are
    // not part of the conversation view.
    expect(items.every((item) => ['user', 'assistant', 'tool'].includes(item.role))).toBe(true)
  })

  it('places every entry at a byte offset that grows through the file', async () => {
    const items = await read(UPDATES)
    expect(items.length).toBeGreaterThan(60)
    const offsets = items.map((item) => {
      const cursor = item.cursor ? decodeCursor(item.cursor) : null
      expect(cursor?.fileId).toBe(fileIdFor(SESSION))
      return cursor?.offset ?? -1
    })
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1] ?? 0)
    }
    // Ids are stable and unique: the same bytes read twice give the same ids.
    const again = await read(UPDATES)
    expect(again.map((item) => item.id)).toEqual(items.map((item) => item.id))
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
  })

  it('reads nothing from chat_history.jsonl records', async () => {
    expect(await read(CHAT_HISTORY)).toEqual([])
  })

  it('reports the model the prompt was sent to', () => {
    expect(
      grokRuntime({
        method: 'session/update',
        params: {
          sessionId: SESSION,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hi' },
            _meta: { modelId: 'grok-4.7-build', promptIndex: 0 },
          },
          _meta: { eventId: `${SESSION}-4`, agentTimestampMs: 1790698265166 },
        },
      }),
    ).toEqual({ model: 'grok-4.7-build' })
  })
})

describe('where the Grok terminal transcript lives', () => {
  let home: string | undefined
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true })
    home = undefined
  })

  it("chains the session directory's updates.jsonl, not chat_history.jsonl", async () => {
    home = await mkdtemp(join(tmpdir(), 'grok-updates-chain-'))
    const dir = join(home, '.grok', 'sessions', encodeURIComponent('/repo'), SESSION)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'chat_history.jsonl'), '{"type":"user","content":"x"}\n')
    await writeFile(join(dir, 'updates.jsonl'), '')
    expect(await grokChainPaths({ cwd: '/repo', resumeValue: SESSION, homeDir: home })).toEqual([
      join(dir, 'updates.jsonl'),
    ])
  })

  it('says updates.jsonl dates its entries to the millisecond', () => {
    const terminal = grokManifest.runtime.terminal
    expect(terminal.transcriptTimestamps).toEqual({ resolutionMs: 1 })
    expect(declaredValue(grokManifest.transcript)?.storage).toBe('file')
  })
})
