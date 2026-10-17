/**
 * SERVER DATA BENCH (POD-6146): one command that boots two commits' servers on the
 * same seeded corpus, drives the same synthetic load at each, interleaved A B A B …,
 * and prints a side-by-side table. Recipe and noise band: docs/measurements/pod-6140-baseline.md.
 *
 *   bun --conditions=@podium/source scripts/server-data-bench/run.ts --a=<rev> --b=<rev>
 *     [--rounds=3] [--cell=h1a1] [--seed=4443] [--load=1x|10x] [--minutes=4] [--clients=4]
 *     [--root=$HOME/server-data-bench] [--label=<name>] [--max-new-rounds=2] [--profile=attribution|full]
 *     [--issue-map-parity=off|log] [--issue-map-parity-a=off|log] [--issue-map-parity-b=off|log]
 *     [--session-map-parity=off|log] [--session-map-parity-a=off|log] [--session-map-parity-b=off|log]
 *     [--session-write-targeting=running|uniform]
 *   bun --conditions=@podium/source scripts/server-data-bench/run.ts --resume=<run dir> [--max-new-rounds=2]
 *
 * `--max-new-rounds` stops a call after that many rounds, so one A/B pair fits in one
 * VM lock acquisition (coordinator rule: at most 20 minutes per acquisition); `--resume`
 * continues the same run with its saved parameters and commits, and the table is
 * printed once every round has run. Gaps between calls are listed in the report.
 *
 * Run it on the polaris agents VM through `polaris-lane`, which holds `test:polaris-agents`
 * for the whole run (operator rule 2026-10-15: nothing heavy on ludovico; benchmarks run
 * on the VM, not flatblock). Every server it starts is an
 * isolated instance (`benchEnvironment`): its own HOME, state, XDG dirs and ports, no
 * relay, no telemetry, no updates. It never reads or writes a live instance's state.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  type Cost, diffTotals, interleavedOrder, type LoopMinuteRecord, median, minuteMetrics,
  minuteSpans, minutesInside, nextMinuteBoundary, windowRates, type RoundResult, sideBySide, statementKind, statementsByKind,
} from './report'
import { RUNNING_WRITE_SHARE } from './drive'
import { parseArgs } from './seed'

const HARNESS = fileURLToPath(new URL('../..', import.meta.url))
const HERE = fileURLToPath(new URL('.', import.meta.url))
const BUN = process.execPath
const PASSWORD = 'server-data-bench-password'

/** Today's daemon frame rate on the operator's live server (24 h median, 2026-10-15). */
export const LIVE_FRAMES_PER_MINUTE = 28_000
/** 10x the operator's measured write rates (POD-5874: 186 session and 22 issue updates/min). */
export const SESSION_WRITES_PER_MINUTE = 1_860
export const ISSUE_WRITES_PER_MINUTE = 220

/**
 * A whitelist, so no ambient relay, supervisor, credential or instance override leaks in.
 *
 * `profile` is the server's `PODIUM_LOOP_PROFILE`. `full` also records a caller
 * stack per statement (POD-6189): it names WHO issued a statement kind, at a CPU
 * cost that makes its times useless, so an A/B keeps the default `attribution`.
 *
 * `issueMapParity` is the server's `PODIUM_ISSUE_MAP_PARITY` (POD-6158): `off`
 * by default, so a source run measures the issue reads and not the old/new
 * comparison a development build adds; `log` measures the comparison.
 * `sessionMapParity` is `PODIUM_SESSION_MAP_PARITY` (POD-6160), the same for
 * the session map's comparison.
 */
