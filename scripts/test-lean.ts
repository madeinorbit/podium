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
 * Four files out of the 955 this same config collects is not a suite, and a green
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
 * WHY THE DENOMINATOR IS DERIVED PER RUN rather than written down. A hardcoded
 * "4 of ~950" is a number that rots, and a rotted number in a banner about
 * misleading numbers would be its own joke. `vitest list --filesOnly` asks the
 * runner to resolve the lane from its own config — the same globs, the same
 * exclusions — and costs ~1.4s with no forks and no test execution, against a
 * gate that already spends ~50s in Vitest alone.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  const proc = Bun.spawn(vitestCommand(['list', '--filesOnly', '--json']), {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`vitest list exited ${code}; cannot measure the lean gate`)
  const entries = JSON.parse(stdout) as { file: string }[]
  // Absolute paths come back from Vitest; the gate speaks repository-relative.
  return entries.map((entry) => entry.file.slice(repositoryRoot.length))
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0%'
  const value = (part / whole) * 100
  return `${value < 1 ? value.toFixed(1) : Math.round(value)}%`
}

export function footer(
  verdict: 'PASSED' | 'FAILED',
  ran: number,
  collected: number,
  lanes: string[],
): string {
  const lines = [
    RULE,
    `LEAN GATE ${verdict} — this is NOT the test suite.`,
    '',
    `Ran ${ran} of the ${collected} files ${LEAN_GATE_CONFIG} collects in its ` +
      `\`${LEAN_GATE_PROJECT}\` project (${percent(ran, collected)}):`,
    ...LEAN_GATE_FILES.map((file) => `  ${file}`),
    '',
    `Did NOT run the other ${collected - ran} files in that project, and did not run ` +
      `any of the ${lanes.length} other lanes:`,
    ...wrap(lanes, '  '),
    '',
    ...(verdict === 'PASSED'
      ? [
          'Report this as "lean gate green". It is evidence that boot and wiring are',
          'coherent — it is not evidence that the tests pass.',
        ]
      : [
          'The lean gate is red. This is the cheapest lane in the repository, so a',
          'failure here is a floor failure, not a flake to route around.',
        ]),
    'Package sweep: bun run test:full · which lane covers your change: docs/agents/testing.md',
    RULE,
  ]
  return lines.join('\n')
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
    `LEAN GATE — ${resolution.files.length} of ${resolution.collected} files in ` +
      `${LEAN_GATE_CONFIG} (${percent(resolution.files.length, resolution.collected)}). ` +
      'Not a suite run.',
  )
  console.log(RULE)

  const proc = Bun.spawn(vitestCommand(['run', '--maxWorkers=1', ...forwarded], resolution.files), {
    cwd: repositoryRoot,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await proc.exited

  console.log('')
  console.log(
    footer(code === 0 ? 'PASSED' : 'FAILED', resolution.files.length, resolution.collected, lanes),
  )
  process.exit(code)
}

if (import.meta.main) await main()
