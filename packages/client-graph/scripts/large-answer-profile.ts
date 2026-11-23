// POD-7165: open a large flight deck through the real Replica, facade, pool and
// mission screen, and print what the opening did. For a CPU profile:
//   bun --conditions=@podium/source --cpu-prof packages/client-graph/scripts/large-answer-profile.ts [members] [sessionsPerIssue]
// OLD_WIRING=1 composes the Replica without the loader's burst. FLAT=1 files every
// member under the root (the operator's deck); SIDEBAR=1 draws the sidebar (POD-7173);
// CORPUS=<corpus-*.json> [TREE=970] serves a measurement corpus and opens its tree.
import { openLargeDeck } from '../src/large-answer.test.fixture'

const members = Number(process.argv[2] ?? 1000)
const perIssue = Number(process.argv[3] ?? 7)
const run = await openLargeDeck({
  members,
  sessionsPerIssue: perIssue,
  loaderBatch: process.env.OLD_WIRING !== '1',
  outsideBlockers: Number(process.env.OUTSIDE_BLOCKERS ?? 0),
  flat: process.env.FLAT === '1',
  sidebar: process.env.SIDEBAR === '1',
  corpus: process.env.CORPUS
    ? { file: process.env.CORPUS, tree: Number(process.env.TREE ?? 970) }
    : undefined,
  log: (line) => console.log(line),
})
console.log(
  JSON.stringify({
    members: run.members,
    sessions: run.sessions,
    ready: run.ready,
    rows: run.rows,
    bootMs: Math.round(run.bootMs),
    openMs: Math.round(run.openMs),
    bursts: run.bursts,
    notifications: run.notifications,
    flushes: run.flushes,
    hops: run.hops,
    lookups: run.fetches.filter((fetch) => fetch.collections.includes('issueProjection.one'))
      .length,
    unmetOutside: run.unmetOutside.length,
    longestMs: Math.round(run.longestMs),
  }),
)
console.log(`publications ms: ${run.publications.map((ms) => Math.round(ms)).join(' ')}`)
console.log(`bursts ms: ${run.burstMs.map((ms) => Math.round(ms)).join(' ')}`)
run.dispose()
process.exit(0)
