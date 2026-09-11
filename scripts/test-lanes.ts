/**
 * The named test lanes an agent can run with arguments (POD-3890), and the map from a
 * test file to the lane that can collect it.
 *
 * Before this file the package scripts were the only way to reach a package's vitest
 * config, and each one runs its WHOLE suite: there was no sanctioned way to run one
 * server test file (AGENTS.md handed out a raw `bun --bun .../vitest.mjs` line for it),
 * no way to pass `-t`, and no way to name a server shard from the root. Every one of
 * those gaps was filled by hand-rolled vitest invocations that skipped admission — the
 * exact thing the harness command guard now refuses. So the lanes are data here, and
 * `test:file` / `test:lane` are the two entry points over that data.
 *
 * Two facts the table encodes that are easy to get wrong by hand:
 *
 *   - apps/server suites import `bun:` builtins and collect ZERO files under Node's
 *     vitest; they must run as `bun --bun`. Web too. Mobile runs under Node (its
 *     package script is a bare `vitest run`) and keeps that.
 *   - A lane is `focused` (takes a validation slot) or `heavy` (takes the host-wide
 *     `test:heavy` lease), matching the root script that already owns it.
 */
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ValidationClass } from './validation-admission'

export interface Lane {
  /** Working directory, relative to the repository root. */
  cwd: string
  /** The command; `<vitest>` is replaced by the vitest entry relative to `cwd`. */
  command: string[]
  admission: Extract<ValidationClass, 'focused' | 'heavy'>
  /** Root scripts that must run first (the integration/e2e lanes need built clients). */
  before?: string[]
  summary: string
}

const bunVitest = (config: string, ...extra: string[]) => [
  'bun',
  '--bun',
  '<vitest>',
  'run',
  '--config',
  config,
  ...extra,
]

export const LANES: Record<string, Lane> = {
  node: {
    cwd: '.',
    command: bunVitest('vitest.unit.config.ts', '--project', 'node'),
    admission: 'focused',
    summary: 'root unit config, node project (packages, scripts, cli, daemon, most of server)',
  },
  'normalized-wire': {
    cwd: '.',
    command: bunVitest('vitest.unit.config.ts', '--project', 'normalized-wire'),
    admission: 'focused',
    summary: 'root unit config, the serial normalized-wire project',
  },
  server: {
    cwd: 'apps/server',
    command: bunVitest('vitest.config.ts'),
    admission: 'focused',
    summary: '@podium/server, unsharded (every file the five shards split between them)',
  },
  'server-contracts': {
    cwd: 'apps/server',
    command: bunVitest('vitest.contracts.config.ts'),
    admission: 'focused',
    summary: '@podium/server contracts shard',
  },
  'server-store': {
    cwd: 'apps/server',
    command: bunVitest('vitest.store.config.ts'),
    admission: 'focused',
    summary: '@podium/server store shard',
  },
  'server-services': {
    cwd: 'apps/server',
    command: bunVitest('vitest.services.config.ts'),
    admission: 'focused',
    summary: '@podium/server services shard',
  },
  'server-boundary': {
    cwd: 'apps/server',
    command: bunVitest('vitest.boundary.config.ts'),
    admission: 'focused',
    summary: '@podium/server boundary shard (audits and censuses that read the tree)',
  },
  'server-normalized-wire': {
    cwd: 'apps/server',
    command: bunVitest('vitest.normalized-wire.config.ts'),
    admission: 'focused',
    summary: '@podium/server normalized-wire shard',
  },
  web: {
    cwd: 'apps/web',
    command: bunVitest('vitest.config.ts'),
    admission: 'focused',
    summary: '@podium/web under happy-dom',
  },
  mobile: {
    cwd: 'apps/mobile',
    command: ['<vitest>', 'run'],
    admission: 'focused',
    summary: '@podium/mobile under node',
  },
  scripts: {
    cwd: 'scripts',
    command: bunVitest('vitest.config.ts'),
    admission: 'focused',
    summary: '@podium/scripts: the repository audits and the lane tests',
  },
  integration: {
    cwd: '.',
    command: bunVitest('vitest.integration.config.ts', '--maxWorkers=1'),
    admission: 'heavy',
    before: ['build'],
    summary: 'integration suites: real processes, PTYs and servers (builds the clients first)',
  },
  acceptance: {
    cwd: '.',
    command: bunVitest('vitest.acceptance.config.ts'),
    admission: 'heavy',
    summary: 'acceptance suites',
  },
  e2e: {
    cwd: '.',
    command: bunVitest('vitest.integration.config.ts', '--maxWorkers=1', 'tests/e2e'),
    admission: 'heavy',
    before: ['build'],
    summary: 'tests/e2e under the integration config (builds the clients first)',
  },
}

