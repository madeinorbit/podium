/**
 * WHICH LANE WOULD HAVE SEEN THIS? — the check that makes a failing-name diff
 * state its own blast radius [PDM-343].
 *
 *   bun scripts/check-lane-coverage.ts --census
 *   bun scripts/check-lane-coverage.ts --probe
 *   bun scripts/check-lane-coverage.ts --base <ref> --lane services --lane store
 *
 * WHY THIS EXISTS. The epic's standing rule is that the set difference of failing
 * test NAMES against the branch point is the artefact. The rule is right and it
 * has a hole: a name diff can only report on files the lanes it ran actually
 * list. Phase B took every one of those diffs over the five `apps/server` shards.
 * Those shards list 512 test files; the root integration config lists 78; the
 * intersection is EMPTY — not small, empty. So three regressions in
 * `apps/daemon` and `scripts` sat in a blind spot that no amount of care with
 * the diff itself could have reached, and PDM-276 reported a clean set
 * difference in perfect good faith, because it was clean over what it measured.
 *
 * A COUNT OF LANES IS NOT THE POINT; THE CLAIM IS. This does not try to decide
 * which lanes you ought to run. It answers one question — given the files this
 * change touches, which of them is no lane in your claimed set even LOOKING at?
 * — and refuses the claim when the answer is not "none". That is the difference
 * between a diff that is clean and a diff that is clean about the right files.
 *
 * WHY IT IS NOT A LIST OF LANES AND FILES. Catalogue shape 7: a check that
 * compares a hand-kept list against the system is a check against a second copy
 * of the same assumption, and a file missing from BOTH stays invisible. So both
 * halves are derived. Lanes are discovered by globbing the configs that define
 * them, and each lane's file set comes from `vitest list --filesOnly` on that
 * config — vitest's own resolution of its own globs, not a reimplementation of
 * them here. When a config's globs change, this changes with them and nobody
 * has to remember.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. It reasons about changed TEST files, not
 * about which tests a changed SOURCE file can reach. Import reachability is a
 * real and harder question — `packages/janitor/src/janitor.ts` broke a smoke in
 * `scripts/` with no test file in the diff at all — and a half-built reachability
 * walk that silently shrinks is worse than none (it reports a shrinking graph as
 * a clean one). The source half is left to its own issue rather than approximated
 * here, and `--census` prints the lane map that makes the manual answer cheap.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const VITEST = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs')

export interface Lane {
  /** How a receipt names this lane: `integration`, `server:store`, … */
  readonly name: string
  /** Repo-root-relative path of the config that defines it. */
  readonly config: string
}

/**
 * Every vitest config in the repo, as a lane.
 *
 * WALKED, NOT LISTED, AND THIS FILE GOT IT WRONG FIRST. The original version
 * scanned the root plus `apps/*` and `packages/*` — a hand-kept list of places
 * lanes are allowed to live, which is catalogue shape 7 committed by the very
 * script written to detect it. It silently missed four configs:
 * `scripts/vitest.config.ts`, `scripts/vitest.rearch.config.ts`,
 * `services/telemetry-relay/vitest.config.ts` and `tests/keyecho/vitest.config.ts`
 * — and a lane this cannot see is a lane it will happily tell you covers
 * nothing. Reading `workspaces` from package.json would have been the same
 * mistake one level up, because a config can sit in a directory that is not a
 * workspace member. So the filesystem is the only source: walk it, skipping the
 * places no source lives.
 */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', 'target'])

