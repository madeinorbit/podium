/**
 * Boot-only shipping recovery A/B (POD-6797). Run on the benchmark VM through
 * its lane wrapper, with committed revisions, never against an operator DB:
 *
 * bun --conditions=@podium/source scripts/server-data-bench/shipping-boot.ts
 *   --a=<parent> --b=<candidate> [--rounds=3] [--root=/tmp/server-data-bench-shipping]
 *
 * The standard h1a1/h10a1 corpus is augmented with 50/500 fully acknowledged
 * shipped orders, one successful attempt and terminal verify step each. Both
 * arms have zero active shipping work and zero outstanding recovery debt.
 * A synthetic acknowledgement port answers immediately; the benchmark counts
 * those calls instead of waiting for offline fixture machines' RPC deadlines.
 * Each arm warms once, then fresh copies boot in A B A B order. Listen time
 * and the first ShippingService.reconcile duration are measured separately:
 * relay starts recovery without awaiting it, so it can finish after listen.
 */
import { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ShippingService as Service } from '../../apps/server/src/modules/shipping/service'
import { median } from './report'
import { benchEnvironment } from './run'
import { parseArgs } from './seed'

const checkout = resolve(import.meta.dir, '../..')
const bun = process.execPath
const args = parseArgs(process.argv.slice(2))

