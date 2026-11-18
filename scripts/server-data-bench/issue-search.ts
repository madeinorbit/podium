/** SQLite searchNormalized timings on the two-axis history corpus with 2 KiB synthetic briefs.
 * Run only on an agent VM: bun --conditions=@podium/source scripts/server-data-bench/issue-search.ts
 * Output is JSON; fixture preparation and warm-up are excluded from timings. */
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
      const input = { text: query.text }
      const expected = await reports.searchNormalized(input, reader)
      const times: number[] = []
      for (let sample = 0; sample < 11; sample++) {
        const start = performance.now()
        const hits = await reports.searchNormalized(input, reader)
        times.push(performance.now() - start)
        if (hits.length !== expected.length) throw new Error('search population changed')
      }
      const sorted = [...times].sort((a, b) => a - b)
      const result = {
        cell,
        issues: corpus.issues.length,
        query: query.name,
        text: query.text,
        hits: expected.length,
        samplesMs: times,
        medianMs: sorted[5],
        p95Ms: sorted[10],
        minMs: sorted[0],
        maxMs: sorted[10],
      }
      results.push(result)
      console.log(JSON.stringify(result))
    }
  } finally {
    await store.close()
  }
}
console.log(JSON.stringify({ engine: 'SQLite', seed: 4443, samples: 11, results }))
