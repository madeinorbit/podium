/** SQLite searchNormalized page timings on the two-axis history corpus with 2 KiB synthetic
 * briefs. Each first and second page is checked against the unbounded search (POD-7108).
 * Run only on an agent VM: bun --conditions=@podium/source scripts/server-data-bench/issue-search.ts
 * Output is JSON; fixture preparation and warm-up are excluded from timings. */
import { ISSUE_SEARCH_PAGE_DEFAULT } from '@podium/commands'
import { firstAdminMemberId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { IssueStore } from '../../apps/server/src/modules/issues/service/core'
import {
  type IssueReader,
  IssueReportsModule,
} from '../../apps/server/src/modules/issues/service/reads'
import type { IssueDeps } from '../../apps/server/src/modules/issues/service/types'
import { foldedDeps, rawSql, seededStore } from '../../apps/server/src/test-support/issue-corpus'
import { sessionReadPorts } from '../../apps/server/src/test-support/session-facts'
import { exportCorpus } from './corpus-export'

const PAGE = ISSUE_SEARCH_PAGE_DEFAULT
const results: object[] = []
for (const cell of ['h1a1', 'h10a1']) {
  const corpus = await exportCorpus(cell, 4443)
  const store = await seededStore(
    corpus.issues,
    corpus.repos,
    foldedDeps(corpus.deps, new Set(corpus.issues.map((issue) => issue.id))),
  )
  try {
    // The startup corpus has tiny descriptions and no exported briefs. Add a
    // fixed body size so scanning bodies is represented without private data.
    await rawSql(
      store,
      sql`UPDATE issues SET brief = ${'Synthetic search brief. '.repeat(90) + 'unique-brief-token:'} || id`,
    )
    const target = corpus.issues.find((issue) => !issue.deletedAt && !issue.archived)!
    const reports = new IssueReportsModule(
      new IssueStore({ store, ...sessionReadPorts(() => []) } as unknown as IssueDeps),
    )
    const viewer = await firstAdminMemberId(store)
    const reader: IssueReader = {
      viewer: () => viewer,
      mayRead: async (id) => await reports.has(id),
    }
    const cases = [
      { name: 'no-match', text: 'no-such-search-token-7089' },
      { name: 'specific-title', text: target.title },
      { name: 'description', text: 'Body 71' },
      { name: 'brief', text: `unique-brief-token:${target.id}` },
      { name: 'broad-title', text: 're' },
    ]
    for (const query of cases) {
      // The unbounded search is the parity control (POD-7108): the first page
      // is its first PAGE ids in its order, and the next page continues it.
      const all = (await reports.search({ text: query.text }, reader)).map((hit) => hit.id)
      const input = { text: query.text, limit: PAGE }
      const first = await reports.searchNormalized(input, reader)
      const expectFirst = all.slice(0, PAGE)
      if (JSON.stringify(first.hits.map((hit) => hit.id)) !== JSON.stringify(expectFirst))
        throw new Error(`${query.name}: first page differs from the unbounded search`)
      if ((first.next !== null) !== all.length > PAGE)
        throw new Error(`${query.name}: next cursor disagrees with the unbounded search`)
      const second = first.next
        ? await reports.searchNormalized({ ...input, cursor: first.next }, reader)
        : undefined
      if (
        second &&
        JSON.stringify(second.hits.map((hit) => hit.id)) !==
          JSON.stringify(all.slice(PAGE, 2 * PAGE))
      )
        throw new Error(`${query.name}: second page differs from the unbounded search`)
      const sample = async (pageInput: typeof input & { cursor?: string }) => {
        const times: number[] = []
        for (let n = 0; n < 11; n++) {
          const start = performance.now()
          const page = await reports.searchNormalized(pageInput, reader)
          times.push(performance.now() - start)
          if (page.hits.length !== Math.min(PAGE, all.length - (pageInput.cursor ? PAGE : 0)))
            throw new Error('search population changed')
        }
        const sorted = [...times].sort((a, b) => a - b)
        return { samplesMs: times, medianMs: sorted[5], p95Ms: sorted[10], minMs: sorted[0] }
      }
      const result = {
        cell,
        issues: corpus.issues.length,
        query: query.name,
        text: query.text,
        hits: all.length,
        page: PAGE,
        pageHits: first.hits.length,
        firstPage: await sample(input),
        ...(first.next ? { secondPage: await sample({ ...input, cursor: first.next }) } : {}),
      }
      results.push(result)
      console.log(JSON.stringify(result))
    }
  } finally {
    await store.close()
  }
}
console.log(JSON.stringify({ engine: 'SQLite', seed: 4443, samples: 11, page: PAGE, results }))
