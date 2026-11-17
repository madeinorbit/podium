/**
 * THE SEARCH CONTRACT: THE SAME MATCHING ROWS ON BOTH ENGINES [POD-6990, POD-6958 design 2.6].
 *
 * SQLite searches through FTS5 (`unicode61`), Postgres through `tsvector` columns and GIN
 * indexes (`store/conversations/search-pg.ts`). The repositories take the user's term and
 * each engine builds its own query. What must agree is WHICH rows match a whole-word or
 * prefix term; rank order and snippet text may differ (operator decision OD4). This file
 * pins the matching rows over a fixed corpus, for conversation search and transcript
 * search, and runs on the store shard (SQLite) and on the `server-store-pg` lane: both
 * legs hold the same pinned expectations, so a difference between the engines fails one.
 *
 * The corpus has the words where the two tokenizers differ by default: punctuation inside
 * a word (paths, hyphens, underscores, apostrophes, version dots), Latin diacritics and
 * their case, digits joined to letters, and phrase order. The same words are in a second
 * workspace, and a search answers only its own workspace's rows.
 *
 * THE CONTRACT HAS TEETH: the same terms over the same corpus, searched with a planted
 * tokenizer change (SQLite: `unicode61` keeping diacritics and with `- _ / .` as word
 * characters; Postgres: its own parser on the raw text, without the translation), break
 * the contract.
 */

import { asMachineId, type MachineId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openConversationStoreSlices,
  type WorkspaceConversationSlice,
} from '../../test-support/conversation-store-slice'
import { testStoreEngine } from '../../test-support/pg-test-database'
import { tsqueryOf } from './search-pg'

const ON_PG = testStoreEngine() === 'pg'
const scope = fixtureWriteScope()

/** The corpus: one conversation (and one transcript row) per entry, by the id's suffix. */
const CORPUS: readonly { readonly id: string; readonly text: string; readonly path?: string }[] = [
  { id: 'c1', text: 'Deploy-script ran on /repo/wt' },
  { id: 'c2', text: 'Café crème notes' },
  { id: 'c3', text: "don't stop believing, foo_bar baz" },
  { id: 'c4', text: 'v1.2.3 release: Needle in the HAYSTACK' },
  { id: 'c5', text: 'abc123 numbers', path: '/home/u/projects/podium' },
  { id: 'c6', text: 'unrelated words only' },
]

/** Each term and the corpus ids it must match, on both engines. */
const CONTRACT: readonly (readonly [string, readonly string[]])[] = [
  ['deploy', ['c1']],
  ['script', ['c1']],
  ['Deploy-script', ['c1']],
  ['deploy-sc', ['c1']],
  ['script-deploy', []],
  ['repo', ['c1']],
  ['/repo/wt', ['c1']],
  ['wt', ['c1']],
  ['cafe', ['c2']],
  ['CAFÉ', ['c2']],
  ['crem', ['c2']],
  ["don't", ['c3']],
  ['don', ['c3']],
  ['foo_bar', ['c3']],
  ['bar', ['c3']],
  ['1.2', []],
  ['2', ['c4']],
  ['nee', ['c4']],
  ['NEEDLE hay', ['c4']],
  ['needle deploy', []],
  ['abc', ['c5']],
  ['123', []],
  ['un wor', ['c6']],
  ['-', []],
  ['zzz', []],
]

/** Each id of `tag`'s workspace. */
const idOf = (tag: string, id: string) => `${tag}-${id}`
const machineOf = (tag: string): MachineId => asMachineId(`${tag}-machine`)

/** The terms whose matches differ from the contract, each with what it found. */
async function contractFindings(
  search: (term: string) => Promise<readonly string[]>,
): Promise<string[]> {
  const findings: string[] = []
  for (const [term, want] of CONTRACT) {
    const found = [...(await search(term))].sort()
    if (found.join() !== [...want].sort().join())
      findings.push(`${JSON.stringify(term)}: found [${found}], the contract says [${want}]`)
  }
  return findings
}

let slices: readonly [WorkspaceConversationSlice, WorkspaceConversationSlice]
const tags = ['a', 'b'] as const

/** `tag`'s workspace's corpus: conversations (with a subagent that must not match) and transcript rows. */
async function seed(slice: WorkspaceConversationSlice, tag: string): Promise<void> {
  const { index, transcriptIndex } = slice.conversations
  const m = machineOf(tag)
  await index.upsert(scope, [
    ...CORPUS.map((entry, n) => ({
      id: idOf(tag, entry.id),
      agentKind: 'claude-code',
      providerId: 'claude-code',
      title: entry.text,
      projectPath: entry.path ?? `/srv/${tag}`,
      updatedAt: `2026-11-0${n + 1}T00:00:00.000Z`,
      machineId: m,
    })),
    {
      id: idOf(tag, 'sub'),
      agentKind: 'claude-code',
      providerId: 'claude-code',
      title: 'Needle deploy-script subagent',
      parentConversationId: idOf(tag, 'c1'),
      machineId: m,
    },
  ])
  for (const entry of CORPUS) {
    await transcriptIndex.append(m, idOf(tag, entry.id), [{ content: entry.text }], 1)
  }
}

beforeEach(async () => {
  slices = await openConversationStoreSlices(['ws_contract_a', 'ws_contract_b'])
  for (const [i, slice] of slices.entries()) {
    await slice.conversations.ensureFts(true)
    await seed(slice, tags[i]!)
  }
})

afterEach(async () => {
  await slices?.[0].close()
})