export function benchEnvironment(
  root: string,
  profile = 'attribution',
  issueMapParity = 'off',
  sessionMapParity = 'off',
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    PODIUM_STATE_DIR: join(root, 'state'),
    PODIUM_AGENT_HOME: join(root, 'home'),
    PODIUM_INSTANCE: 'server-data-bench',
    PODIUM_ADOPT_STATE: '1',
    PODIUM_CONNECT: 'off',
    PODIUM_TELEMETRY: 'off',
    PODIUM_HOST: '127.0.0.1',
    PODIUM_PORT: '0',
    PODIUM_HOOK_PORT: '0',
    PODIUM_AGENT_RELAY_PORT: '0',
    PODIUM_MODE: 'server',
    PODIUM_PUBLIC_URL: 'http://127.0.0.1',
    PODIUM_UPDATE_SCOPE: 'fleet-only',
    PODIUM_TRANSCRIPT_LAKE: 'off',
    PODIUM_NO_RELAY: '1',
    PODIUM_NO_SCOPE: '1',
    PODIUM_LOOP_PROFILE: profile,
    PODIUM_ISSUE_MAP_PARITY: issueMapParity,
    PODIUM_SESSION_MAP_PARITY: sessionMapParity,
    PODIUM_PASSWORD: PASSWORD,
    ABDUCO_SOCKET_DIR: join(root, 'abduco'),
  }
}

function prepareRoot(root: string): void {
  for (const name of ['home', 'tmp', 'runtime', 'cache', 'config', 'data', 'xdg-state', 'abduco', 'state']) {
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
  }
}

