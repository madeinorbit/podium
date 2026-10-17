import { asMachineId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import type { ConversationPageCursor } from './conversations/index'
import type { ConversationIndexRow } from './types'

/**
 * THE RECENT CONVERSATIONS, ONE KEYSET PAGE AT A TIME [POD-6209].
 *
 * Memory search with no term used to read every top-level conversation and
 * cut the answer in memory. It now reads pages through
 * `idx_conversations_top_level_updated`, newest first. These pin the order
 * (ties broken by id, rows with no `updated_at` last), that walking the pages
 * by the last row's cursor neither repeats nor skips a row, and that the
 * subagent and project path filters still apply.
 */
describe('ConversationIndexRepository.recentPage', () => {
  let store: SessionStore
  beforeEach(async () => {
    store = await openTestStore(':memory:')
  })
  afterEach(() => store.close())

  const conversation = (id: string, over: Partial<ConversationIndexRow> = {}) => ({
    id,
    agentKind: 'claude-code',
    providerId: 'claude-code-jsonl',
    machineId: asMachineId('m1'),
    projectPath: '/repo',
    ...over,
  })

  const cursorOf = (row: ConversationIndexRow): ConversationPageCursor => ({
    updatedAt: row.updatedAt ?? null,
    id: row.id,
  })

  /** Every page of `limit` rows, following each page's last row. */
  const walk = async (limit: number, projectPath?: string): Promise<string[][]> => {
    const pages: string[][] = []
    let after: ConversationPageCursor | undefined
    for (;;) {
      const page = await store.conversations.index.recentPage({
        limit,
        ...(after ? { after } : {}),
        ...(projectPath ? { projectPath } : {}),
      })
      if (page.length > 0) pages.push(page.map((row) => row.id))
      if (page.length < limit) return pages
      after = cursorOf(page.at(-1)!)
    }
  }

  beforeEach(async () => {
    await store.conversations.index.upsert([
      conversation('old', { updatedAt: '2026-10-01T00:00:00.000Z' }),
      conversation('tie-a', { updatedAt: '2026-10-02T00:00:00.000Z' }),
      conversation('tie-b', { updatedAt: '2026-10-02T00:00:00.000Z' }),
      conversation('new', { updatedAt: '2026-10-03T00:00:00.000Z', projectPath: '/repo/wt' }),
      conversation('undated-a'),
      conversation('undated-b', { projectPath: '/other' }),
      conversation('subagent', {
        updatedAt: '2026-10-04T00:00:00.000Z',
        parentConversationId: 'new',
      }),
    ])
  })

  it('reads newest first, ties by id, rows with no updated_at last, and skips subagents', async () => {
    expect((await store.conversations.index.recentPage({ limit: 10 })).map((row) => row.id)).toEqual([
      'new',
      'tie-b',
      'tie-a',
      'old',
      'undated-b',
      'undated-a',
    ])
  })

  it('walks every page by the last row, across the dated and undated rows, without a repeat or a gap', async () => {
    expect(await walk(2)).toEqual([
      ['new', 'tie-b'],
      ['tie-a', 'old'],
      ['undated-b', 'undated-a'],
    ])
    expect(await walk(3)).toEqual([
      ['new', 'tie-b', 'tie-a'],
      ['old', 'undated-b', 'undated-a'],
    ])
    expect((await walk(1)).flat()).toEqual(['new', 'tie-b', 'tie-a', 'old', 'undated-b', 'undated-a'])
  })

  it('keeps the project path filter on every page', async () => {
    expect(await walk(2, '/repo')).toEqual([['new', 'tie-b'], ['tie-a', 'old'], ['undated-a']])
  })
})