export function discoverLanes(root = REPO_ROOT): Lane[] {
  const lanes: Lane[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)
        continue
      }
      if (!/^vitest(\..+)?\.config\.ts$/.test(entry.name)) continue
      const middle = entry.name.slice('vitest.'.length, -'.config.ts'.length)
      const base = entry.name === 'vitest.config.ts' ? 'default' : middle
      lanes.push({
        name: prefix ? `${prefix}:${base}` : base,
        config: prefix ? `${prefix}/${entry.name}` : entry.name,
      })
    }
  }
  walk(root, '')
  return lanes.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The test files a lane runs, repo-root-relative, as VITEST resolves them.
 *
 * `--filesOnly` prints one `[project] path` per line, and the path is relative
 * to the config's own root — so `apps/server/vitest.store.config.ts` answers
 * `src/…`, which is resolved against that config's directory here rather than
 * against the repo root. Getting that wrong produces a lane whose every file
 * "is not covered", which reads exactly like a finding.
 */
const RESOLVED = new Map<string, string[]>()

export function laneFiles(lane: Lane, root = REPO_ROOT): string[] {
  // Memoised because resolving a lane costs a vitest startup (~15s here) and
  // the "where does this file run instead" answer asks every lane about every
  // unseen file — 36 lanes times n files of the same work, otherwise.
  const memo = RESOLVED.get(`${root}\u0000${lane.config}`)
  if (memo) return memo
  const configPath = join(root, lane.config)
  const cwd = dirname(configPath)
  const stdout = execFileSync(
    'bun',
    ['--bun', VITEST, 'list', '--config', configPath, '--filesOnly'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  )
  const files = new Set<string>()
  for (const line of stdout.split('\n')) {
    const path = line.replace(/^\[[^\]]*\]\s*/, '').trim()
    if (!path || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) continue
    files.add(relative(root, resolve(cwd, path)))
  }
  const sorted = [...files].sort()
  RESOLVED.set(`${root}\u0000${lane.config}`, sorted)
  return sorted
}

export interface CoverageClaim {
  /** Lanes the receipt says its name diff was taken over. */
  readonly lanes: readonly string[]
  /** Test files the change touches, repo-root-relative. */
  readonly changedTestFiles: readonly string[]
  /** name -> the files that lane lists. */
  readonly laneFiles: ReadonlyMap<string, readonly string[]>
}

export interface CoverageVerdict {
  /** Changed test files no claimed lane lists. A name diff cannot see these. */
  readonly unseen: string[]
  /** Claimed lane names that resolved to nothing — a vacuous claim, not a clean one. */
  readonly emptyLanes: string[]
  /** Claimed lane names that are not lanes at all. */
  readonly unknownLanes: string[]
}

/**
 * The verdict, as a pure function of the three inputs, so the probe can exercise
 * it without a repository, a git history or a vitest run.
 *
 * AN EMPTY LANE IS A FAILURE, NOT A PASS (catalogue shapes 9 and 13). If a
 * claimed lane lists no files, every changed file is trivially "not in it" and
 * the honest answer is that the claim was measured against nothing — which is
 * the exact shape this whole check exists to stop, so it must not be the way
 * this check itself goes quiet.
 */
export function judge(claim: CoverageClaim): CoverageVerdict {
  const unknownLanes: string[] = []
  const emptyLanes: string[] = []
  const covered = new Set<string>()
  for (const name of claim.lanes) {
    const files = claim.laneFiles.get(name)
    if (files === undefined) {
      unknownLanes.push(name)
      continue
    }
    if (files.length === 0) emptyLanes.push(name)
    for (const file of files) covered.add(file)
  }
  const unseen = claim.changedTestFiles.filter((file) => !covered.has(file)).sort()
  return { unseen, emptyLanes, unknownLanes }
}

/**
 * Test files this change touches, as git reports them against `base`.
 *
 * `head` defaults to the working branch and exists so this can be pointed at a
 * commit that has already landed — which is how the check was shown to catch
 * the change that motivated it rather than only the ones written after it.
 */
export function changedTestFiles(base: string, head = 'HEAD', root = REPO_ROOT): string[] {
  const stdout = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd: root,
    encoding: 'utf8',
  })
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(line))
    .sort()
}