function git(...args: string[]): string {
  const result = spawnSync('git', ['-C', HARNESS, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): string {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

/** The checkout that runs `sha`: the harness itself when it is that clean commit, else a bench worktree. */
function checkoutFor(sha: string, root: string): string {
  const clean = git('status', '--porcelain', '--untracked-files=no') === ''
  if (clean && git('rev-parse', 'HEAD') === sha) return HARNESS
  const dir = join(root, 'checkouts', sha.slice(0, 12))
  if (!existsSync(join(dir, '.bench-ready'))) {
    if (!existsSync(dir)) git('worktree', 'add', '--detach', dir, sha)
    if (existsSync(join(HARNESS, '.toolchain'))) cpSync(join(HARNESS, '.toolchain'), join(dir, '.toolchain'), { recursive: true })
    const env = { ...process.env, PATH: `${join(dir, '.toolchain')}:${process.env.PATH}` }
    run(BUN, ['run', 'setup:worktree'], { cwd: dir, env })
    writeFileSync(join(dir, '.bench-ready'), sha)
  }
  return dir
}

interface Server {
  child: ChildProcess
  ready: Promise<{ port: number; pid: number; bootMs: number; rssBytes: number; heapUsedBytes: number }>
  listenMs: () => number | undefined
  /** `loop minute` records logged so far (the minute file's records, plus their write time). */
  minutes: () => LoopMinuteRecord[]
  totals: (label: string) => Promise<{
    queries: Record<string, Cost>; tasks: Record<string, Cost>; rssBytes: number; heapUsedBytes: number
    /** Caller stacks per statement key, lifetime; present under `--profile=full`. */
    stacks?: Record<string, { count: number; stack: string }[]>
  }>
  stop: () => Promise<void>
}

export function startBenchServer(
  checkout: string,
  root: string,
  logPath: string,
  profile?: string,
  issueMapParity?: string,
  sessionMapParity?: string,
): Server {
  const child = spawn(BUN, ['--conditions=@podium/source', join(HERE, 'serve.ts'), `--checkout=${checkout}`], {
    cwd: checkout, env: benchEnvironment(root, profile, issueMapParity, sessionMapParity), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const log: string[] = []
  let listenMs: number | undefined
  const minutes: LoopMinuteRecord[] = []
  const waiters = new Map<string, (value: any) => void>()
  let resolveReady!: (value: any) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<any>((done, fail) => { resolveReady = done; rejectReady = fail })
  const timer = setTimeout(() => rejectReady(new Error(`bench server did not boot in 180 s; see ${logPath}`)), 180_000)
  createInterface({ input: child.stdout! }).on('line', (line) => {
    log.push(line)
    if (!line.startsWith('{')) return
    let record: any
    try { record = JSON.parse(line) } catch { return }
    if (record.ns === 'server:boot' && record.stage === 'listen') listenMs = record.durationMs
    if (record.msg === 'loop minute' && record.component === 'server') minutes.push(record)
    if (record.benchReady) { clearTimeout(timer); resolveReady(record) }
    if (record.benchTotals !== undefined) waiters.get(record.benchTotals)?.(record)
  })
  child.stderr!.on('data', (bytes) => log.push(String(bytes)))
  const exited = new Promise<void>((done) => child.once('exit', (code) => {
    clearTimeout(timer)
    writeFileSync(logPath, log.join('\n'))
    rejectReady(new Error(`bench server exited ${code} before ready; see ${logPath}`))
    done()
  }))
  return {
    child,
    ready,
    listenMs: () => listenMs,
    minutes: () => [...minutes],
    totals: (label) => new Promise((done) => { waiters.set(label, done); child.stdin!.write(`totals ${label}\n`) }),
    stop: async () => {
      child.stdin!.write('stop\n')
      const killer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, 30_000)
      await exited
      clearTimeout(killer)
      try { process.kill(-child.pid!, 'SIGKILL') } catch {}
    },
  }
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

function memAvailableGiB(): number {
  const line = readFileSync('/proc/meminfo', 'utf8').split('\n').find((l) => l.startsWith('MemAvailable:'))
  return Number(line?.split(/\s+/)[1] ?? 0) / 2 ** 20
}

async function template(sha: string, checkout: string, corpusPath: string, root: string, label: string): Promise<{ dir: string; fixture: string }> {
  const dir = join(root, 'templates', `${sha.slice(0, 12)}-${label}`)
  const fixture = join(dir, 'fixture.json')
  if (existsSync(join(dir, '.template-ready'))) return { dir, fixture }
  rmSync(dir, { recursive: true, force: true })
  prepareRoot(dir)
  console.error(`[bench] seeding ${label} for ${sha.slice(0, 12)}`)
  run(BUN, ['--conditions=@podium/source', join(HERE, 'seed.ts'), `--checkout=${checkout}`, `--corpus=${corpusPath}`,
    `--db=${join(dir, 'state', 'podium.db')}`, `--out=${fixture}`], { cwd: checkout, env: benchEnvironment(dir) })
  // One warm-up boot, so every measured round boots a database that has already been
  // booted once (first-boot work such as the password and backfills is not measured).
  const server = startBenchServer(checkout, dir, join(dir, 'warmup-boot.log'))
  await server.ready
  await server.stop()
  rmSync(join(dir, 'state', 'perf'), { recursive: true, force: true })
  rmSync(join(dir, 'state', 'logs'), { recursive: true, force: true })
  writeFileSync(join(dir, '.template-ready'), sha)
  return { dir, fixture }
}

async function round(opts: {
  arm: 'A' | 'B'; index: number; sha: string; checkout: string; templateDir: string; fixture: string
  outDir: string; minutes: number; framesPerMinute: number; clients: number
  sessionWritesPerMinute: number; issueWritesPerMinute: number; profile: string; issueMapParity: string
  sessionMapParity: string; sessionWriteTargeting: string
}): Promise<{ result: RoundResult; detail: Record<string, unknown> }> {
  const dir = join(opts.outDir, `${opts.arm}-r${opts.index}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(opts.templateDir, dir, { recursive: true })
  for (let waited = 0; memAvailableGiB() < 4; waited++) {
    if (waited >= 60) throw new Error(`MemAvailable stayed below 4 GiB for 10 min (${memAvailableGiB().toFixed(1)} GiB)`)
    await pause(10_000)
  }
  const loadAtStart = readFileSync('/proc/loadavg', 'utf8').split(' ')[0]
  const server = startBenchServer(
    opts.checkout, dir, join(dir, 'server.ndjson'), opts.profile, opts.issueMapParity, opts.sessionMapParity,
  )
  let succeeded = false
  try {
    const ready = await server.ready
    await pause(10_000)
    // The measured window is `minutes + 1` long, so it holds `minutes` whole loop
    // minutes wherever the accounting's own minute phase falls.
    const windowStart = nextMinuteBoundary(Date.now(), 20_000)
    const windowEnd = windowStart + (opts.minutes + 1) * 60_000
    const driver = spawn(BUN, ['--conditions=@podium/source', join(HERE, 'drive.ts'),
      `--checkout=${opts.checkout}`, `--fixture=${opts.fixture}`, `--port=${ready.port}`, `--password=${PASSWORD}`,
      `--start-at=${windowStart - 10_000}`, `--duration-ms=${windowEnd - windowStart + 12_000}`,
      `--frames-per-minute=${opts.framesPerMinute}`, `--session-writes-per-minute=${opts.sessionWritesPerMinute}`,
      `--issue-writes-per-minute=${opts.issueWritesPerMinute}`, `--clients=${opts.clients}`,
      `--session-write-targeting=${opts.sessionWriteTargeting}`],
    { cwd: HARNESS, stdio: ['ignore', 'pipe', 'pipe'] })
    let driverOut = ''
    driver.stdout!.on('data', (bytes) => { driverOut += bytes })
    driver.stderr!.on('data', (bytes) => { driverOut += bytes })
    const driverExit = new Promise<number | null>((done) => driver.once('exit', done))
    await pause(Math.max(0, windowStart - Date.now()))
    const start = await server.totals('start')
    await pause(Math.max(0, windowEnd - Date.now()))
    const end = await server.totals('end')
    const driverCode = await driverExit
    writeFileSync(join(dir, 'driver.log'), driverOut)
    if (driverCode !== 0) throw new Error(`driver exited ${driverCode}; see ${join(dir, 'driver.log')}`)
    const all = server.minutes()
    const inside = minutesInside(all, windowStart, windowEnd)
    const queries = diffTotals(start.queries, end.queries)
    const tasks = diffTotals(start.tasks, end.tasks)
    const metrics: Record<string, number> = {
      ...minuteMetrics(inside, minuteSpans(inside, all)),
      ...windowRates(queries, tasks, windowEnd - windowStart),
      bootListenMs: server.listenMs() ?? Number.NaN,
      rssAfterBootMiB: ready.rssBytes / 2 ** 20,
      rssEndMiB: end.rssBytes / 2 ** 20,
      heapEndMiB: end.heapUsedBytes / 2 ** 20,
    }
    const drive = JSON.parse(driverOut.trim().split('\n').filter((line) => line.startsWith('{"benchDrive"')).at(-1) ?? '{}')
    // Overload shows up here first: the server drops daemons it cannot keep up with.
    metrics.daemonReconnects = Number(drive.reconnects ?? 0)
    metrics.framesDroppedPerMin = (Object.values((drive.dropped ?? {}) as Record<string, number>).reduce((n, v) => n + v, 0) * 60_000) / (windowEnd - windowStart + 12_000)
    const windowMinutes = (windowEnd - windowStart) / 60_000
    // The hottest statements by their own key, not only by kind: two statements of
    // one kind (one resource's grants, many resources') are different questions.
    const topStatements = Object.entries(queries).sort((a, b) => b[1].count - a[1].count).slice(0, 40)
      .map(([sql, cost]) => ({ sql, kind: statementKind(sql), perMin: cost.count / windowMinutes, wallMsPerMin: cost.wallMs / windowMinutes }))
    if (end.stacks) {
      // Who issued each hot statement. Lifetime samples (boot included), so read the
      // shares, not the counts, against the window's rates.
      const stacks = Object.fromEntries(topStatements.map(({ sql }) => [sql, (end.stacks![sql] ?? []).slice(0, 12)]))
      writeFileSync(join(dir, 'stacks.json'), JSON.stringify(stacks, null, 2))
    }
    const detail = {
      arm: opts.arm, round: opts.index, sha: opts.sha, windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(), loadAtStart, profile: opts.profile, issueMapParity: opts.issueMapParity,
      sessionMapParity: opts.sessionMapParity, metrics, drive,
      statementsByKind: statementsByKind(queries, windowMinutes).slice(0, 25),
      topStatements,
      topTasks: Object.entries(tasks).sort((a, b) => b[1].wallMs - a[1].wallMs).slice(0, 25)
        .map(([label, cost]) => ({ label, perMin: (cost.count * 60_000) / (windowEnd - windowStart), wallMsPerMin: (cost.wallMs * 60_000) / (windowEnd - windowStart) })),
    }
    writeFileSync(join(dir, 'round.json'), JSON.stringify(detail, null, 2))
    // A passing round's database is not evidence; a failing one's stays for debugging.
    succeeded = true
    const show = (key: string, digits = 0) => (metrics[key] ?? Number.NaN).toFixed(digits)
    console.error(`[bench] ${opts.arm} r${opts.index} ${opts.sha.slice(0, 10)}: util ${show('utilizationPct', 1)}% blocked ${show('blockedPct', 1)}% frames/min ${show('daemonFramesPerMin')} sql/min ${show('sqlStatementsPerMin')} (${inside.length} minutes)`)
    return { result: { arm: opts.arm, round: opts.index, metrics }, detail }
  } finally {
    await server.stop()
    if (succeeded) rmSync(join(dir, 'state'), { recursive: true, force: true })
  }
}

/** Shas of a run from its finished rounds, for resuming a run that predates `run.json`. */
function shasFromRounds(dir: string): { A: string; B: string } | undefined {
  const sha = (arm: 'A' | 'B') => {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const file = join(dir, name, 'round.json')
      if (name.startsWith(`${arm}-r`) && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).sha as string
    }
    return undefined
  }
  const A = sha('A')
  const B = sha('B')
  return A && B ? { A, B } : undefined
}

/** Gaps between consecutive rounds longer than a round's own setup, e.g. a lock released between calls. */
function roundGaps(details: ReadonlyArray<Record<string, unknown>>): string {
  const gaps: string[] = []
  for (let i = 1; i < details.length; i++) {
    const gap = Date.parse(String(details[i]!.windowStart)) - Date.parse(String(details[i - 1]!.windowEnd))
    if (gap > 5 * 60_000) gaps.push(`${Math.round(gap / 60_000)} min before ${details[i]!.arm}${details[i]!.round}`)
  }
  return gaps.length ? `; gaps: ${gaps.join(', ')}` : '; no gaps over 5 min'
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  const resumeDir = cli.resume ? resolve(cli.resume) : undefined
  const saved = resumeDir && existsSync(join(resumeDir, 'run.json'))
    ? JSON.parse(readFileSync(join(resumeDir, 'run.json'), 'utf8')) as { args: Record<string, string>; shas: { A: string; B: string } }
    : undefined
  // A resumed run keeps its own parameters and commits; only --max-new-rounds is per call.
  const args = { ...cli, ...saved?.args }
  if (!resumeDir && (!args.a || !args.b)) throw new Error('usage: run.ts --a=<rev> --b=<rev> [--rounds=3] [--cell=h1a1] [--load=1x|10x] [--minutes=4] [--max-new-rounds=N] | --resume=<run dir>')
  const root = resolve(args.root ?? join(homedir(), 'server-data-bench'))
  if (!root.includes('server-data-bench')) throw new Error('--root must name a server-data-bench directory')
  const rounds = Number(args.rounds ?? 3)
  const cell = args.cell ?? 'h1a1'
  const seed = Number(args.seed ?? 4443)
  const load = args.load ?? '1x'
  const multiplier = Number(load.replace(/x$/, ''))
  const framesPerMinute = Number(args['frames-per-minute'] ?? LIVE_FRAMES_PER_MINUTE * multiplier)
  const sessionWritesPerMinute = Number(args['session-writes-per-minute'] ?? SESSION_WRITES_PER_MINUTE)
  const issueWritesPerMinute = Number(args['issue-writes-per-minute'] ?? ISSUE_WRITES_PER_MINUTE)
  const minutes = Number(args.minutes ?? 4)
  const clients = Number(args.clients ?? 4)
  const profile = args.profile ?? 'attribution'
  // Runs saved before targeting existed renamed sessions uniformly; keep them that way.
  const sessionWriteTargeting = args['session-write-targeting'] ?? (saved ? 'uniform' : 'running')
  if (sessionWriteTargeting !== 'running' && sessionWriteTargeting !== 'uniform') throw new Error(`--session-write-targeting must be running or uniform, not ${sessionWriteTargeting}`)
  args['session-write-targeting'] = sessionWriteTargeting
  const issueMapParity = {
    A: args['issue-map-parity-a'] ?? args['issue-map-parity'] ?? 'off',
    B: args['issue-map-parity-b'] ?? args['issue-map-parity'] ?? 'off',
  }
  const sessionMapParity = {
    A: args['session-map-parity-a'] ?? args['session-map-parity'] ?? 'off',
    B: args['session-map-parity-b'] ?? args['session-map-parity'] ?? 'off',
  }
  for (const value of Object.values(sessionMapParity)) {
    if (value !== 'off' && value !== 'log') throw new Error(`--session-map-parity must be off or log, not ${value}`)
  }
  for (const value of Object.values(issueMapParity)) {
    if (value !== 'off' && value !== 'log') throw new Error(`--issue-map-parity must be off or log, not ${value}`)
  }
  const maxNewRounds = Number(cli['max-new-rounds'] ?? Number.POSITIVE_INFINITY)
  const shas = saved?.shas ?? (resumeDir ? shasFromRounds(resumeDir) : undefined)
    ?? { A: git('rev-parse', `${args.a}^{commit}`), B: git('rev-parse', `${args.b}^{commit}`) }
  const runId = resumeDir ? basename(resumeDir) : `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.label ?? `${shas.A.slice(0, 8)}-${shas.B.slice(0, 8)}-${cell}-${load}`}`
  const outDir = resumeDir ?? join(root, 'runs', runId)
  mkdirSync(outDir, { recursive: true })
  const { resume: _resume, 'max-new-rounds': _max, ...keep } = args
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({ args: keep, shas }, null, 2))
  const checkouts = { A: checkoutFor(shas.A, root), B: checkoutFor(shas.B, root) }
  const corpusPath = join(root, `corpus-${cell}-s${seed}.json`)
  if (!existsSync(corpusPath)) {
    run(BUN, ['--conditions=@podium/source', join(HERE, 'corpus-export.ts'), cell, String(seed), corpusPath], { cwd: HARNESS })
  }
  const label = `${cell}-s${seed}`
  const templates = {
    A: await template(shas.A, checkouts.A, corpusPath, root, label),
    B: shas.B === shas.A ? undefined : await template(shas.B, checkouts.B, corpusPath, root, label),
  }
  const results: RoundResult[] = []
  const details: Record<string, unknown>[] = []
  let newRounds = 0
  for (const step of interleavedOrder(rounds)) {
    const done = join(outDir, `${step.arm}-r${step.round}`, 'round.json')
    if (existsSync(done)) {
      const detail = JSON.parse(readFileSync(done, 'utf8'))
      results.push({ arm: step.arm, round: step.round, metrics: detail.metrics })
      details.push(detail)
      continue
    }
    if (newRounds >= maxNewRounds) {
      console.error(`[bench] paused after ${newRounds} new round(s); next is ${step.arm} r${step.round}. Resume with --resume=${outDir}`)
      return
    }
    const t = (step.arm === 'B' ? templates.B : undefined) ?? templates.A
    const { result, detail } = await round({
      arm: step.arm, index: step.round, sha: shas[step.arm], checkout: checkouts[step.arm],
      templateDir: t.dir, fixture: t.fixture, outDir, minutes, framesPerMinute, clients, sessionWritesPerMinute, issueWritesPerMinute, profile,
      issueMapParity: issueMapParity[step.arm],
      sessionMapParity: sessionMapParity[step.arm], sessionWriteTargeting,
    })
    results.push(result)
    details.push(detail)
    newRounds++
  }
  const fixture = JSON.parse(readFileSync(templates.A.fixture, 'utf8'))
  const header = [
    `## Server data bench ${runId}`,
    '',
    `As of ${new Date().toISOString()} on ${hostname()}. A = ${shas.A}, B = ${shas.B}.`,
    `Cell ${cell} seed ${seed} (${fixture.counts.issues} issues, ${fixture.counts.sessions} sessions, ${fixture.counts.liveSessions} live on ${fixture.counts.machines} machines).`,
    `Load ${load}: ${framesPerMinute} daemon frames/min, ${sessionWritesPerMinute} session + ${issueWritesPerMinute} issue writes/min (session writes targeted ${sessionWriteTargeting === 'running' ? `${RUNNING_WRITE_SHARE * 100}% to live sessions` : 'uniformly over all sessions'}), ${clients} clients; ${minutes} measured minutes per round, ${rounds} rounds per arm, order ${interleavedOrder(rounds).map((s) => s.arm).join(' ')}; issue-map comparison A ${issueMapParity.A}, B ${issueMapParity.B} (PODIUM_ISSUE_MAP_PARITY); session-map comparison A ${sessionMapParity.A}, B ${sessionMapParity.B} (PODIUM_SESSION_MAP_PARITY).`,
    'Per-round values are medians over that round\'s whole minutes; the table shows the median over rounds and the min–max over rounds.',
    `Round windows (start UTC): ${details.map((d) => `${d.arm}${d.round} ${String(d.windowStart).slice(11, 16)}`).join(', ')}${roundGaps(details)}.`,
    '',
  ]
  const kinds = (arm: 'A' | 'B') => {
    const merged = new Map<string, number[]>()
    for (const detail of details.filter((d) => d.arm === arm)) {
      for (const entry of detail.statementsByKind as Array<{ kind: string; perMin: number }>) merged.set(entry.kind, [...(merged.get(entry.kind) ?? []), entry.perMin])
    }
    return new Map([...merged].map(([kind, xs]) => [kind, median(xs)]))
  }
  const kindsA = kinds('A')
  const kindsB = kinds('B')
  const kindRows = [...new Set([...kindsA.keys(), ...kindsB.keys()])]
    .sort((x, y) => (kindsA.get(y) ?? 0) - (kindsA.get(x) ?? 0)).slice(0, 15)
    .map((kind) => `| ${kind} | ${(kindsA.get(kind) ?? 0).toFixed(0)} | ${(kindsB.get(kind) ?? 0).toFixed(0)} |`)
  const report = [
    ...header,
    sideBySide(results, shas),
    '',
    'Statements per minute by operation kind (verb + first table; lifetime attribution totals diffed over the window, median over rounds):',
    '',
    '| kind | A | B |', '|---|---:|---:|', ...kindRows,
  ].join('\n')
  writeFileSync(join(outDir, 'report.md'), `${report}\n`)
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ runId, shas, cell, seed, load, framesPerMinute, sessionWritesPerMinute, sessionWriteTargeting, issueWritesPerMinute, minutes, rounds, clients, results, details }, null, 2))
  console.log(report)
  console.error(`[bench] evidence: ${outDir}`)
}

if (import.meta.main) await main()
