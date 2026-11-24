/**
 * Pre-migration backup in the update handover (POD-7576), for an agent VM only. Never
 * point it at a live instance's state: every database it uses is generated here.
 *
 * bun --conditions=@podium/source scripts/server-data-bench/migration-backup.ts
 *   --arms=A:<parent>,B:<candidate> [--rounds=3] [--mb=3072] [--churn=2000]
 *   [--root=/tmp/server-data-bench-migration-backup-…]
 *
 * Each arm is a detached worktree of its revision and runs, in A B A B order and each in
 * a fresh process on a fresh copy of one generated database (`--mb` of row data behind a
 * one-migration ledger):
 *
 * 1. The old server, still serving. A writer commits a small transaction every 20 ms
 *    (the serving load) and a 10 ms timer watches the event loop. An arm that has the
 *    seed (`migrations/backup-seed.ts`) writes it now, as its update server step does
 *    before it asks to restart. An arm without one does nothing here.
 * 2. The writes between that and the handover: `--churn` rows updated and as many added.
 * 3. The new server's boot, which is the handover gap: the arm's own
 *    `runDrizzleMigrations` with one pending migration and the database path, so its
 *    pre-migration backup runs exactly as at boot. Measured: the call's wall time.
 *
 * Then the published backup's bytes are compared with the database file as it was when
 * the boot began (hashes taken outside every timing). A mismatch fails the run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { median } from './report'
import { parseArgs } from './seed'

const checkout = resolve(import.meta.dir, '../..')
const bun = process.execPath
const args = parseArgs(process.argv.slice(2))

const MEGABYTES = Number(args.mb ?? 3_072)
const CHURN = Number(args.churn ?? 2_000)
const FIRST = { name: '20990101000000_bench-first', sql: 'CREATE TABLE fill (v BLOB)' }
const SECOND = { name: '20990101000001_bench-second', sql: 'CREATE TABLE added (v TEXT)' }
const ROW_BYTES = 64 << 10

function command(cwd: string, executable: string, argv: string[]): string {
  const result = spawnSync(executable, argv, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (result.status !== 0)
    throw new Error(`${executable} ${argv.join(' ')}: ${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 8 << 20 })) hash.update(chunk)
  return hash.digest('hex')
}

/** A longest-gap monitor on a 10 ms timer. */
function loopMonitor() {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 10)
  return () => {
    clearInterval(timer)
    return Math.round(Math.max(longest, performance.now() - last))
  }
}

type Db = {
  exec(sql: string): void
  prepare(sql: string): { run(...params: unknown[]): unknown }
  close(): void
}

// ---------------------------------------------------------------------------------------
// The probe: one arm, one fresh process, one fresh copy.
// ---------------------------------------------------------------------------------------

async function probe(arm: string, root: string): Promise<void> {
  const mod = async <T>(path: string): Promise<T> => (await import(join(arm, path))) as T
  const { runDrizzleMigrations } = await mod<
    typeof import('../../apps/server/src/migrations/index')
  >('apps/server/src/migrations/index.ts')
  const { openDatabase } = await mod<typeof import('../../packages/runtime/src/sqlite/index')>(
    'packages/runtime/src/sqlite/index.ts',
  )
  const seedModule = existsSync(join(arm, 'apps/server/src/migrations/backup-seed.ts'))
    ? await mod<typeof import('../../apps/server/src/migrations/backup-seed')>(
        'apps/server/src/migrations/backup-seed.ts',
      )
    : undefined

  const dbPath = join(root, 'podium.db')
  const db = openDatabase(dbPath) as unknown as Db
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('CREATE TABLE IF NOT EXISTS serving (at REAL)')
  const serve = db.prepare('INSERT INTO serving (at) VALUES (?)')

  // 1. The old server, serving, while it seeds (or not).
  let slowestCommitMs = 0
  let commits = 0
  const writer = setInterval(() => {
    const started = performance.now()
    serve.run(started)
    commits++
    slowestCommitMs = Math.max(slowestCommitMs, performance.now() - started)
  }, 20)
  const stopMonitor = loopMonitor()
  const seedStarted = performance.now()
  const seed = seedModule ? await seedModule.writeBackupSeed(dbPath) : undefined
  const seedMs = performance.now() - seedStarted
  // Keep serving a moment past the seed so its tail is measured too.
  await new Promise((done) => setTimeout(done, 500))
  clearInterval(writer)
  const oldServerLongestStallMs = stopMonitor()
  if (seed && !seed.seeded) throw new Error(`the seed was not written: ${seed.reason}`)

  // 2. What the old server writes after the seed, before it is asked to stop.
  const touch = db.prepare('UPDATE fill SET v = randomblob(?) WHERE rowid = ?')
  const add = db.prepare('INSERT INTO fill (v) VALUES (randomblob(?))')
  const rows = Math.floor((MEGABYTES * 1024 * 1024) / ROW_BYTES)
  db.exec('BEGIN')
  for (let n = 0; n < CHURN; n++) {
    touch.run(1_024, 1 + ((n * 7_919) % rows))
    add.run(1_024)
  }
  db.exec('COMMIT')

  // The database exactly as the boot finds it (hashed outside the timing).
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const liveHash = await sha256(dbPath)

  // 3. The successor's boot: the handover gap.
  const bootStarted = performance.now()
  const applied = runDrizzleMigrations(db as never, [FIRST, SECOND], { dbPath })
  const bootMs = performance.now() - bootStarted
  db.close()
  if (applied.join() !== SECOND.name) throw new Error(`unexpected migrations: ${applied}`)

  const backups = readdirSync(root).filter(
    (name) => name.includes('.backup-v') && !name.endsWith('-wal') && !name.endsWith('-shm'),
  )
  if (backups.length !== 1) throw new Error(`expected one backup, found ${backups.join(', ')}`)
  const backupHash = await sha256(join(root, backups[0]!))
  const leftovers = readdirSync(root).filter((name) => name.includes('backup-seed'))
  console.log(
    JSON.stringify({
      migrationBackupProbe: true,
      databaseMb: MEGABYTES,
      databaseFileMb: Math.round(statSync(join(root, backups[0]!)).size / 1024 / 1024),
      churnRows: CHURN,
      seeded: seed?.seeded === true ? 1 : 0,
      seedMs: Math.round(seedMs),
      oldServerLongestStallMs,
      oldServerSlowestCommitMs: Math.round(slowestCommitMs),
      oldServerCommits: commits,
      gapBootBackupMs: Math.round(bootMs),
      backupMatchesDatabase: backupHash === liveHash ? 1 : 0,
      seedFilesLeft: leftovers.length,
    }),
  )
  if (backupHash !== liveHash) throw new Error('the backup does not match the database')
}

