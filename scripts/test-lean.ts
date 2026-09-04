/**
 * The lean gate — the body of `bun run test` [POD-2728].
 *
 * WHAT WENT WRONG, and it is a signalling failure rather than a scoping one. The
 * lean scope is deliberate and documented (AGENTS.md "Testing: one end-of-task
 * gate", docs/agents/testing.md): a bounded boot/wiring probe, no package sweep,
 * no heavy lease. Nothing about that is being changed here. What went wrong is
 * that the command is called `test` and, before this file existed, its last line
 * of output was Vitest's own
 *
 *     Test Files  4 passed (4)
 *          Tests  76 passed (76)
 *
 * which is indistinguishable from a suite run of the same shape. Agents across
 * this epic closed rounds citing "bun run test green (76 passed)" as their gate,
 * in good faith — they ran the command the repository calls `test` and it passed.
 * Four files out of the ~1000 this same config collects is not a suite, and a green
 * that reads like one teaches the fleet that green means shipped. So the fix is
 * a FOOTER the run cannot exit without: the last thing on the screen states the
 * scope, in the same place the misleading number used to sit.
 *
 * THE SECOND DEFECT, which is not cosmetic. The old script ended in
 * `--passWithNoTests`, so the four positional paths were unchecked: rename or
 * move any one of them and Vitest silently ran the remaining three and exited 0;
 * move all four and it printed "No test files found, exiting with code 0". A gate
 * that shrinks to nothing without saying so is the same class of defect this file
 * is named after, one layer down. The repository already refuses exactly this for
 * the server shards — `scripts/test-configuration.test.ts` asserts
 * `passWithNoTests === false` on every one of them, because "an explicit file list
 * that collects nothing means the manifest and the filesystem disagree". The lean
 * gate is an explicit file list too, and was the one lane exempt from its own rule.
 * {@link resolveLaneAgainst} closes that: every named file must appear in the lane's
 * real collection or the gate refuses to run at all.
 *
 * THE THIRD DEFECT WAS IN THE FIX FOR THE FIRST TWO, found in adversarial review of
 * 719e55460 and repaired here. That version resolved the lane WITHOUT the caller's
 * argv and then ran WITH it, and printed a footer built from the INTENT list — so
 * "Ran 4 of the N files" was structurally incapable of saying anything but 4:
 *
 *     bun run test --shard=1/4    ran one file, footer claimed four
 *     bun run test -t=<no match>  ran ZERO tests, exit 0, footer said "report this
 *                                 as lean gate green"
 *
 * The second is this file's own invariant failing on the lane it was written for,
 * and both were a REGRESSION against the four-file script, whose last line was at
 * least Vitest's honest `Tests 79 skipped (79)`. An authoritative wrong number is
 * worse than a bare one. The repair is the discipline this issue used everywhere
 * else, turned on our own output: {@link reconcileExecution} reads Vitest's JSON
 * report and counts what ACTUALLY EXECUTED, {@link footer} can only be handed that
 * reconciliation, and a run narrower than the resolved scope — a shard, a `-t`
 * that matches nothing, a `describe.skip` — exits non-zero.
 *
 * Note that the fix is deliberately NOT "forward argv to the resolution step too".
 * That would make the two agree while leaving `--shard=1/4` a green: the lane would
 * resolve to one file and the gate would pass having run a quarter of its floor.
 * The scope is fixed; only the run's OUTCOME is evidence about it.
 *
 * WHY THE DENOMINATOR IS DERIVED PER RUN rather than written down. A hardcoded
 * "4 of ~950" is a number that rots, and a rotted number in a banner about
 * misleading numbers would be its own joke. `vitest list --filesOnly` asks the
 * runner to resolve the lane from its own config — the same globs, the same
 * exclusions — and costs ~1.4s with no forks and no test execution, against a
 * gate that already spends ~50s in Vitest alone.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repository root, with a trailing separator, resolved from this file rather than cwd.
 *
 * `import.meta.url`, not Bun's `import.meta.dir`: this module is imported by the drift
 * guard under Vitest, whose transform does not provide the Bun-only form — the same
 * reason scripts/server-test-shards.ts spells it this way.
 */
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

