/**
 * POD-1645 before/after harness — the two quantities POD-1641's profile named.
 *
 * Drives the REAL `indexSessionOwnership` (via the built client-core sources)
 * over a corpus with the live instance's dimensions, and reports:
 *   - worktreeForCwd/lookup CALLS per index build   (the defect)
 *   - string COMPARISONS per delta                  (what the calls cost)
 *   - index BUILDS per delta                        (the second multiplier)
 *   - V8 self time under the resolution, via --cpu-prof (the same profiler CDP
 *     samples; analyse with docs/agents/pod-1641/cdpan.mjs)
 *
 * Corpus dimensions come from the profile run: ~1100 sessions, ~1600 issues,
 * 111 real worktree paths. Run with:
 *   node --cpu-prof --cpu-prof-name=x.cpuprofile docs/agents/pod-1645/bench.mjs
 */
const SESSIONS = 1100
const ISSUES = 1600
const WORKTREES = 111
const REPO = '/home/mgw/src/other/podium'

const worktreePaths = Array.from({ length: WORKTREES }, (_, i) =>
  i === 0 ? REPO : `${REPO}/.worktrees/issue-${1000 + i}-some-branch-name`,
)
const issues = Array.from({ length: ISSUES }, (_, i) => ({
  id: `POD-${i}`,
  title: `issue ${i}`,
  status: 'open',
  archived: false,
  // most issues own a worktree; that is what grows the roots list
  worktreePath: i % 3 === 0 ? null : `${REPO}/.worktrees/issue-${i}-branch-${i}`,
}))
const sessions = Array.from({ length: SESSIONS }, (_, i) => ({
  sessionId: `s${i}`,
  name: `s${i}`,
  cwd: i % 5 === 0 ? `${worktreePaths[i % WORKTREES]}/apps/web/src` : worktreePaths[i % WORKTREES],
  archived: false,
  agentKind: 'claude',
  issueId: i % 4 === 0 ? `POD-${i % ISSUES}` : undefined,
}))

// ---- the two implementations, both from THIS checkout's source ------------
const { worktreeForCwd, buildWorktreeRootIndex, worktreeForCwdIndexed } = await import(
  '../../../packages/model/src/identity/worktree.ts'
)

const roots = [
  ...new Set([
    ...worktreePaths,
    ...issues.flatMap((i) => (i.worktreePath ? [i.worktreePath] : [])),
  ]),
]

/**
 * TIME AND COUNT ARE MEASURED SEPARATELY, deliberately: a counter inside the
 * timed loop is itself work, and on a box at load 47-79 the duration is noise
 * anyway. The COUNT is the defect; the duration is reported for colour only.
 */
function timed(build) {
  // warm, then take the best of 3 — the load on this box makes the mean useless
  build()
  let best = Infinity
  let answers
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint()
    answers = build()
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6)
  }
  return { ms: best, answers }
}

// SCAN (pre-POD-1645): one linear pass over `roots` per session.
const scan = timed(() => sessions.map((s) => worktreeForCwd(s.cwd, roots)))
// Its cost, counted rather than timed: one startsWith per root per session.
scan.calls = sessions.length * roots.length

// INDEXED (POD-1645): build once, then one map probe per path segment.
const indexed = timed(() => {
  const idx = buildWorktreeRootIndex(roots)
  return sessions.map((s) => worktreeForCwdIndexed(s.cwd, idx))
})

// exact probe count for the indexed pass — instrumented OUTSIDE the timed run
const index = buildWorktreeRootIndex(roots)
let probes = 0
const counting = { get: (k) => (probes++, index.get(k)) }
for (const s of sessions) worktreeForCwdIndexed(s.cwd, counting)

// PARITY — the number is worthless if the answers changed.
const disagreements = scan.answers.filter((a, i) => a !== indexed.answers[i]).length

console.log(`corpus: ${SESSIONS} sessions, ${ISSUES} issues, ${roots.length} roots`)
console.log('')
console.log('PER INDEX BUILD (string comparisons / map probes):')
console.log(`  scan    : ${scan.calls.toLocaleString()}  (${scan.ms.toFixed(1)} ms)`)
console.log(
  `  indexed : ${(roots.length + probes).toLocaleString()}  (${indexed.ms.toFixed(1)} ms)  = ${roots.length.toLocaleString()} build + ${probes.toLocaleString()} probes`,
)
console.log(`  ratio   : ${(scan.calls / (roots.length + probes)).toFixed(0)}x fewer`)
console.log('')
console.log('PER DELTA (publishReplica fans one delta into 3 recomputes):')
console.log(`  before  : 3 builds = ${(3 * scan.calls).toLocaleString()} comparisons`)
console.log(`  after   : 1 build  = ${(roots.length + probes).toLocaleString()} probes`)
console.log(
  `  ratio   : ${((3 * scan.calls) / (roots.length + probes)).toFixed(0)}x fewer per delta frame`,
)
console.log('')
console.log(`parity: ${disagreements} disagreement(s) across ${SESSIONS} sessions`)
if (disagreements !== 0) process.exitCode = 1
