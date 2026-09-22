import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, type AgentKind } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { transcriptRecordMapperFor } from '../../harness-manifest'
import { openTestStore } from '../../test-support/open-test-store'
import { forceFeature } from '../../test-support/features'
import { DaemonRequestBroker } from '../daemon-request'
import { TranscriptLake } from './lake'
import { TranscriptIndexer } from './transcript-indexer'

// The indexer only runs where a transcript index exists, and that is the
// `command-palette` flag read at store construction (PDM-25).
forceFeature('command-palette', true)

/**
 * ARMED GUARD (this issue): the search index must carry the SAME item identity
 * the lake (and live reads) return for the same item.
 *
 * Per uuid-less grammar, a fixture segment is indexed through the TranscriptIndexer
 * and read back through the TranscriptLake over the same mirrored bytes; the id
 * sets must be equal. The indexer used to parse records itself and store the
 * pre-stamp id, so every synthesized (`claude-fallback:`) id below mismatched the
 * stamped cursor id the lake returns — this test is red on that tree.
 */

const TS = '2026-09-21T12:00:00.000Z'

interface GrammarCase {
  name: string
  agentKind: AgentKind
  /** Native records (one per line) yielding uuid-less user/assistant prose. */
  records: unknown[]
}

const cases: GrammarCase[] = [
  {
    name: 'codex',
    agentKind: 'codex',
    records: [
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'codex uuid-less user prose' } },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'codex uuid-less assistant prose' }],
        },
      },
    ],
  },
  {
    name: 'cursor',
    agentKind: 'cursor',
    records: [
      { role: 'user', message: { content: [{ type: 'text', text: 'cursor uuid-less user prose' }] } },
      {
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'cursor uuid-less assistant prose' }] },
      },
    ],
  },
  {
    name: 'grok',
    agentKind: 'grok',
    records: [
      { type: 'user', timestamp: TS, content: [{ type: 'text', text: 'grok uuid-less user prose' }] },
    ],
  },
  {
    name: 'pi',
    agentKind: 'pi',
    records: [
      {
        type: 'message',
        parentId: null,
        timestamp: TS,
        message: { role: 'user', content: [{ type: 'text', text: 'pi uuid-less user prose' }] },
      },
      {
        type: 'message',
        parentId: null,
        timestamp: TS,
        message: { role: 'assistant', content: [{ type: 'text', text: 'pi uuid-less reply prose' }] },
      },
    ],
  },
  {
    name: 'claude',
    agentKind: 'claude-code',
    records: [
      {
        type: 'user',
        timestamp: TS,
        message: { role: 'user', content: 'claude uuid-less user prose' },
      },
      {
        type: 'assistant',
        uuid: 'gold-a1',
        timestamp: TS,
        message: { role: 'assistant', model: 'gold', content: [{ type: 'text', text: 'claude uuid reply' }] },
      },
    ],
  },
]

describe('transcript index-vs-lake identity (this issue)', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: indexed itemUuids equal the lake ids for the same bytes',
    async (_name, grammar) => {
      const store = await openTestStore(':memory:')
      const lakeDir = mkdtempSync(join(tmpdir(), 'podium-index-ids-'))
      const machineId = asMachineId('m1')
      const nativeId = `ids-${grammar.name}`
      cleanups.push(() => {
        rmSync(lakeDir, { recursive: true, force: true })
      })
      cleanups.push(() => store.close())

      const lake = new TranscriptLake(
        {
          store: store.conversations,
          now: Date.now,
          daemonRequest: new DaemonRequestBroker({
            toMachine: () => {},
            defaultMachine: () => machineId,
          }),
          parseForAgentKind: (kind) => transcriptRecordMapperFor(kind),
          findSessionByNativeId: async () => ({ agentKind: grammar.agentKind }),
        },
        { mirrorLakeDir: lakeDir },
      )
      cleanups.push(() => lake.dispose())

      await store.conversations.registry.ensure({
        machineId,
        nativeId,
        providerId: `${grammar.agentKind}-jsonl`,
        path: `/native/${nativeId}.jsonl`,
      })
      const content = `${grammar.records.map((r) => JSON.stringify(r)).join('\n')}\n`
      const lakePath = join(lakeDir, machineId, `${nativeId}.jsonl`)
      mkdirSync(join(lakeDir, machineId), { recursive: true })
      writeFileSync(lakePath, content)
      await store.conversations.mirror.setMirrorCursor(
        machineId,
        nativeId,
        Buffer.byteLength(content),
        '2026-09-21T12:00:00Z',
      )

      const indexer = new TranscriptIndexer({
        mirror: store.conversations.mirror,
        index: store.conversations.transcriptIndex,
        readItems: async (machineId, nativeId, from, to, windowBytes) =>
          await lake.readIndexItems(machineId, nativeId, from, to, windowBytes),
      })
      cleanups.push(() => indexer.dispose())
      await indexer.backfillMachine(machineId)
      await indexer.settled()

      const rows = await store.conversations.transcriptIndex.rows(machineId, nativeId)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row.itemUuid).toBeDefined()
      const indexedIds = new Set(rows.map((r) => r.itemUuid as string))

      const slice = await lake.readWindow(
        {
          machineId,
          agentKind: grammar.agentKind,
          resume: { kind: 'test-session', value: nativeId },
        },
        { direction: 'before', limit: 100 },
      )
      expect(slice).toBeDefined()
      const lakeIds = new Set(
        (slice?.items ?? [])
          .filter(
            (item) =>
              (item.role === 'user' || item.role === 'assistant') &&
              item.toolName === undefined &&
              item.text.trim().length > 0,
          )
          .map((item) => item.id),
      )
      expect(lakeIds.size).toBeGreaterThan(0)
      expect([...indexedIds].sort()).toEqual([...lakeIds].sort())
    },
  )
})