export function laneNames(): string[] {
  return Object.keys(LANES)
}

/** The vitest entry as seen from a lane's cwd; mobile runs the Node bin, everything else the module. */
export function vitestEntry(lane: Lane, root: string): string {
  const entry =
    lane.cwd === 'apps/mobile' ? 'node_modules/.bin/vitest' : 'node_modules/vitest/vitest.mjs'
  const rel = relative(resolve(root, lane.cwd), join(root, entry))
  return rel.startsWith('.') ? rel : `./${rel}`
}

export function laneCommand(lane: Lane, root: string, extra: string[]): string[] {
  const entry = vitestEntry(lane, root)
  return [...lane.command.map((part) => (part === '<vitest>' ? entry : part)), ...extra]
}

export type FileRunner = { kind: 'vitest'; lane: string } | { kind: 'bun-test' }

export interface FilePlan {
  runner: FileRunner
  /** Paths relative to the lane's cwd (vitest filters) or the root (bun test). */
  files: string[]
}

const isTestFile = (path: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)

/**
 * Which runner collects a test file. Decided by the owning tree, not by asking vitest,
 * because asking costs a full collection per candidate config and the answer is a fact
 * about the repository layout that this file already states above.
 */
export function runnerFor(path: string): FileRunner | { error: string } {
  if (!isTestFile(path)) return { error: `${path} is not a test file (*.test.* or *.spec.*)` }
  if (/\.bun\.test\.[cm]?[jt]sx?$/.test(path)) return { kind: 'bun-test' }
  const parts = path.split(sep)
  const [top, second] = parts
  if (top === 'apps' && second === 'server') return { kind: 'vitest', lane: 'server' }
  if (top === 'apps' && second === 'web') return { kind: 'vitest', lane: 'web' }
  if (top === 'apps' && second === 'mobile') return { kind: 'vitest', lane: 'mobile' }
  if (top === 'tests' && second === 'e2e') return { kind: 'vitest', lane: 'e2e' }
  if (/\.integration\.test\./.test(path)) return { kind: 'vitest', lane: 'integration' }
  if (/\.acceptance\.test\./.test(path)) return { kind: 'vitest', lane: 'acceptance' }
  return { kind: 'vitest', lane: 'node' }
}

export interface FileArgs {
  files: string[]
  extra: string[]
  errors: string[]
}

/** Paths are the args that name an existing file; everything else is passed to the runner. */
export function splitFileArgs(argv: string[], root: string): FileArgs {
  const files: string[] = []
  const extra: string[] = []
  const errors: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('-')) {
      extra.push(arg)
      continue
    }
    const absolute = resolve(root, arg)
    if (!existsSync(absolute)) {
      if (isTestFile(arg)) errors.push(`${arg} does not exist`)
      else extra.push(arg)
      continue
    }
    const rel = relative(root, absolute)
    if (rel.startsWith('..')) errors.push(`${arg} is outside the repository`)
    else files.push(rel)
  }
  if (files.length === 0) errors.push('no test files named')
  return { files, extra, errors }
}

/** Group files by runner; vitest filters are made relative to the lane's cwd. */
export function planFiles(files: string[], root: string): { plans: FilePlan[]; errors: string[] } {
  const errors: string[] = []
  const groups = new Map<string, FilePlan>()
  for (const file of files) {
    const runner = runnerFor(file)
    if ('error' in runner) {
      errors.push(runner.error)
      continue
    }
    const key = runner.kind === 'vitest' ? `vitest:${runner.lane}` : 'bun-test'
    const plan = groups.get(key) ?? { runner, files: [] }
    const cwd = runner.kind === 'vitest' ? (LANES[runner.lane] as Lane).cwd : '.'
    plan.files.push(relative(resolve(root, cwd), resolve(root, file)))
    groups.set(key, plan)
  }
  return { plans: [...groups.values()], errors }
}

/** URL-based, not `import.meta.dir`: this module is also loaded by vitest, where that is undefined. */
export function repositoryRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url))
}