/**
 * The lean gate's scope, as repository-relative paths.
 *
 * This list is the ONE definition. It used to live as positional arguments inside
 * the `test` script in package.json, where `scripts/test-configuration.test.ts`
 * could only assert it as substrings of a command line; the guard now imports it.
 * Each file is a cheap, hermetic probe of a distinct startup seam — see the table
 * in docs/agents/testing.md for what each one protects.
 */
export const LEAN_GATE_FILES: readonly string[] = [
  'packages/runtime/src/boot.test.ts',
  'apps/server/src/router.setup.test.ts',
  'apps/daemon/src/connection-state.test.ts',
  'scripts/test-configuration.test.ts',
]

/** The lane the gate takes its four files from, and whose size it reports against. */
export const LEAN_GATE_CONFIG = 'vitest.unit.config.ts'
export const LEAN_GATE_PROJECT = 'node'

/**
 * Where Vitest is told to leave its machine-readable tally.
 *
 * Under node_modules because it is a build artefact of a single run, is already
 * ignored by git, and is guaranteed writable wherever the runner itself resolved.
 * {@link main} deletes it before spawning: a stale report from an earlier run is
 * the one input that could make this gate certify a run that never happened.
 */
const REPORT_PATH = join(repositoryRoot, 'node_modules', '.cache', 'lean-gate', 'report.json')

/**
 * Every other lane, named rather than implied — READ OFF THE SCRIPT REGISTRY, never
 * written down here.
 *
 * "It did not run the suite" is easy to skim past; the names of twenty-odd lanes it
 * did not run is not. But a hand-kept list of them would be the same species of bug
 * as the one this file exists to fix: a new lane would be added to package.json and
 * the footer would go on claiming a set that no longer matches, and an agent reading
 * only the output would again be told something untrue. So the list is package.json's
 * own `test*` scripts, minus this gate and its alias. Add a lane and it appears here
 * on the next run without anyone remembering to do anything.
 *
 * `//`-prefixed keys are package.json's comment convention — documentation about a
 * lane, not a lane.
 */
export function otherLanes(scripts: Record<string, string>): string[] {
  return Object.keys(scripts)
    .filter((name) => /^test(:|$)/.test(name))
    .filter((name) => name !== 'test' && scripts[name] !== 'bun run test')
    .sort()
}

const RULE = '─'.repeat(78)

/** Wrap a comma-separated list so the footer stays inside a terminal. */
function wrap(items: string[], indent: string, width = 76): string[] {
  const lines: string[] = []
  let line = indent
  for (const [index, item] of items.entries()) {
    const piece = index === items.length - 1 ? item : `${item},`
    if (line !== indent && `${line} ${piece}`.length > width) {
      lines.push(line)
      line = indent
    }
    line = line === indent ? indent + piece : `${line} ${piece}`
  }
  if (line !== indent) lines.push(line)
  return lines
}

/**
 * `bun --bun <vitest.mjs> <subcommand> --config … --project … <flags> <files>`.
 *
 * `bun --bun` and the explicit path into node_modules, not the `vitest` bin: the
 * suite runs under the Bun runtime so tests exercise the same bun:sqlite driver the
 * shipped binary does (POD-552), and the shape is the one every other lane in
 * package.json uses.
 */
export function vitestCommand(subcommand: string[], positionals: string[] = []): string[] {
  return [
    'bun',
    '--bun',
    join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    ...subcommand,
    '--config',
    LEAN_GATE_CONFIG,
    '--project',
    LEAN_GATE_PROJECT,
    ...positionals,
  ]
}

export type LaneResolution =
  | { ok: true; collected: number; files: string[] }
  | { ok: false; collected: number; missing: string[] }

