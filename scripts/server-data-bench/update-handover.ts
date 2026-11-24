/**
 * Live-update handover measurement (POD-7541), for an agent VM only. Never point it at a
 * live instance's state: every store, state directory and port it uses is generated here.
 *
 * bun --conditions=@podium/source scripts/server-data-bench/update-handover.ts
 *   --arms=D:<deployed>,A:<parent>,B:<candidate> [--rounds=3] [--probes=reattach,takeover]
 *   [--root=/tmp/server-data-bench-handover-…]
 *
 * Each arm is a detached worktree of its revision. Every arm runs the same probes, in
 * D A B D A B order, each in a fresh process on a fresh copy of the generated state:
 *
 * 1. `reattach`: the server half of "the daemons come back". A file-backed store holds
 *    MACHINES machines with SESSIONS_PER_MACHINE live sessions each, every one on a vault
 *    credential (the shape that makes a reattach refresh the session's access and audit
 *    it). The registry is disposed and built again over the same store (a new server
 *    process), then every machine's daemon attaches at once. Measured: the time until
 *    every machine has every reattach frame (daemon return), the longest gap of a 10 ms
 *    timer (the event loop's longest stall) and the stalls a browser would notice: its
 *    ping goes unanswered after five seconds and it force-closes after ten.
 * 2. `takeover`: the process handover as `podium parent` performs it. An old server runs
 *    the arm's real `podium server --takeover`; a second one is started the same way and
 *    reclaims it. Measured from the outside with a 20 ms /health poll: old listener gone to
 *    new listener answering, and the new process's own boot stages. The state directory
 *    holds a generated file tree of the live install's shape (FILE_DIRS directories,
 *    FILE_COUNT files under artifacts/ and transcripts/), which the boot's leftover
 *    temp-file sweep walks.
 */
import { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { median } from './report'
import { benchEnvironment } from './run'
import { parseArgs } from './seed'

const checkout = resolve(import.meta.dir, '../..')
const bun = process.execPath
const args = parseArgs(process.argv.slice(2))

const MACHINES = Number(args.machines ?? 4)
const SESSIONS_PER_MACHINE = Number(args.sessions ?? 30)
/** Exited, unarchived sessions on the first machine: each is probed on reattach. */
const EXITED = Number(args.exited ?? 3_000)
const FILE_DIRS = Number(args.fileDirs ?? 28_000)
const FILE_COUNT = Number(args.files ?? 60_000)
/** The browser's link-down and force-close thresholds (socket-hub heartbeat). */
const PING_DOWN_MS = 5_000
const FORCE_CLOSE_MS = 10_000

function command(cwd: string, executable: string, argv: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, argv, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    ...(env ? { env } : {}),
  })
  if (result.status !== 0)
    throw new Error(`${executable} ${argv.join(' ')}: ${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}

/** A longest-gap monitor on a 10 ms timer: what the event loop let through. */
function loopMonitor() {
  const periodMs = 10
  const gaps: number[] = []
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const gap = now - last
    last = now
    if (gap > 100) gaps.push(gap)
    longest = Math.max(longest, gap)
  }, periodMs)
  return {
    stop() {
      clearInterval(timer)
      const late = now() - last
      if (late > 100) gaps.push(late)
      longest = Math.max(longest, late)
      return {
        longestStallMs: Math.round(longest),
        stallsOver1s: gaps.filter((gap) => gap > 1_000).length,
        stallsOverPingDown: gaps.filter((gap) => gap > PING_DOWN_MS).length,
        stallsOverForceClose: gaps.filter((gap) => gap > FORCE_CLOSE_MS).length,
        stallMsOver100ms: Math.round(gaps.reduce((sum, gap) => sum + gap, 0)),
      }
    },
  }
}
const now = () => performance.now()

// ---------------------------------------------------------------------------------------
// Probe 1: the reattach burst, in process, on the arm's own modules.
// ---------------------------------------------------------------------------------------

async function reattachProbe(arm: string, root: string): Promise<void> {
  await import(join(arm, 'test-hermetic-env.ts'))
  const mod = async <T>(path: string): Promise<T> => (await import(join(arm, path))) as T
  const { SessionRegistry } = await mod<typeof import('../../apps/server/src/relay')>(
    'apps/server/src/relay.ts',
  )
  const { openTestStore } = await mod<
    typeof import('../../apps/server/src/test-support/open-test-store')
  >('apps/server/src/test-support/open-test-store.ts')
  const { attachDaemonWithInventory } = await mod<
    typeof import('../../apps/server/src/test-support/daemon-inventory')
  >('apps/server/src/test-support/daemon-inventory.ts')
  const { sealCredentialSecret } = await mod<
    typeof import('../../apps/server/src/modules/credentials/vault')
  >('apps/server/src/modules/credentials/vault.ts')
  const model = await mod<typeof import('../../packages/model/src/index')>(
    'packages/model/src/index.ts',
  )
  type Registry = Awaited<ReturnType<typeof SessionRegistry.create>>

  const dbPath = join(root, 'reattach.db')
  const store = await openTestStore(dbPath)
  const owner = model.firstAdminMemberId()
  const machineIds = Array.from({ length: MACHINES }, (_, n) =>
    model.asMachineId(`00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`),
  )
  for (const [n, id] of machineIds.entries()) {
    await store.machines.upsertMachine({
      id,
      name: `bench-${n}`,
      hostname: `bench-${n}`,
      tokenHash: 'bench',
      ownerUserId: owner,
      assignment: { server: n === 0, agentExecution: true },
    })
  }
  const record = await store.credentials.insert({
    ownerUserId: owner,
    label: 'bench key',
    type: 'anthropic.api-key',
  })
  if ((await sealCredentialSecret(store, record, 'sk-FAKE-bench-handover-0001', 0)) !== 1)
    throw new Error('could not seal the bench credential')

  const attachAll = async (
    registry: Registry,
    onFrame: (machineId: string, frame: { type: string; sessionId?: string }) => void,
  ) =>
    await Promise.all(
      machineIds.map(
        async (machineId) =>
          await attachDaemonWithInventory(registry, machineId, (message: unknown) =>
            onFrame(machineId, message as { type: string; sessionId?: string }),
          ),
      ),
    )

  // The old server: every session live and bound on its machine.
  const first = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const sessions = new Map<string, string[]>()
  try {
    await attachAll(first, () => {})
    for (const machineId of machineIds) {
      const ids: string[] = []
      for (let n = 0; n < SESSIONS_PER_MACHINE; n++) {
        const { sessionId } = await first.modules.sessions.createSession({
          agentKind: 'claude-code',
          cwd: `/bench/${n}`,
          credentialId: record.id,
          machineId,
        })
        await first.gateway.routeDaemonFrame(machineId, {
          type: 'bind',
          sessionId,
          cmd: 'claude',
          cwd: `/bench/${n}`,
          agentKind: 'claude-code',
          geometry: { cols: 80, rows: 24 },
        })
        ids.push(sessionId)
      }
      sessions.set(machineId, ids)
    }
    // One survivor with an observation lease, the template of the exited ones.
    const template = sessions.get(machineIds[0]!)![0]! as never
    await store.observationCheckpoints.advanceGeneration(template, 'claude-code', 'bench-thread')
  } finally {
    await first.dispose()
  }
  const at = new Date().toISOString()
  const checkpoint = {
    schemaVersion: 1,
    podiumSessionId: '',
    provider: 'claude-code',
    providerSessionId: 'bench-thread',
    bindingVersion: 1,
    lifecycleObservationGeneration: 1,
    providerCursor: { segmentId: 'bench', components: { file: 1 } },
    bootstrapCursor: { segmentId: 'bench', components: { file: 1 } },
    lastAcceptedLiveCursor: null,
    turnEpoch: 0,
    providerTurnId: null,
    providerPromptId: null,
    turnState: { phase: 'idle', since: at, workingMsTotal: 1, nativeSubagentCount: 0 },
    terminalFence: null,
    providerAt: at,
    acceptedAt: at,
    lastLiveReceiptAt: null,
    // The live install's checkpoints average about 11 KB.
    lastTransitionId: `bench-${'x'.repeat(10_000)}`,
  }
  const checkpointBytes = cloneExited(
    dbPath,
    sessions.get(machineIds[0]!)![0]!,
    EXITED,
    JSON.stringify(checkpoint),
  )

  // The new server, and every daemon returning to it at once.
  const auditBefore = (await store.settingsAudit.list(100_000)).length
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  try {
    // Every live session, and every exited one, is probed with a reattach frame.
    const wanted = new Map(machineIds.map((id) => [id as string, new Set(sessions.get(id))]))
    for (let n = 0; n < EXITED; n++) wanted.get(machineIds[0]!)!.add(exitedId(n))
    const returnedAt = new Map<string, number>()
    let allReturned!: () => void
    const returned = new Promise<void>((done) => {
      allReturned = done
    })
    const refreshes = { count: 0 }
    const monitor = loopMonitor()
    const cpuStart = process.cpuUsage()
    const startedAt = now()
    const timeout = setTimeout(() => allReturned(), 120_000)
    await attachAll(registry, (machineId, frame) => {
      if (frame.type === 'sessionAccessRefresh') refreshes.count++
      if (frame.type !== 'reattach' || !frame.sessionId) return
      const left = wanted.get(machineId)
      left?.delete(frame.sessionId)
      if (left?.size === 0 && !returnedAt.has(machineId)) {
        returnedAt.set(machineId, now() - startedAt)
        if (returnedAt.size === machineIds.length) allReturned()
      }
    })
    const attachedMs = now() - startedAt
    await returned
    clearTimeout(timeout)
    const daemonReturnMs = now() - startedAt
    // Whatever the attach left running (pushes, sweeps) is still the burst.
    await new Promise((done) => setTimeout(done, 1_000))
    const loop = monitor.stop()
    const cpu = process.cpuUsage(cpuStart)
    const audit = (await store.settingsAudit.list(100_000)).length - auditBefore
    if (returnedAt.size !== machineIds.length)
      throw new Error(`only ${returnedAt.size} of ${machineIds.length} machines reattached`)
    console.log(
      JSON.stringify({
        handoverProbe: 'reattach',
        machines: MACHINES,
        sessions: MACHINES * SESSIONS_PER_MACHINE,
        exitedSessions: EXITED,
        checkpointBytes,
        attachCallsMs: Math.round(attachedMs),
        daemonReturnMs: Math.round(daemonReturnMs),
        slowestMachineMs: Math.round(Math.max(...returnedAt.values())),
        accessRefreshes: refreshes.count,
        auditRows: audit,
        processCpuMs: Math.round((cpu.user + cpu.system) / 1_000),
        ...loop,
      }),
    )
  } finally {
    await registry.dispose()
    await store.close()
  }
}

const exitedId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`

/**
 * Clone the template session's row and checkpoint as `count` exited, unarchived
 * sessions, in SQL: thousands through the service would take the bench minutes.
 */
function cloneExited(dbPath: string, template: string, count: number, checkpoint: string): number {
  const db = new Database(dbPath)
  try {
    const clone = (table: string, key: string, overrides: Record<string, string>) => {
      const columns = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      )
      const select = columns.map((column) =>
        column === key ? '?1' : column in overrides ? overrides[column] : `"${column}"`,
      )
      return db.prepare(
        `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')})
         SELECT ${select.join(', ')} FROM ${table} WHERE "${key}" = ?2`,
      )
    }
    const session = clone('sessions', 'id', { status: "'exited'" })
    // Each clone's checkpoint names its own session, as a stored one does.
    const lease = clone('session_observation_checkpoints', 'session_id', {
      checkpoint_json: "json_set(?3, '$.podiumSessionId', ?1)",
    })
    db.exec('BEGIN')
    for (let n = 0; n < count; n++) {
      session.run(exitedId(n), template)
      lease.run(exitedId(n), template, checkpoint)
    }
    db.exec('COMMIT')
    const row = db
      .query(
        'SELECT length(checkpoint_json) AS bytes FROM session_observation_checkpoints WHERE session_id = ?',
      )
      .get(exitedId(0)) as { bytes: number | null } | null
    return row?.bytes ?? 0
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------------------
// Probe 2: the process takeover, through the arm's real CLI.
// ---------------------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return await new Promise((done, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => done(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

/** Generate the file tree a long-lived install's state directory holds. */
function fileTree(state: string): void {
  const roots = ['artifacts', 'transcripts']
  let files = 0
  for (let dir = 0; dir < FILE_DIRS; dir++) {
    const root = roots[dir % roots.length]!
    // Two levels, as content-addressed keys spread: root/ab/<n>/
    const path = join(state, root, (dir % 251).toString(16).padStart(2, '0'), String(dir))
    mkdirSync(path, { recursive: true })
    const here = Math.floor(FILE_COUNT / FILE_DIRS) + (dir < FILE_COUNT % FILE_DIRS ? 1 : 0)
    for (let n = 0; n < here; n++) writeFileSync(join(path, `object-${n}`), 'x')
    files += here
  }
  if (files !== FILE_COUNT) throw new Error(`generated ${files} files, wanted ${FILE_COUNT}`)
}

interface HealthSample {
  at: number
  ok: boolean
}

/** `/health` answers 200 only once the server serves (503 while it resolves its targets). */
async function health(port: number, timeoutMs = 1_000): Promise<HealthSample> {
  const at = now()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.text()
    return { at, ok: response.ok }
  } catch {
    return { at, ok: false }
  }
}

function startCli(arm: string, root: string, port: number, log: string[]) {
  const env = {
    ...benchEnvironment(root),
    PODIUM_PORT: String(port),
    PODIUM_LOGGING_MODE: 'ndjson',
  }
  const child = spawn(
    bun,
    ['--conditions=@podium/source', join(arm, 'scripts/cli.ts'), 'server', '--takeover'],
    { cwd: arm, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  const stages = new Map<string, number>()
  const onLine = (line: string) => {
    log.push(line)
    if (!line.startsWith('{')) return
    try {
      const value = JSON.parse(line) as { ns?: string; stage?: string; durationMs?: number }
      if (value.ns === 'server:boot' && value.stage && value.durationMs !== undefined)
        stages.set(value.stage, value.durationMs)
    } catch {
      /* not a record */
    }
  }
  createInterface({ input: child.stdout }).on('line', onLine)
  createInterface({ input: child.stderr }).on('line', onLine)
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  return { child, stages, exited }
}

/** Each boot stage's process age, the last record of it in a server log winning. */
function bootStages(path: string): Map<string, number> {
  const stages = new Map<string, number>()
  if (!existsSync(path)) return stages
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"server:boot"')) continue
    try {
      const value = JSON.parse(line) as { stage?: string; durationMs?: number }
      if (value.stage && value.durationMs !== undefined) stages.set(value.stage, value.durationMs)
    } catch {
      /* a torn line */
    }
  }
  return stages
}

async function untilHealthy(port: number, limitMs: number) {
  const deadline = now() + limitMs
  for (;;) {
    const sample = await health(port)
    if (sample.ok) return sample
    if (now() > deadline) throw new Error(`no healthy server on ${port} within ${limitMs} ms`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

async function takeoverProbe(arm: string, root: string): Promise<void> {
  const port = await freePort()
  const log: string[] = []
  const old = startCli(arm, root, port, log)
  const kill = (pid: number | undefined) => {
    try {
      if (pid) process.kill(-pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  let successor: ReturnType<typeof startCli> | undefined
  try {
    await untilHealthy(port, 240_000)
    // Settle the old server's own post-boot work before the handover starts.
    await new Promise((done) => setTimeout(done, 3_000))
    let oldGone: number | undefined
    let newUp: number | undefined
    const spawnedAt = now()
    let lastOld = spawnedAt
    successor = startCli(arm, root, port, log)
    void old.exited.then(() => {
      oldGone ??= now()
    })
    // Both answer the same port: an answer is the old server's until the first refusal
    // or its exit, and the successor's after it.
    let sawDown = false
    const deadline = spawnedAt + 240_000
    while (newUp === undefined && now() < deadline) {
      const sample = await health(port, 250)
      if (!sample.ok) sawDown = true
      else if (!sawDown && oldGone === undefined) lastOld = sample.at
      else newUp = sample.at
      if (newUp === undefined) await new Promise((done) => setTimeout(done, 20))
    }
    if (newUp === undefined) throw new Error('the successor never answered /health')
    // The browser's view after the listener is back: its pings, every 250 ms, for 15 s.
    const pings: number[] = []
    const pingUntil = now() + 15_000
    while (now() < pingUntil) {
      const sample = await health(port, FORCE_CLOSE_MS)
      pings.push(sample.ok ? now() - sample.at : FORCE_CLOSE_MS)
      await new Promise((done) => setTimeout(done, 250))
    }
    // Both processes append to the same log; the successor's records come last.
    const stages = bootStages(join(root, 'state', 'logs', 'server.ndjson'))
    for (const [stage, ms] of successor.stages) stages.set(stage, ms)
    console.log(
      JSON.stringify({
        handoverProbe: 'takeover',
        fileDirs: FILE_DIRS,
        files: FILE_COUNT,
        oldLastAnsweredAfterSpawnMs: Math.round(lastOld - spawnedAt),
        oldExitAfterSpawnMs: oldGone === undefined ? null : Math.round(oldGone - spawnedAt),
        gapMs: Math.round(newUp - lastOld),
        newHealthyAfterSpawnMs: Math.round(newUp - spawnedAt),
        newEnteredAgeMs: stages.get('server entered') ?? null,
        newStoreOpenAgeMs: stages.get('store open') ?? null,
        newListenAgeMs: stages.get('listen') ?? null,
        slowestPingAfterListenMs: Math.round(Math.max(...pings)),
        pingsOverPingDown: pings.filter((ms) => ms > PING_DOWN_MS).length,
      }),
    )
  } finally {
    kill(successor?.child.pid)
    kill(old.child.pid)
    writeFileSync(join(root, 'takeover.log'), log.join('\n'))
  }
}

// ---------------------------------------------------------------------------------------
// The orchestrator: both arms, alternating, on fresh copies.
// ---------------------------------------------------------------------------------------

async function runProbe(
  probe: 'reattach' | 'takeover',
  arm: string,
  root: string,
): Promise<Record<string, number>> {
  const child = spawn(
    bun,
    [
      '--conditions=@podium/source',
      import.meta.filename,
      `--probe=${probe}`,
      `--checkout=${arm}`,
      `--state=${root}`,
      `--machines=${MACHINES}`,
      `--sessions=${SESSIONS_PER_MACHINE}`,
      `--exited=${EXITED}`,
      `--fileDirs=${FILE_DIRS}`,
      `--files=${FILE_COUNT}`,
    ],
    { cwd: arm, env: benchEnvironment(root), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  const log: string[] = []
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  let result: Record<string, number> | undefined
  createInterface({ input: child.stdout }).on('line', (line) => {
    log.push(line)
    if (!line.startsWith('{"handoverProbe"')) return
    result = JSON.parse(line)
  })
  createInterface({ input: child.stderr }).on('line', (line) => log.push(line))
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      /* gone */
    }
  }, 600_000)
  const code = await exited
  clearTimeout(timer)
  writeFileSync(join(root, `${probe}.probe.log`), log.join('\n'))
  if (code !== 0 || !result)
    throw new Error(`${probe} probe exited ${code}: ${log.slice(-30).join('\n')}`)
  return result
}

function freshRoot(base: string, name: string): string {
  const root = join(base, name)
  rmSync(root, { recursive: true, force: true })
  for (const dir of [
    'state',
    'home',
    'tmp',
    'runtime',
    'cache',
    'config',
    'data',
    'xdg-state',
    'abduco',
  ])
    mkdirSync(join(root, dir), { recursive: true })
  return root
}

async function main(): Promise<void> {
  // `--arms=D:<rev>,A:<rev>,B:<rev>`, or the two-arm `--a=<rev> --b=<rev>`.
  const armSpecs = args.arms
    ? args.arms.split(',').map((spec) => {
        const [label, rev] = spec.split(':')
        if (!label || !rev) throw new Error(`--arms entry ${spec} is not <label>:<rev>`)
        return { label, rev }
      })
    : args.a && args.b
      ? [
          { label: 'A', rev: args.a },
          { label: 'B', rev: args.b },
        ]
      : undefined
  if (!armSpecs) throw new Error('--arms or --a and --b are required')
  const base = resolve(args.root ?? `/tmp/server-data-bench-handover-${Date.now()}`)
  if (!base.includes('server-data-bench')) throw new Error('isolated bench root required')
  mkdirSync(base, { recursive: true })
  const rounds = Number(args.rounds ?? 3)
  const probes = (args.probes ?? 'reattach,takeover').split(',') as ('reattach' | 'takeover')[]
  const shas: Record<string, string> = {}
  const arms: Record<string, string> = {}
  try {
    for (const { label, rev } of armSpecs) {
      shas[label] = command(checkout, 'git', ['rev-parse', rev])
      const path = join(base, label)
      if (!existsSync(path))
        command(checkout, 'git', ['worktree', 'add', '--detach', path, shas[label]!])
      command(path, 'bun', ['run', 'setup:worktree'])
      arms[label] = path
    }
    const template = freshRoot(base, 'template')
    if (probes.includes('takeover')) fileTree(join(template, 'state'))
    const results: Record<string, unknown>[] = []
    for (const probe of probes) {
      for (let round = 1; round <= rounds; round++) {
        for (const { label } of armSpecs) {
          const name = `${probe}-${label}-${round}`
          const root = join(base, name)
          rmSync(root, { recursive: true, force: true })
          if (probe === 'takeover') cpSync(template, root, { recursive: true })
          else freshRoot(base, name)
          const result = {
            probe,
            arm: label,
            round,
            ...(await runProbe(probe, arms[label]!, root)),
          }
          results.push(result)
          console.log(JSON.stringify(result))
          writeFileSync(join(base, 'results.json'), JSON.stringify({ shas, results }, null, 2))
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
    for (const probe of probes) {
      for (const { label } of armSpecs) {
        const rows = results.filter((row) => row.probe === probe && row.arm === label)
        const keys = Object.keys(rows[0] ?? {}).filter(
          (key) => typeof rows[0]?.[key] === 'number' && key !== 'round',
        )
        console.log(
          JSON.stringify({
            probe,
            arm: label,
            sha: shas[label],
            median: Object.fromEntries(
              keys.map((key) => [key, median(rows.map((row) => row[key] as number))]),
            ),
          }),
        )
      }
    }
    console.log(`Evidence: ${base}/results.json`)
  } finally {
    for (const path of Object.values(arms)) {
      if (existsSync(path)) command(checkout, 'git', ['worktree', 'remove', '--force', path])
    }
  }
}

if (import.meta.main) {
  if (args.probe === 'reattach') await reattachProbe(args.checkout ?? checkout, args.state!)
  else if (args.probe === 'takeover') await takeoverProbe(args.checkout ?? checkout, args.state!)
  else await main()
}
