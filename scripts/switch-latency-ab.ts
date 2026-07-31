/**
 * SWITCH-LATENCY A/B BENCH — the canonical quantitative source for POD-310's
 * rehearsal and POD-337's release gate [POD-736].
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHY IT IS IN-PROCESS
 * ---------------------------------------------------------------------------
 *
 * POD-701's browser bench (`tests/e2e/switch-bench.ts`) measures the number a
 * USER feels: gesture → chat first paint, across a real Chromium. It is still the
 * right instrument for that number and it is unchanged. It is the wrong
 * instrument for an A/B ACROSS THE CUTOVER, for a reason that is structural
 * rather than practical: the pre-cutover arm no longer exists to be re-run, so
 * one side of that comparison can only ever be a quoted figure — and a quoted
 * client-side p50 carries the browser, the machine and the day it was measured
 * inside it.
 *
 * This bench measures the SERVER's share of a switch at representative scale, in
 * one process, from the same registry the product composes. Both arms of an A/B
 * run through the same driver on the same host minutes apart, so the difference
 * is the code and not the weather.
 *
 * ---------------------------------------------------------------------------
 * IT REPORTS SLICE SIZE OR IT REPORTS NOTHING
 * ---------------------------------------------------------------------------
 *
 * After POD-1077 the feed is per-principal. A p50 measured over the whole feed
 * and a p50 measured over one person's slice are not the same measurement, and
 * comparing them reports a speedup that is really a smaller working set. So the
 * report is written per principal WITH its slice size, and a comparison the
 * reader draws across two different slice sizes is invalid rather than noisy.
 * `--compare` refuses to draw one.
 *
 * Usage:
 *   bun scripts/switch-latency-ab.ts --out arm-b.json --label "authority-feed"
 *   bun scripts/switch-latency-ab.ts --compare arm-a.json arm-b.json
 *
 * Env: BENCH_SESSIONS (588), BENCH_ISSUES (800), BENCH_CYCLES (250).
 */

import type { IssueRow } from '../apps/server/src/store'
import type { PerfPrincipalSlice, PerfSnapshot } from '@podium/protocol'

// The server is imported DYNAMICALLY, inside `runArm`, and that is load-bearing
// rather than tidy: `--compare` reads two JSON reports and must run against ANY
// checkout — including one whose server does not resolve, which is exactly the
// situation when you are comparing an arm measured on an older tree. A static
// import would make the comparison tool need the very code it is comparing.

const SESSION_COUNT = Number(process.env.BENCH_SESSIONS ?? 588)
const ISSUE_COUNT = Number(process.env.BENCH_ISSUES ?? 800)
const CYCLES = Number(process.env.BENCH_CYCLES ?? 250)

/** The phases a switch is made of, post-cutover. Named here rather than
 *  discovered, so a phase that STOPS being emitted shows up as a hole in the
 *  report instead of quietly shrinking the total. */
const SWITCH_PHASES = [
  'ws.attach',
  'ws.detach',
  'feedPublish.total',
  'feedPublish.scope',
  'feedPublish.frame',
  'feedPublish.fanout',
  'feedBootstrap.total',
  'feedBootstrap.read',
  // Carried over from the pre-cutover contract; still emitted, still its own work.
  'sessionsBroadcast.total',
  'sessionsBroadcast.publishIssues',
  'sessionsBroadcast.publishIssuesSkipped',
] as const

interface ArmReport {
  label: string
  at: string
  scale: { sessions: number; issues: number; cycles: number }
  /** Per principal: the phases, and the slice size they were measured over. */
  principals: Array<{
    digest: string
    kind: string
    sliceSize: PerfPrincipalSlice['sliceSize']
    phases: Record<string, { count: number; p50Ms: number; p90Ms: number; p99Ms: number }>
  }>
  /** Deployment-wide, for continuity with the POD-701 baselines, which are in
   *  this shape and must stay readable. NEVER the basis of a cross-cutover
   *  comparison on its own — see the header. */
  deploymentWide: Record<string, { count: number; p50Ms: number; p90Ms: number; p99Ms: number }>
  /** Wall-clock per client-observed switch: attach → publication seen. */
  interaction: { count: number; p50Ms: number; p90Ms: number; p99Ms: number }
}

function issueRow(seq: number): IssueRow {
  const timestamp = '2026-07-18T00:00:00.000Z'
  return {
    id: `iss_bench_${seq}`,
    repoPath: '/switch-latency-bench',
    seq,
    title: `Bench issue ${seq}`,
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'shell',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    design: null,
    acceptance: null,
    notes: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    supersededBy: null,
    duplicateOf: null,
    pinned: false,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
  }
}

