/**
 * `bun run test:file -- <test files...> [vitest args]` (POD-3890): exactly the named
 * files, under the config that can collect each of them, with admission taken.
 *
 * Files are grouped by runner (see scripts/test-lanes.ts): server files run as
 * `bun --bun` under apps/server's config, web under happy-dom, `*.bun.test.ts` under
 * `bun test`, everything else under the root unit config. Each group is one process,
 * run one after another, each under its lane's admission class. Arguments that do
 * not name a file (`-t`, `--reporter`, ...) go to every vitest group untouched.
 *
 * A file that does not exist is an error, not a silent no-op: vitest's filter would
 * happily match nothing and exit 0, which is the "narrowed run reads as a green" defect
 * this repository has been bitten by before (POD-2728).
 *
 * So is a file that exists and was not run (POD-4825): a lane's config may exclude a
 * file its filter names (the node lane excluded the worklist prototype's native suites:
 * six named, three ran, exit 0). Every vitest group also writes a JSON report, and a
 * named file missing from it fails the group, by name. A run that brings its own
 * `--outputFile` is not checked, and says so.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  filesNotRun,
  LANES,
  type Lane,
  laneCommand,
  planFiles,
  repositoryRoot,
  splitFileArgs,
} from './test-lanes'
import { runWithValidationAdmission } from './validation-admission'

async function main() {
  const root = repositoryRoot()
  const args = splitFileArgs(process.argv.slice(2), root)
  const { plans, errors } = planFiles(args.files, root)
  for (const error of [...args.errors, ...errors]) console.error(`test:file: ${error}`)
  if (args.errors.length > 0 || errors.length > 0) {
    console.error('usage: bun run test:file -- <test files...> [vitest args]')
    process.exit(2)
  }
  let failed = 0
  for (const plan of plans) {
    if (plan.runner.kind === 'bun-test') {
      console.error(`test:file: bun test — ${plan.files.join(' ')}`)
      const code = await runWithValidationAdmission(
        'focused',
        ['bun', 'test', '--conditions=@podium/source', ...plan.files, ...args.extra],
        { cwd: root, label: 'test:file (bun test)', env: process.env },
      )
      if (code !== 0) failed++
      continue
    }
    const lane = LANES[plan.runner.lane] as Lane
    console.error(`test:file: lane ${plan.runner.lane} — ${plan.files.join(' ')}`)
    for (const script of lane.before ?? []) {
      const code = await Bun.spawn(['bun', 'run', script], {
        cwd: root,
        stdio: ['inherit', 'inherit', 'inherit'],
      }).exited
      if (code !== 0) process.exit(code)
    }
    // POD-4825: the run's own report says which files ran.
    const checked = !args.extra.some((arg) => arg.startsWith('--outputFile'))
    const report = join(tmpdir(), `test-file-${process.pid}-${plan.runner.lane}.json`)
    const reporters = !checked
      ? []
      : [
          ...(args.extra.some((arg) => arg.startsWith('--reporter')) ? [] : ['--reporter=default']),
          '--reporter=json',
          `--outputFile.json=${report}`,
        ]
    const cwd = resolve(root, lane.cwd)
    const code = await runWithValidationAdmission(
      lane.admission,
      laneCommand(lane, root, [...plan.files, ...args.extra, ...reporters]),
      { cwd, label: `test:file (${plan.runner.lane})`, env: process.env },
    )
    if (code !== 0) failed++
    if (!checked) {
      console.error(
        `test:file: ${plan.runner.lane}: --outputFile given; which named files ran is NOT checked`,
      )
      continue
    }
    const json: unknown = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : null
    rmSync(report, { force: true })
    const notRun = filesNotRun(
      plan.files.map((file) => resolve(cwd, file)),
      json,
    )
    if (notRun.length > 0) {
      for (const file of notRun)
        console.error(`test:file: ${file} was named but lane ${plan.runner.lane} did not run it`)
      if (code === 0) failed++
    }
  }
  console.error(
    `test:file: ${plans.length} group${plans.length === 1 ? '' : 's'}, ${failed} failed — ` +
      `${args.files.length} file${args.files.length === 1 ? '' : 's'} named; this is not a suite result.`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

if (import.meta.main) await main()