/**
 * THE PROBE — proof the instrument can still fire, in BOTH directions.
 *
 * One plant catches a removal and never an addition, so a probe that only shows
 * an uncovered file being reported would stay green if `judge` learned to report
 * everything. The covered case is therefore asserted as loudly as the uncovered
 * one, and so are the two ways a claim can be vacuous rather than clean.
 */
function probe(): number {
  const lanes = new Map<string, readonly string[]>([
    ['services', ['apps/server/src/a.test.ts', 'apps/server/src/b.test.ts']],
    ['store', ['apps/server/src/store/c.test.ts']],
    ['integration', ['apps/daemon/src/d.integration.test.ts']],
    ['hollow', []],
  ])
  const failures: string[] = []
  const expect = (label: string, actual: unknown, wanted: unknown): void => {
    const a = JSON.stringify(actual)
    const w = JSON.stringify(wanted)
    if (a !== w) failures.push(`${label}: expected ${w}, got ${a}`)
  }

  // The defect this check exists for: a change touching a file outside every
  // claimed lane. This is exactly PDM-276's shape.
  expect(
    'uncovered file is reported',
    judge({
      lanes: ['services', 'store'],
      changedTestFiles: ['apps/server/src/a.test.ts', 'apps/daemon/src/d.integration.test.ts'],
      laneFiles: lanes,
    }).unseen,
    ['apps/daemon/src/d.integration.test.ts'],
  )

  // The other direction: a file the claimed lanes DO list must not be reported,
  // or the check is a blanket refusal that says nothing about anything.
  expect(
    'covered file is not reported',
    judge({
      lanes: ['services', 'store', 'integration'],
      changedTestFiles: ['apps/server/src/a.test.ts', 'apps/daemon/src/d.integration.test.ts'],
      laneFiles: lanes,
    }).unseen,
    [],
  )

  expect(
    'a lane listing nothing is not a clean claim',
    judge({ lanes: ['hollow'], changedTestFiles: [], laneFiles: lanes }).emptyLanes,
    ['hollow'],
  )

  expect(
    'a lane that does not exist is not a clean claim',
    judge({ lanes: ['servicez'], changedTestFiles: [], laneFiles: lanes }).unknownLanes,
    ['servicez'],
  )

  for (const failure of failures) console.error(`  probe FAILED  ${failure}`)
  if (failures.length > 0) {
    console.error(`\ncheck-lane-coverage: the instrument is broken (${failures.length} probe).`)
    return 1
  }
  console.log('check-lane-coverage: probe passed (4 plants, both directions).')
  return 0
}