function command(cwd: string, executable: string, argv: string[]): string {
  const result = spawnSync(executable, argv, { cwd, encoding: 'utf8', maxBuffer: 32 << 20 })
  if (result.status !== 0)
    throw new Error(`${executable} ${argv.join(' ')}: ${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}

function shippingHistory(dbPath: string, count: number): void {
  const db = new Database(dbPath)
  try {
    const source = db
      .prepare(`SELECT i.id AS issueId, i.repo_path AS repoPath,
      r.machine_id AS machineId, r.repo_id AS repoId, i.owner_user_id AS memberId
      FROM issues i JOIN repos r ON r.path = i.repo_path
      WHERE i.branch IS NOT NULL AND r.repo_id IS NOT NULL LIMIT 1`)
      .get() as {
      issueId: string
      repoPath: string
      machineId: string
      repoId: string
      memberId: string
    } | null
    if (!source) throw new Error('standard corpus has no shipping source issue')
    const order = db.prepare(`INSERT INTO ship_orders
      (id, issue_id, repo_id, repo_path, machine_id, target_branch, destination,
       approved_base_sha, approved_head_sha, requested_by_actor_kind, requested_by_actor_id,
       requested_by_on_behalf_of, requested_at, policy_id, validation_profile,
       validation_profile_digest, close_mode, state, state_changed_at)
      VALUES (?, ?, ?, ?, ?, 'main', 'local:main', 'base', 'head', 'user', ?, ?,
       '2026-01-01T00:00:00Z', 'compatibility-local:main', ?, ?,
       'after-destination', 'shipped', '2026-01-01T00:00:00Z')`)
    const attempt = db.prepare(`INSERT INTO ship_attempts
      (id, order_id, expected_source_base_sha, approved_head_sha, expected_target_sha,
       machine_id, lease_generation, started_at, finished_at, outcome, submitted_head_sha,
       tested_integration_sha, landed_ref_sha, destination_sha, validation_profile_id, validation_result)
      VALUES (?, ?, 'base', 'head', 'base', ?, 1, 't0', 't1', 'succeeded', 'head',
        'head', 'head', 'head', 'bench', 'passed')`)
    const step = db.prepare(`INSERT INTO ship_steps
      (id, order_id, attempt_id, effect_key, idempotency_key, generation, input_fence,
       kind, state, outcome, summary, recorded_at, started_at, finished_at)
      VALUES (?, ?, ?, 'verify:1', 'verify:1:succeeded', 1, ?, 'verify', 'succeeded',
        'proved', 'already acknowledged', 't1', 't0', 't1')`)
    const receipt = db.prepare(`INSERT INTO delivery_receipts
      (id, order_id, approved_base_sha, approved_head_sha, result_commit_sha,
       tested_integration_sha, landed_ref_sha, destination_sha, validation_profile_id,
       validation_result, destination, completed_at)
      VALUES (?, ?, 'base', 'head', 'head', 'head', 'head', 'head', 'bench', 'passed', 'local:main', 't1')`)
    const profile = JSON.stringify({
      id: 'bench',
      argv: ['true'],
      cwd: 'integration-root',
      timeoutMs: 1000,
      resourceLocks: [],
    })
    db.exec('BEGIN')
    for (let i = 0; i < count; i++) {
      const id = `bench-ship-${String(i).padStart(6, '0')}`
      order.run(
        id,
        source.issueId,
        source.repoId,
        source.repoPath,
        source.machineId,
        source.memberId,
        source.memberId,
        profile,
        createHash('sha256').update(profile).digest('hex'),
      )
      attempt.run(`attempt:${id}:1`, id, source.machineId)
      step.run(
        `step:${id}`,
        id,
        `attempt:${id}:1`,
        JSON.stringify({ sourceBaseSha: 'base', approvedHeadSha: 'head', targetSha: 'base' }),
      )
      receipt.run(`receipt:${id}`, id)
    }
    db.exec('COMMIT')
    db.exec('PRAGMA analysis_limit=1000; ANALYZE;')
  } finally {
    db.close()
  }
}

async function serve(): Promise<void> {
  const arm = args.checkout
  if (!arm) throw new Error('--checkout is required')
  if (!process.env.PODIUM_STATE_DIR?.includes('server-data-bench'))
    throw new Error('isolated bench state required')
  let shippingMs = Number.NaN
  let recoveryError: string | undefined
  let acknowledgements = 0
  let listenMs = Number.NaN
  let started = false
  let recovered!: () => void
  const recoveryDone = new Promise<void>((done) => {
    recovered = done
  })
  const { ShippingService } = (await import(
    join(arm, 'apps/server/src/modules/shipping/service.ts')
  )) as { ShippingService: typeof Service }
  const original = ShippingService.prototype.reconcile
  ShippingService.prototype.reconcile = async function () {
    if (started) return await original.call(this)
    started = true
    const deps = (this as unknown as { deps: ConstructorParameters<typeof Service>[0] }).deps
    const daemon = deps.daemon
    deps.daemon = {
      shippingJob: async (request, machineId) => {
        if (request.action !== 'acknowledge') throw new Error('unexpected active shipping work')
        acknowledgements++
        return {
          jobId: request.jobId,
          requestDigest: request.requestDigest,
          orderId: request.orderId,
          attemptId: request.attemptId,
          machineId,
          generation: request.generation,
          operation: request.operation,
          state: 'succeeded',
          classification: 'proved',
          summary: 'fixture acknowledgement',
          logs: [],
          artifactRefs: [],
          heartbeatedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:00:00Z',
        }
      },
    }
    const at = performance.now()
    try {
      await original.call(this)
    } catch (error) {
      recoveryError = String(error)
      throw error
    } finally {
      deps.daemon = daemon
      shippingMs = performance.now() - at
      recovered()
    }
  }
  const logger = await import(join(arm, 'packages/logger/src/index.ts'))
  logger.addSink({
    name: 'shipping-boot',
    minLevel: 'info',
    write: (record: { ns?: string; stage?: string; durationMs?: number }) => {
      if (record.ns === 'server:boot' && record.stage === 'listen')
        listenMs = record.durationMs ?? Number.NaN
    },
  })
  const { startServer } = await import(join(arm, 'apps/server/src/server.ts'))
  const server = await startServer({ port: 0, host: '127.0.0.1', transcriptLake: 'off' })
  if (!started) throw new Error('startup did not invoke shipping recovery')
  await recoveryDone
  console.log(
    JSON.stringify({ shippingBoot: true, shippingMs, listenMs, acknowledgements, recoveryError }),
  )
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (line === 'stop') {
      await server.close()
      process.exit(0)
    }
  }
}

async function boot(
  arm: string,
  root: string,
): Promise<{ shippingMs: number; listenMs: number; acknowledgements: number }> {
  const child = spawn(
    bun,
    ['--conditions=@podium/source', import.meta.filename, '--serve', `--checkout=${arm}`],
    {
      cwd: arm,
      env: benchEnvironment(root),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  )
  const log: string[] = []
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  try {
    const record = await new Promise<{
      shippingMs: number
      listenMs: number
      acknowledgements: number
    }>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('shipping boot exceeded 180s')), 180_000)
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`boot exited ${code}`))
      })
      child.stderr.on('data', (data) => log.push(String(data)))
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        log.push(line)
        if (!line.startsWith('{')) return
        try {
          const value = JSON.parse(line)
          if (value.shippingBoot) {
            clearTimeout(timer)
            if (value.recoveryError) reject(new Error(value.recoveryError))
            else done(value)
          }
        } catch {
          /* ordinary server output */
        }
      })
    })
    child.stdin.write('stop\n')
    if ((await exited) !== 0) throw new Error('bench server shutdown failed')
    if (!Number.isFinite(record.shippingMs) || !Number.isFinite(record.listenMs))
      throw new Error('missing boot timing')
    return record
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      /* already closed */
    }
    writeFileSync(join(root, 'boot.log'), log.join('\n'))
  }
}

async function main(): Promise<void> {
  if (!args.a || !args.b) throw new Error('--a and --b are required')
  const root = resolve(args.root ?? `/tmp/server-data-bench-shipping-${Date.now()}`)
  if (!root.includes('server-data-bench')) throw new Error('isolated bench root required')
  mkdirSync(root, { recursive: true })
  const rounds = Number(args.rounds ?? 3)
  const shas = {
    A: command(checkout, 'git', ['rev-parse', args.a]),
    B: command(checkout, 'git', ['rev-parse', args.b]),
  }
  const arms: Record<string, string> = {}
  for (const label of ['A', 'B'] as const) {
    const path = join(root, label)
    command(checkout, 'git', ['worktree', 'add', '--detach', path, shas[label]])
    command(path, 'bun', ['run', 'setup:worktree'])
    arms[label] = path
  }
  const results: {
    cell: string
    orders: number
    arm: string
    round: number
    shippingMs: number
    listenMs: number
  }[] = []
  try {
    for (const [cell, orders] of [
      ['h1a1', 50],
      ['h10a1', 500],
    ] as const) {
      const corpus = join(root, `${cell}.json`)
      command(checkout, bun, [
        '--conditions=@podium/source',
        'scripts/server-data-bench/corpus-export.ts',
        cell,
        '4443',
        corpus,
      ])
      const templates: Record<string, string> = {}
      for (const label of ['A', 'B']) {
        const template = join(root, `template-${cell}-${label}`)
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
          mkdirSync(join(template, dir), { recursive: true })
        command(checkout, bun, [
          '--conditions=@podium/source',
          'scripts/server-data-bench/seed.ts',
          `--checkout=${arms[label]}`,
          `--corpus=${corpus}`,
          `--db=${template}/state/podium.db`,
          `--out=${template}/fixture.json`,
        ])
        shippingHistory(join(template, 'state/podium.db'), orders)
        await boot(arms[label]!, template)
        templates[label] = template
      }
      for (let round = 1; round <= rounds; round++) {
        for (const label of ['A', 'B']) {
          const state = join(root, `${cell}-${label}-${round}`)
          cpSync(templates[label]!, state, { recursive: true })
          const record = { cell, orders, arm: label, round, ...(await boot(arms[label]!, state)) }
          if (record.acknowledgements !== (label === 'A' ? orders : 0)) {
            throw new Error(`unexpected acknowledgement count ${JSON.stringify(record)}`)
          }
          results.push(record)
          console.log(JSON.stringify(record))
          writeFileSync(join(root, 'results.json'), JSON.stringify({ shas, results }, null, 2))
          rmSync(state, { recursive: true, force: true })
        }
      }
    }
    for (const cell of ['h1a1', 'h10a1']) {
      for (const arm of ['A', 'B']) {
        const rows = results.filter((row) => row.cell === cell && row.arm === arm)
        console.log(
          JSON.stringify({
            cell,
            arm,
            medianShippingMs: median(rows.map((row) => row.shippingMs)),
            medianListenMs: median(rows.map((row) => row.listenMs)),
          }),
        )
      }
    }
    console.log(`Evidence: ${root}/results.json`)
  } finally {
    for (const path of Object.values(arms)) {
      if (existsSync(path)) command(checkout, 'git', ['worktree', 'remove', '--force', path])
    }
  }
}

if (import.meta.main) {
  if (args.serve !== undefined) await serve()
  else await main()
}