// ---------------------------------------------------------------------------------------
// The orchestrator.
// ---------------------------------------------------------------------------------------

async function runProbe(arm: string, root: string): Promise<Record<string, number>> {
  const child = spawn(
    bun,
    [
      '--conditions=@podium/source',
      import.meta.filename,
      '--probe=1',
      `--checkout=${arm}`,
      `--state=${root}`,
      `--mb=${MEGABYTES}`,
      `--churn=${CHURN}`,
    ],
    {
      cwd: arm,
      env: { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const log: string[] = []
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  let result: Record<string, number> | undefined
  createInterface({ input: child.stdout }).on('line', (line) => {
    log.push(line)
    if (line.startsWith('{"migrationBackupProbe"')) result = JSON.parse(line)
  })
  createInterface({ input: child.stderr }).on('line', (line) => log.push(line))
  const code = await exited
  writeFileSync(join(root, 'probe.log'), log.join('\n'))
  if (code !== 0 || !result) throw new Error(`probe exited ${code}: ${log.slice(-30).join('\n')}`)
  return result
}

/** The shared starting database: `--mb` of 64 KiB rows behind the first migration. */
async function template(path: string): Promise<void> {
  const { runDrizzleMigrations } = await import('../../apps/server/src/migrations/index')
  const { openDatabase } = await import('../../packages/runtime/src/sqlite/index')
  const db = openDatabase(path) as unknown as Db
  try {
    db.exec('PRAGMA journal_mode = WAL')
    runDrizzleMigrations(db as never, [FIRST], { dbPath: path })
    const rows = Math.floor((MEGABYTES * 1024 * 1024) / ROW_BYTES)
    db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${rows})
      INSERT INTO fill (v) SELECT randomblob(${ROW_BYTES}) FROM n`)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const armSpecs = (args.arms ?? '').split(',').flatMap((spec) => {
    if (!spec) return []
    const [label, rev] = spec.split(':')
    if (!label || !rev) throw new Error(`--arms entry ${spec} is not <label>:<rev>`)
    return [{ label, rev }]
  })
  if (armSpecs.length === 0) throw new Error('--arms=A:<rev>,B:<rev> is required')
  const base = resolve(args.root ?? `/tmp/server-data-bench-migration-backup-${Date.now()}`)
  if (!base.includes('server-data-bench')) throw new Error('isolated bench root required')
  mkdirSync(base, { recursive: true })
  const rounds = Number(args.rounds ?? 3)
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
    const templatePath = join(base, 'template.db')
    await template(templatePath)
    const results: Record<string, unknown>[] = []
    for (let round = 1; round <= rounds; round++) {
      for (const { label } of armSpecs) {
        const root = join(base, `${label}-${round}`)
        rmSync(root, { recursive: true, force: true })
        for (const dir of ['home', 'tmp']) mkdirSync(join(root, dir), { recursive: true })
        copyFileSync(templatePath, join(root, 'podium.db'))
        const result = { arm: label, round, ...(await runProbe(arms[label]!, root)) }
        results.push(result)
        console.log(JSON.stringify(result))
        writeFileSync(join(base, 'results.json'), JSON.stringify({ shas, results }, null, 2))
        rmSync(root, { recursive: true, force: true })
      }
    }
    for (const { label } of armSpecs) {
      const rows = results.filter((row) => row.arm === label)
      const keys = Object.keys(rows[0] ?? {}).filter(
        (key) => typeof rows[0]?.[key] === 'number' && key !== 'round',
      )
      console.log(
        JSON.stringify({
          arm: label,
          sha: shas[label],
          median: Object.fromEntries(
            keys.map((key) => [key, median(rows.map((row) => row[key] as number))]),
          ),
        }),
      )
    }
    console.log(`Evidence: ${base}/results.json`)
  } finally {
    for (const path of Object.values(arms)) {
      if (existsSync(path)) command(checkout, 'git', ['worktree', 'remove', '--force', path])
    }
    rmSync(join(base, 'template.db'), { force: true })
    rmSync(join(base, 'template.db-wal'), { force: true })
    rmSync(join(base, 'template.db-shm'), { force: true })
  }
}

if (import.meta.main) {
  if (args.probe) await probe(args.checkout ?? checkout, args.state!)
  else await main()
}