function census(): number {
  const lanes = discoverLanes()
  const byLane = new Map<string, readonly string[]>()
  const everywhere = new Map<string, string[]>()
  for (const lane of lanes) {
    let files: string[]
    try {
      files = laneFiles(lane)
    } catch (error) {
      console.error(`  ${lane.name.padEnd(26)} FAILED TO RESOLVE  (${lane.config})`)
      console.error(`    ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      return 1
    }
    byLane.set(lane.name, files)
    for (const file of files) {
      const seen = everywhere.get(file)
      if (seen) seen.push(lane.name)
      else everywhere.set(file, [lane.name])
    }
  }
  console.log('LANE CENSUS — what each vitest config actually lists\n')
  for (const lane of lanes) {
    console.log(
      `  ${lane.name.padEnd(26)} ${String(byLane.get(lane.name)?.length ?? 0).padStart(5)}  ${lane.config}`,
    )
  }
  console.log(`\n  ${everywhere.size} test files across ${lanes.length} lanes.`)

  // A LANE THAT LISTS NOTHING IS THE THING THIS FILE IS ABOUT, pointed at the
  // configs themselves. It cannot go red, it cannot go green, and it reports a
  // clean exit either way -- so it is named here rather than left to be noticed
  // in a column of numbers (catalogue shapes 9 and 13).
  const empty = lanes.filter((lane) => (byLane.get(lane.name)?.length ?? 0) === 0)
  if (empty.length > 0) {
    console.log(`\n  LANES THAT LIST NO TEST FILE AT ALL (${empty.length}):`)
    for (const lane of empty) console.log(`    ${lane.name.padEnd(26)} ${lane.config}`)
  }

  // A file only one lane lists is only ever measured when that lane runs. Named
  // because the whole defect behind this script was a file set that exactly one
  // lane listed and nobody ran.
  const sole = [...everywhere.entries()].filter(([, names]) => names.length === 1)
  if (sole.length > 0) {
    console.log(`\n  TEST FILES LISTED BY EXACTLY ONE LANE (${sole.length}):`)
    for (const [file, names] of sole.sort()) console.log(`    ${names[0]?.padEnd(26)} ${file}`)
  }
  return 0
}

function main(argv: string[]): number {
  if (argv.includes('--probe')) return probe()
  if (argv.includes('--census')) return census()

  const base = argv[argv.indexOf('--base') + 1]
  if (!argv.includes('--base') || !base || base.startsWith('--')) {
    console.error(
      'usage: check-lane-coverage.ts --base <ref> [--head <ref>] --lane <name> [--lane <name> …]',
    )
    console.error('       check-lane-coverage.ts --census | --probe')
    return 2
  }
  const claimed = argv
    .flatMap((arg, i) => (arg === '--lane' ? [argv[i + 1] ?? ''] : []))
    .filter(Boolean)
  if (claimed.length === 0) {
    console.error('name at least one --lane: this check exists to test a CLAIM about lanes.')
    return 2
  }

  const headArg = argv.indexOf('--head')
  const head = headArg === -1 ? 'HEAD' : (argv[headArg + 1] ?? 'HEAD')
  const changed = changedTestFiles(base, head)
  const known = discoverLanes()
  const files = new Map<string, readonly string[]>()
  for (const lane of known) {
    if (!claimed.includes(lane.name)) continue
    files.set(lane.name, laneFiles(lane))
  }
  const verdict = judge({ lanes: claimed, changedTestFiles: changed, laneFiles: files })

  if (verdict.unknownLanes.length > 0) {
    console.error(`unknown lane(s): ${verdict.unknownLanes.join(', ')}`)
    console.error(`known lanes: ${known.map((l) => l.name).join(', ')}`)
    return 1
  }
  if (verdict.emptyLanes.length > 0) {
    console.error(`lane(s) listing no test files at all: ${verdict.emptyLanes.join(', ')}`)
    console.error('a diff over a lane that runs nothing is vacuous, not clean.')
    return 1
  }
  if (verdict.unseen.length > 0) {
    console.error(
      `\nA failing-name diff over [${claimed.join(', ')}] CANNOT SEE ${verdict.unseen.length} changed test file(s):\n`,
    )
    // NAMING THE LANE THAT WOULD SEE IT IS OPT-IN, because answering it means
    // resolving every OTHER lane, and each resolution is a vitest startup. The
    // refusal itself only needs the lanes actually claimed, so the gate stays
    // proportional to the claim and the full search is asked for by name.
    const explain = argv.includes('--explain')
    for (const file of verdict.unseen) {
      console.error(`  ${file}`)
      if (!explain) continue
      const elsewhere = known
        .filter((lane) => !claimed.includes(lane.name))
        .filter((lane) => {
          try {
            return laneFiles(lane).includes(file)
          } catch {
            return false
          }
        })
        .map((lane) => lane.name)
      console.error(
        `      run instead: ${elsewhere.length > 0 ? elsewhere.join(', ') : 'NO LANE LISTS THIS FILE'}`,
      )
    }
    if (!explain)
      console.error(
        '\n  (--explain names the lane that would see each one; it resolves every lane, so it is slow.)',
      )
    console.error('\nRun those lanes, or say in the receipt that these files are unmeasured.')
    return 1
  }
  console.log(
    `check-lane-coverage: all ${changed.length} changed test file(s) are listed by [${claimed.join(', ')}].`,
  )
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
