// POD-7165: open a large flight deck through the real Replica, facade, pool and
// mission screen, and print what the opening did. For a CPU profile:
//   bun --conditions=@podium/source --cpu-prof packages/client-graph/scripts/large-answer-profile.ts [members] [sessionsPerIssue]
// OLD_WIRING=1 composes the Replica without the loader's burst.
import { openLargeDeck } from '../src/large-answer.test.fixture'

const members = Number(process.argv[2] ?? 1000)
const perIssue = Number(process.argv[3] ?? 7)
const run = await openLargeDeck({
  members,
  sessionsPerIssue: perIssue,
  loaderBatch: process.env.OLD_WIRING !== '1',
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
    trims: run.trims,
    longestMs: Math.round(run.longestMs),
  }),
)
console.log(`publications ms: ${run.publications.map((ms) => Math.round(ms)).join(' ')}`)
console.log(`bursts ms: ${run.burstMs.map((ms) => Math.round(ms)).join(' ')}`)
run.dispose()
process.exit(0)
