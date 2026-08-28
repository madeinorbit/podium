/**
 * THE CLIENT BUILD LANE.
 *
 * Turbo owns reuse: `build` is a task with `dist/**` outputs and test-guarded inputs
 * (scripts/client-build-inputs.ts), so an unchanged client is restored from the shared
 * cache in seconds instead of rebuilt. This wrapper owns the three things Turbo cannot:
 *
 *   1. ADMISSION. The same rule as typecheck and test (POD-1343, POD-2774): a broken
 *      install may neither produce a cached client nor replay one. Turbo's key is blind
 *      to the install environment, so a bundle built against a half-linked node_modules
 *      would be cached under the same hash as a good one and served for it afterwards.
 *      `readCensus`/`admissionRefusal` refuse first; `turboEnv` folds the environment
 *      fingerprint into PODIUM_CHECK_ENV_HASH so drift is an automatic MISS.
 *   2. THE SUMMARY. `--summarize` is what makes the result legible and checkable:
 *      the caller gets each task's hash and whether it was a HIT, and a run where a
 *      client did not build at all is refused instead of quietly leaving the previous
 *      run's dist in place for packaging to pick up.
 *   3. THE REFUSAL OF AN UNEXPLAINED --force. `decideForce` again — a forced client
 *      build is minutes of CPU on a host that is also serving a live Podium.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { admissionRefusal, decideForce, readCensus, turboEnv } from './typecheck'

export const CLIENT_BUILD_TASKS = ['@podium/web#build', '@podium/mobile#build'] as const
export type ClientBuildTask = (typeof CLIENT_BUILD_TASKS)[number]

export interface ClientBuildTaskResult {
  hash: string
  cache: 'HIT' | 'MISS'
}

export interface ClientBuildRun {
  summaryPath: string
  tasks: Record<ClientBuildTask, ClientBuildTaskResult>
}

/**
 * The two clients. The generic `build` task covers `packages/*` (tsup → dist) too, but
 * this lane names the clients explicitly because it checks that both of them ran.
 */
export const CLIENT_FILTERS = ['@podium/web', '@podium/mobile'] as const

/**
 * Everything with a `build` task EXCEPT the desktop app. `@podium/desktop build` is a
 * Tauri release build — a Rust toolchain, minutes of CPU, and a separately released
 * artefact this server never serves. It has always been reached through `desktop:build`
 * on purpose, and a workspace-wide `turbo run build` must not quietly start running it.
 */
export const WORKSPACE_FILTERS = ['!@podium/desktop'] as const

/**
 * `turbo run build`, never a bare `turbo build`: the run form reads turbo.json's task
 * graph the same way in every version and every caller. `--concurrency=1` because the
 * builds are already parallel internally and this host runs a live instance beside them.
 */
export function turboBuildCommandFor(
  root: string,
  filters: readonly string[],
  forward: readonly string[],
): string[] {
  return [
    join(root, 'node_modules', '.bin', 'turbo'),
    'run',
    'build',
    ...filters.map((filter) => `--filter=${filter}`),
    '--summarize',
    '--concurrency=1',
    ...forward,
  ]
}

export function turboBuildCommand(root: string, forward: readonly string[]): string[] {
  return turboBuildCommandFor(root, CLIENT_FILTERS, forward)
}

/**
 * Both client tasks, with the hash they ran under and whether the output was restored.
 *
 * A task missing from the summary is a REFUSAL, not a zero: the dist directory it
 * would have written is still on disk from some earlier run, and a caller that
 * accepted silence here would package those bytes as this run's output.
 */
export function readRunSummary(root: string, summaryPath: string): ClientBuildRun['tasks'] {
  const raw = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
    tasks?: Array<{ taskId?: string; hash?: string; cache?: { status?: string } }>
  }
  const tasks = {} as ClientBuildRun['tasks']
  for (const task of CLIENT_BUILD_TASKS) {
    const entry = raw.tasks?.find((candidate) => candidate.taskId === task)
    const status = entry?.cache?.status
    if (
      entry === undefined ||
      typeof entry.hash !== 'string' ||
      (status !== 'HIT' && status !== 'MISS')
    ) {
      throw new Error(`build-clients: ${task} did not run in ${summaryPath}`)
    }
    tasks[task] = { hash: entry.hash, cache: status }
  }
  return tasks
}

/**
 * The summary this run wrote. Turbo names summaries by run id, so the only way to
 * identify ours is that it appeared while we were running. Two candidates means a
 * concurrent build lane in this same checkout, and picking either would attribute
 * another run's hashes to this one — so that is an error, not a guess.
 */
function summaryWrittenSince(root: string, since: number): string {
  const dir = join(root, '.turbo', 'runs')
  const candidates = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs >= since)
  if (candidates.length !== 1) {
    throw new Error(
      `build-clients: expected exactly one run summary written since this run started in ${dir}, found ${candidates.length}`,
    )
  }
  return candidates[0] as string
}

/**
 * Build both clients through Turbo. Throws on refusal or a non-zero turbo exit.
 *
 * `env` names the variables the BUILD is parameterised by — in practice only
 * PODIUM_APP_VERSION, which the stamp writes into index.html and the manifest and
 * which turbo.json lists in the tasks' `env` so it is hashed rather than filtered.
 * Everything else comes from this process via `turboEnv`.
 */
export async function buildClients(
  root: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClientBuildRun> {
  const summaryPath = await runTurboBuild(root, CLIENT_FILTERS, args, env)
  return { summaryPath, tasks: readRunSummary(root, summaryPath) }
}

/**
 * Build every workspace that has a `build` task except the desktop app.
 *
 * This is what root `bun run build` is: the packages' tsup output that server tests and
 * `test:integration` read from `dist`, plus the two clients. It goes through the same
 * admission and the same PODIUM_CHECK_ENV_HASH as every other lane — a raw
 * `turbo run build` would run with that variable unset, which is a DIFFERENT cache key,
 * so it would neither reuse what the wrapped lanes built nor write anything they can
 * reuse, while still filling the shared cache under an unfingerprinted identity.
 */
export async function buildWorkspace(
  root: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return runTurboBuild(root, WORKSPACE_FILTERS, args, env)
}

/** Admission, environment fingerprint, force refusal, run — then name the summary. */
async function runTurboBuild(
  root: string,
  filters: readonly string[],
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const census = readCensus(root)
  const refusal = admissionRefusal(census, 'build')
  if (refusal) throw new Error(refusal)

  const decision = decideForce([...args], env as Record<string, string | undefined>)
  if (decision.error) throw new Error(decision.error)
  if (decision.reason) console.error(`[build-clients] uncached build, reason: ${decision.reason}`)

  const started = Date.now()
  const proc = Bun.spawn(turboBuildCommandFor(root, filters, decision.forwardArgs), {
    cwd: root,
    env: {
      ...turboEnv(root, census),
      ...(env.PODIUM_APP_VERSION ? { PODIUM_APP_VERSION: env.PODIUM_APP_VERSION } : {}),
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`build-clients: turbo run build exited ${code}`)

  return summaryWrittenSince(root, started)
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const argv = process.argv.slice(2)
  const workspace = argv.includes('--workspace')
  const forward = argv.filter((arg) => arg !== '--workspace')
  if (workspace) {
    await buildWorkspace(root, forward)
  } else {
    const run = await buildClients(root, forward)
    for (const task of CLIENT_BUILD_TASKS) {
      const { cache, hash } = run.tasks[task]
      console.log(`[build-clients] ${task} ${cache} ${hash}`)
    }
  }
}