/**
 * Check the gate's four files against what the lane actually collects, and measure
 * the lane while we are there.
 *
 * DERIVED FROM THE RUNNER, never from a glob of our own: `vitest list --filesOnly`
 * loads {@link LEAN_GATE_CONFIG}, applies its includes and its long exclusion list,
 * and reports the specifications it resolved. A file can therefore be MISSING here
 * for two different reasons that both matter — it no longer exists at that path, or
 * it still exists but an exclusion now swallows it — and a gate silently reduced by
 * either is exactly what this run must refuse.
 */
export function resolveLaneAgainst(
  collectedFiles: string[],
  wanted: readonly string[] = LEAN_GATE_FILES,
): LaneResolution {
  const collected = new Set(collectedFiles)
  const missing = wanted.filter((file) => !collected.has(file))
  if (missing.length > 0) return { ok: false, collected: collected.size, missing }
  return { ok: true, collected: collected.size, files: [...wanted] }
}

async function collectLaneFiles(): Promise<string[]> {
  // The list goes through a file, not the pipe. Vitest exits as soon as it has written,
  // and a piped stdout is not drained by then once the list passes the pipe buffer —
  // a long checkout path takes it well past 200 KB — so the JSON arrived cut mid-string
  // and the gate died before it measured anything (podium-cloud PDM-47).
  const listPath = join(dirname(REPORT_PATH), 'lean-gate-files.json')
  mkdirSync(dirname(listPath), { recursive: true })
  const proc = Bun.spawn(vitestCommand(['list', '--filesOnly', `--json=${listPath}`]), {
    cwd: repositoryRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`vitest list exited ${code}; cannot measure the lean gate`)
  const entries = JSON.parse(readFileSync(listPath, 'utf8')) as { file: string }[]
  // Absolute paths come back from Vitest; the gate speaks repository-relative.
  return entries.map((entry) => entry.file.slice(repositoryRoot.length))
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0%'
  const value = (part / whole) * 100
  return `${value < 1 ? value.toFixed(1) : Math.round(value)}%`
}

/** The subset of Vitest's `json` reporter output this gate reads. */
export type VitestJsonReport = {
  testResults?: {
    name: string
    assertionResults?: { status: string }[]
  }[]
}

/** One gate file, as the runner reported it — never as we asked for it. */
export type FileExecution = {
  file: string
  /** Assertions that actually ran: `passed` or `failed`. Everything else did not. */
  executed: number
  /** Assertions the runner reported but did not run — skipped, pending, todo. */
  skipped: number
  failed: number
}

export type Reconciliation = {
  /** True only when every file in the resolved scope executed at least one test. */
  ok: boolean
  files: FileExecution[]
  /** Files in the resolved scope that executed nothing, with why as the runner saw it. */
  shortfall: { file: string; reason: 'never ran' | 'every test skipped' }[]
  ranFiles: number
  ranTests: number
  skippedTests: number
  failedTests: number
}

/**
 * Count what Vitest ACTUALLY EXECUTED, from its own JSON report.
 *
 * This is the whole repair of the third defect, and the reason it is shaped as a
 * pure function over the report rather than as a flag check on argv: there are at
 * least three ways to narrow a run — `--shard`, a `-t` filter that matches nothing,
 * a `describe.skip` committed to one of the four files — and only the last of those
 * is even visible in argv. Enumerating the ways to shrink a gate is the losing side
 * of that game. Reading how much of it ran is not.
 *
 * A file is present-but-empty when the runner lists it with assertions that all came
 * back `skipped`/`pending`/`todo`; that is exactly what `-t=<no match>` produces, and
 * Vitest calls the file `passed` and exits 0 for it. So "the runner said 0 failures"
 * is not evidence of anything, and this counts the positive quantity instead.
 */
export function reconcileExecution(
  report: VitestJsonReport,
  wanted: readonly string[] = LEAN_GATE_FILES,
): Reconciliation {
  const byFile = new Map<string, FileExecution>()
  for (const result of report.testResults ?? []) {
    const file = result.name.startsWith(repositoryRoot)
      ? result.name.slice(repositoryRoot.length)
      : result.name
    const assertions = result.assertionResults ?? []
    const executed = assertions.filter((a) => a.status === 'passed' || a.status === 'failed')
    byFile.set(file, {
      file,
      executed: executed.length,
      skipped: assertions.length - executed.length,
      failed: assertions.filter((a) => a.status === 'failed').length,
    })
  }

  const files = wanted.map(
    (file) => byFile.get(file) ?? { file, executed: 0, skipped: 0, failed: 0 },
  )
  const shortfall = files
    .filter((entry) => entry.executed === 0)
    .map((entry) => ({
      file: entry.file,
      reason: (byFile.has(entry.file) ? 'every test skipped' : 'never ran') as
        | 'never ran'
        | 'every test skipped',
    }))

  return {
    ok: shortfall.length === 0,
    files,
    shortfall,
    ranFiles: files.filter((entry) => entry.executed > 0).length,
    ranTests: files.reduce((sum, entry) => sum + entry.executed, 0),
    skippedTests: files.reduce((sum, entry) => sum + entry.skipped, 0),
    failedTests: files.reduce((sum, entry) => sum + entry.failed, 0),
  }
}

export type Verdict = 'PASSED' | 'FAILED' | 'INCOMPLETE'

/**
 * The last thing the gate prints, built from {@link Reconciliation} and nothing else.
 *
 * The signature is the guard rail. The previous version took a plain `ran: number`
 * and {@link main} handed it the length of the intent list, which no reading of the
 * footer could have caught. There is no longer a number to hand it: the only way to
 * obtain a `Reconciliation` is to parse a report the runner wrote, and the file names
 * below come from that report too rather than from {@link LEAN_GATE_FILES}.
 */
export function footer(
  verdict: Verdict,
  execution: Reconciliation,
  collected: number,
  lanes: string[],
): string {
  const ran = execution.ranFiles
  const lines = [
    RULE,
    `LEAN GATE ${verdict} — this is NOT the test suite.`,
    '',
    `Ran ${ran} of the ${collected} files ${LEAN_GATE_CONFIG} collects in its ` +
      `\`${LEAN_GATE_PROJECT}\` project (${percent(ran, collected)}), ` +
      `${execution.ranTests} tests executed` +
      (execution.skippedTests > 0 ? `, ${execution.skippedTests} skipped:` : ':'),
    ...execution.files.map(
      (entry) =>
        `  ${entry.file} — ${
          entry.executed === 0
            ? entry.skipped > 0
              ? `NOTHING RAN (${entry.skipped} skipped)`
              : 'NOTHING RAN'
            : `${entry.executed} tests${entry.skipped > 0 ? `, ${entry.skipped} skipped` : ''}`
        }`,
    ),
    '',
    `Did NOT run the other ${collected - ran} files in that project, and did not run ` +
      `any of the ${lanes.length} other lanes:`,
    ...wrap(lanes, '  '),
    '',
  ]

  if (verdict === 'INCOMPLETE') {
    lines.push(
      'The run was NARROWER THAN THE GATE, so it is not evidence about the gate.',
      'A shard, a `-t` filter matching nothing, or a `.skip` left in one of these',
      'files will do this, and Vitest exits 0 for all three. Four files is already',
      'the floor; a fraction of it has nothing left to stand on. Re-run as plain',
      '`bun run test`, with no filter and no shard.',
    )
  } else if (verdict === 'PASSED') {
    lines.push(
      'Report this as "lean gate green". It is evidence that boot and wiring are',
      'coherent — it is not evidence that the tests pass.',
    )
  } else {
    lines.push(
      'The lean gate is red. This is the cheapest lane in the repository, so a',
      'failure here is a floor failure, not a flake to route around.',
    )
  }

  lines.push(
    'Package sweep: bun run test:full · which lane covers your change: docs/agents/testing.md',
    RULE,
  )
  return lines.join('\n')
}

function readReport(): VitestJsonReport {
  return JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as VitestJsonReport
}

async function main() {
  const forwarded = process.argv.slice(2)

  const { scripts } = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const lanes = otherLanes(scripts)

  const collectedFiles = await collectLaneFiles()
  const resolution = resolveLaneAgainst(collectedFiles)
  if (!resolution.ok) {
    // No `--passWithNoTests` anywhere below, and no partial run here either. A gate
    // that quietly narrows is worse than one that stops, because the narrowed run
    // still prints a green.
    console.error(RULE)
    console.error('LEAN GATE REFUSED — its own scope no longer resolves.')
    console.error('')
    console.error(
      `${resolution.missing.length} of ${LEAN_GATE_FILES.length} named files are not ` +
        `collected by ${LEAN_GATE_CONFIG} (\`${LEAN_GATE_PROJECT}\` project):`,
    )
    for (const file of resolution.missing) console.error(`  ${file}`)
    console.error('')
    console.error('Either the file moved, or an exclusion now swallows it. Running the')
    console.error('remainder would print a green for a gate that had silently shrunk, so')
    console.error('this stops instead. Fix the path in scripts/test-lean.ts (LEAN_GATE_FILES)')
    console.error('or the exclusion in vitest.unit.config.ts.')
    console.error(RULE)
    process.exit(1)
  }

  console.log(RULE)
  console.log(
    `LEAN GATE — will run ${resolution.files.length} of ${resolution.collected} files in ` +
      `${LEAN_GATE_CONFIG} (${percent(resolution.files.length, resolution.collected)}). ` +
      'Not a suite run.',
  )
  console.log(RULE)

  // Delete first: a report left by an earlier run is the one input that could let
  // this gate certify a run that did not happen.
  rmSync(REPORT_PATH, { force: true })
  mkdirSync(dirname(REPORT_PATH), { recursive: true })

  const proc = Bun.spawn(
    vitestCommand(
      [
        'run',
        '--maxWorkers=1',
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${REPORT_PATH}`,
        ...forwarded,
      ],
      resolution.files,
    ),
    { cwd: repositoryRoot, stdio: ['inherit', 'inherit', 'inherit'] },
  )
  const code = await proc.exited

  let execution: Reconciliation
  try {
    execution = reconcileExecution(readReport())
  } catch (error) {
    // Same rule as a failed resolution: an unreadable tally is not a pass. This is
    // reachable by forwarding a `--reporter`/`--outputFile` of one's own, and by a
    // runner that died before writing.
    console.error('')
    console.error(RULE)
    console.error('LEAN GATE REFUSED — the run left no readable tally.')
    console.error('')
    console.error(`Expected Vitest's json report at ${REPORT_PATH}`)
    console.error(`but ${error instanceof Error ? error.message : String(error)}.`)
    console.error('')
    console.error('Without it there is no way to tell how much of the gate executed, and')
    console.error('an unverified green is the defect this gate exists to fix. Re-run as')
    console.error('plain `bun run test`, without your own --reporter or --outputFile.')
    console.error(RULE)
    process.exit(code === 0 ? 1 : code)
  }

  const verdict: Verdict = !execution.ok ? 'INCOMPLETE' : code === 0 ? 'PASSED' : 'FAILED'
  console.log('')
  console.log(footer(verdict, execution, resolution.collected, lanes))
  // INCOMPLETE with a zero exit is the case the review caught: Vitest exits 0 for a
  // shard and for a filter that matched nothing. The gate must not inherit that.
  process.exit(code === 0 && verdict === 'INCOMPLETE' ? 1 : code)
}

if (import.meta.main) await main()