/** Strip `tag`'s prefix, or keep a foreign id as it is so the contract reports it. */
const own = (tag: string, ids: readonly string[]) =>
  ids.map((id) => (id.startsWith(`${tag}-`) ? id.slice(tag.length + 1) : id))

describe(`the search contract (${ON_PG ? 'Postgres' : 'SQLite'})`, () => {
  it('conversation search matches the pinned rows, in each workspace only its own', async () => {
    for (const [i, slice] of slices.entries()) {
      const tag = tags[i]!
      const findings = await contractFindings(async (term) =>
        own(
          tag,
          (await slice.conversations.index.searchCandidates({ query: term })).map((r) => r.id),
        ),
      )
      expect(findings).toEqual([])
    }
  })

  it('transcript search matches the pinned rows, in each workspace only its own', async () => {
    for (const [i, slice] of slices.entries()) {
      const tag = tags[i]!
      const findings = await contractFindings(async (term) => {
        const matches = await slice.conversations.transcriptIndex.searchCandidates(term)
        for (const match of matches) expect(match.machineId).toBe(machineOf(tag))
        return own(
          tag,
          matches.map((match) => match.nativeId),
        )
      })
      expect(findings).toEqual([])
    }
  })

  it('marks the matched word in a transcript snippet and ranks a match as a number', async () => {
    const [match] = await slices[0].conversations.transcriptIndex.searchCandidates('needle')
    expect(match?.snippet).toMatch(/\*\*Needle\*\*/)
    expect(typeof match?.rank).toBe('number')
    expect(match?.title).toBe(CORPUS[3]!.text)
  })

  it('keeps the project path filter, ASCII case ignored as SQLite LIKE ignores it', async () => {
    const { index } = slices[0].conversations
    const ids = async (query: string, projectPath: string) =>
      (await index.searchCandidates({ query, projectPath })).map((row) => row.id)
    expect(await ids('abc', '/home/u/projects')).toEqual([idOf('a', 'c5')])
    expect(await ids('abc', '/HOME/u/projects')).toEqual([idOf('a', 'c5')])
    expect(await ids('abc', '/srv/a')).toEqual([])
  })

  it('falls back to substring search with search off, ASCII case ignored', async () => {
    const { index } = slices[0].conversations
    await index.disableFts()
    expect((await index.search({ query: 'DEPLOY-SCR' })).map((row) => row.id)).toEqual([
      idOf('a', 'c1'),
    ])
    expect((await index.search({ query: 'repo/w' })).map((row) => row.id)).toEqual([
      idOf('a', 'c1'),
    ])
  })

  it('stores external text without U+0000, as U+FFFD, and finds it', async () => {
    const { index, transcriptIndex } = slices[0].conversations
    const m = machineOf('a')
    await index.upsert(scope, [
      {
        id: 'nul',
        agentKind: 'claude-code',
        providerId: 'claude-code',
        title: 'nul\u0000title',
        projectPath: '/srv/a\u0000',
        machineId: m,
      },
    ])
    await index.setMeta(scope, 'nul', { name: 'na\u0000me', summary: 'sum\u0000mary' })
    await transcriptIndex.append(
      m,
      'nul',
      [{ content: 'nulword\u0000text', itemUuid: 'u\u0000' }],
      1,
    )

    const [record] = await index.records(['nul'])
    expect(record).toMatchObject({
      title: 'nul�title',
      projectPath: '/srv/a�',
      name: 'na�me',
      summary: 'sum�mary',
    })
    expect((await index.searchCandidates({ query: 'nul' })).map((row) => row.id)).toEqual(['nul'])
    expect(await transcriptIndex.rows(m, 'nul')).toEqual([
      { content: 'nulword�text', itemUuid: 'u�' },
    ])
    expect((await transcriptIndex.searchCandidates('nulword')).map((r) => r.nativeId)).toEqual([
      'nul',
    ])
  })

  it('fails on a planted tokenizer change', async () => {
    const slice = slices[0]
    const texts = CORPUS.map((entry) => entry.text)
    let planted: (term: string) => Promise<string[]>
    if (ON_PG) {
      // Postgres's own parser on the raw text: no punctuation as spaces, no folding.
      planted = async (term) => {
        const query = tsqueryOf(term)
        if (query === undefined) return []
        const values = sql.join(
          texts.map((text, i) => sql`(${sql.raw(String(i + 1))}, CAST(${text} AS text))`),
          sql`, `,
        )
        const rows = await slice.all<{ n: number }>(
          sql`SELECT c.n FROM (VALUES ${values}) AS c(n, text)
            WHERE to_tsvector('simple', c.text) @@ to_tsquery('simple', ${query}) ORDER BY c.n`,
        )
        return rows.map((row) => CORPUS[Number(row.n) - 1]!.id)
      }
    } else {
      // unicode61 keeping diacritics, with `- _ / .` as word characters.
      await slice.run(
        sql.raw(
          `CREATE VIRTUAL TABLE planted_fts USING fts5(content, tokenize = "unicode61 remove_diacritics 0 tokenchars '-_/.'")`,
        ),
      )
      for (const text of texts)
        await slice.run(sql`INSERT INTO planted_fts (content) VALUES (${text})`)
      planted = async (term) => {
        const fts = term
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => `"${token.replace(/"/g, '""')}"*`)
          .join(' ')
        const rows = await slice.all<{ n: number }>(
          sql`SELECT rowid AS n FROM planted_fts WHERE planted_fts MATCH ${fts} ORDER BY rowid`,
        )
        return rows.map((row) => CORPUS[Number(row.n) - 1]!.id)
      }
    }
    const findings = await contractFindings(planted)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.join('\n')).toMatch(/"repo"|"cafe"/)
  })
})