const percentile = (values: number[], q: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return Math.round((sorted[index] ?? 0) * 100) / 100
}

const summarize = (values: number[]) => ({
  count: values.length,
  p50Ms: percentile(values, 0.5),
  p90Ms: percentile(values, 0.9),
  p99Ms: percentile(values, 0.99),
})

const round = (n: number): number => Math.round(n * 100) / 100

const pickPhases = (
  phases: PerfSnapshot['phases'],
): Record<string, { count: number; p50Ms: number; p90Ms: number; p99Ms: number }> => {
  const out: Record<string, { count: number; p50Ms: number; p90Ms: number; p99Ms: number }> = {}
  for (const name of SWITCH_PHASES) {
    const summary = phases[name]
    if (summary === undefined) continue
    out[name] = {
      count: summary.count,
      p50Ms: round(summary.p50Ms),
      p90Ms: round(summary.p90Ms),
      p99Ms: round(summary.p99Ms),
    }
  }
  return out
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for publication')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

async function runArm(label: string): Promise<ArmReport> {
  const { SessionRegistry } = await import('../apps/server/src/relay')
  const { SessionStore } = await import('../apps/server/src/store')
  const store = new SessionStore(':memory:')
  store.transact(() => {
    for (let seq = 1; seq <= ISSUE_COUNT; seq += 1) store.issues.upsertIssue(issueRow(seq))
  })
  const registry = new SessionRegistry(store)
  const sessionIds: string[] = []
  try {
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      sessionIds.push(
        registry.modules.sessions.createSession({
          agentKind: 'shell',
          cwd: `/switch-latency-bench/session-${index}`,
        }).sessionId,
      )
    }
    registry.modules.sessions.flushBroadcasts()

    const publications: string[] = []
    const clientId = registry.clientGateway.attachClient(() => {}, {
      sendPrepared: (bytes) => publications.push(bytes),
      principal: 'bench-operator',
      scope: 'principal:bench-operator',
      serverRole: 'standalone',
      protocolVersion: 1,
      global: true,
      snapshot: () => ({ revision: 1, allowedSignature: 'all', allowedSessionIds: sessionIds }),
    })
    registry.clientGateway.routeClientFrame(clientId, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    await until(() => publications.length > 0)
    await until(() => registry.modules.sessions.publicationMetrics().queueDepth === 0)
    await new Promise((resolve) => setTimeout(resolve, 250))

    // MEASURE FROM HERE. Everything above is fixture construction, and letting it
    // into the window is how a bench reports its own setup as switch cost.
    registry.modules.perf.reset()
    // The reset threw away the bootstrap's slice-size observation along with
    // everything else, so re-serve one connection to put a MEASURED slice size
    // back in the window. Without this the report would carry `samples: 0` and
    // the comparison would have nothing to control for — which the report format
    // would show honestly, and which would make the run useless.
    const observer = registry.clientGateway.attachClient(() => {})
    registry.clientGateway.routeClientFrame(observer, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })

    const interactionMs: number[] = []
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const target = sessionIds[cycle % sessionIds.length]
      if (target === undefined) throw new Error('bench session fixture is empty')
      for (const type of ['attach', 'detach'] as const) {
        const before = publications.length
        const startedAt = performance.now()
        registry.clientGateway.routeClientFrame(clientId, { type, sessionId: target })
        registry.modules.sessions.flushBroadcasts()
        await until(() => publications.length > before)
        interactionMs.push(performance.now() - startedAt)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await until(() => registry.modules.sessions.publicationMetrics().queueDepth === 0)

    const snapshot = registry.modules.perf.snapshot()
    return {
      label,
      at: new Date().toISOString(),
      scale: { sessions: SESSION_COUNT, issues: ISSUE_COUNT, cycles: CYCLES },
      // `?? {}` so this ONE script runs against a PRE-CUTOVER tree too, where
      // `byPrincipal` does not exist. That is what makes arm A a measurement
      // rather than a quotation: same driver, same host, same day. The empty
      // table is then honest — an old tree has no per-principal dimension, and
      // `--compare` refuses to draw a per-principal conclusion from it.
      principals: Object.values(snapshot.byPrincipal ?? {}).map((slice) => ({
        digest: slice.principal.digest,
        kind: slice.principal.kind,
        sliceSize: slice.sliceSize,
        phases: pickPhases(slice.phases),
      })),
      deploymentWide: pickPhases(snapshot.phases),
      interaction: summarize(interactionMs),
    }
  } finally {
    registry.dispose()
    store.close()
  }
}

/**
 * Compare two arms — and REFUSE when the comparison would be invalid.
 *
 * The refusal is the feature. A bench that prints a percentage whatever it is
 * handed is the instrument that cannot say no, and the specific way this one
 * would lie is well understood: a post-cutover arm measured over a smaller slice
 * looks like a win. So a differing slice size is an ERROR, not a footnote.
 */
function compare(a: ArmReport, b: ArmReport): number {
  console.log(`A: ${a.label}  (${a.at})`)
  console.log(`B: ${b.label}  (${b.at})`)
  if (
    a.scale.sessions !== b.scale.sessions ||
    a.scale.issues !== b.scale.issues ||
    a.scale.cycles !== b.scale.cycles
  ) {
    console.error(
      `INVALID: the arms ran at different scale — A ${JSON.stringify(a.scale)} vs B ${JSON.stringify(b.scale)}.`,
    )
    return 1
  }
  const principalsOf = (r: ArmReport) => new Map(r.principals.map((p) => [p.digest, p]))
  const aP = principalsOf(a)
  const bP = principalsOf(b)
  const shared = [...aP.keys()].filter((d) => bP.has(d))
  if (shared.length === 0) {
    console.error(
      'INVALID: the arms share no principal. A cross-principal comparison is not a comparison — ' +
        'see docs/multi-user-readiness.md and the POD-736 acceptance criteria.',
    )
    return 1
  }
  let invalid = 0
  for (const digest of shared) {
    const left = aP.get(digest)!
    const right = bP.get(digest)!
    console.log(`\nprincipal ${digest} (${left.kind})`)
    if (left.sliceSize.samples === 0 || right.sliceSize.samples === 0) {
      console.error(
        `  INVALID: a slice size was never measured (A samples=${left.sliceSize.samples}, ` +
          `B samples=${right.sliceSize.samples}). An unmeasured slice is not a slice of 0.`,
      )
      invalid += 1
      continue
    }
    if (left.sliceSize.last !== right.sliceSize.last) {
      console.error(
        `  INVALID: slice sizes differ (A ${left.sliceSize.last} rows, B ${right.sliceSize.last} rows). ` +
          'A speedup across differing working sets is not a speedup.',
      )
      invalid += 1
      continue
    }
    console.log(`  slice size ${left.sliceSize.last} rows — like for like`)
    const names = [...new Set([...Object.keys(left.phases), ...Object.keys(right.phases)])].sort()
    for (const name of names) {
      const l = left.phases[name]
      const r = right.phases[name]
      const fmt = (v?: { p50Ms: number; p90Ms: number }) =>
        v === undefined ? 'absent' : `p50 ${v.p50Ms}ms / p90 ${v.p90Ms}ms`
      console.log(`  ${name.padEnd(40)} A ${fmt(l).padEnd(28)} B ${fmt(r)}`)
    }
  }
  console.log(
    `\ninteraction (wall-clock per attach/detach): A p50 ${a.interaction.p50Ms}ms / p90 ${a.interaction.p90Ms}ms` +
      ` → B p50 ${b.interaction.p50Ms}ms / p90 ${b.interaction.p90Ms}ms`,
  )
  return invalid > 0 ? 1 : 0
}

const args = process.argv.slice(2)
const compareAt = args.indexOf('--compare')
if (compareAt !== -1) {
  const [pathA, pathB] = [args[compareAt + 1], args[compareAt + 2]]
  if (pathA === undefined || pathB === undefined) {
    console.error('usage: --compare <arm-a.json> <arm-b.json>')
    process.exit(2)
  }
  const a = (await Bun.file(pathA).json()) as ArmReport
  const b = (await Bun.file(pathB).json()) as ArmReport
  process.exit(compare(a, b))
}

const labelAt = args.indexOf('--label')
const outAt = args.indexOf('--out')
const label = labelAt === -1 ? 'unlabelled' : (args[labelAt + 1] ?? 'unlabelled')
const report = await runArm(label)
const out = outAt === -1 ? `switch-latency-${label}.json` : args[outAt + 1]!
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`)
for (const p of report.principals) {
  console.log(
    `principal ${p.digest} (${p.kind}) slice=${p.sliceSize.last} rows (samples=${p.sliceSize.samples})`,
  )
  for (const [name, s] of Object.entries(p.phases)) {
    console.log(`  ${name.padEnd(40)} n=${String(s.count).padEnd(6)} p50 ${s.p50Ms}ms p90 ${s.p90Ms}ms`)
  }
}
console.log(
  `interaction p50 ${report.interaction.p50Ms}ms p90 ${report.interaction.p90Ms}ms over ${report.interaction.count} switches → ${out}`,
)
