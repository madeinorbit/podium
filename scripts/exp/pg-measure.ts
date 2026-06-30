/**
 * Experiment harness: bring up the bundled embedded Postgres with logical
 * replication enabled, prove CDC works (the mechanism Electric/PowerSync/Zero
 * consume), and measure the idle memory footprint of the whole postmaster
 * process group (RSS + PSS) plus the process count.
 *
 * Run: bun scripts/exp/pg-measure.ts [dataDir] [port]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

const dataDir = process.argv[2] ?? '/tmp/claude-1000/-home-user-src-other-podium/16176d5a-17d0-439d-84f3-468aa7832434/scratchpad/pgdata'
const port = Number(process.argv[3] ?? 54329)

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user: 'podium',
  password: 'podium',
  authMethod: 'password',
  persistent: true,
  // The exact knobs a CDC sync engine (ElectricSQL / PowerSync / Zero) requires.
  postgresFlags: [
    '-c', 'wal_level=logical',
    '-c', 'max_wal_senders=4',
    '-c', 'max_replication_slots=4',
  ],
})

const kb = (status: string, key: string): number => {
  const m = status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'))
  return m ? Number(m[1]) : 0
}

function pidStat(pid: number): { ppid: number; comm: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm is in parens and may contain spaces/parens; split on last ')'
    const close = stat.lastIndexOf(')')
    const comm = stat.slice(stat.indexOf('(') + 1, close)
    const rest = stat.slice(close + 2).split(' ')
    const ppid = Number(rest[1]) // field 4 (ppid) → index 1 after state
    return { ppid, comm }
  } catch {
    return null
  }
}

function memOf(pid: number): { rssKb: number; pssKb: number; cmd: string } | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const rssKb = kb(status, 'VmRSS')
    let pssKb = 0
    try {
      pssKb = kb(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'), 'Pss')
    } catch {}
    let cmd = ''
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    } catch {}
    return { rssKb, pssKb, cmd }
  } catch {
    return null
  }
}

function postgresProcGroup(postmasterPid: number): number[] {
  const pids = new Set<number>([postmasterPid])
  // Postgres children are direct children of the postmaster.
  for (const ent of readdirSync('/proc')) {
    const pid = Number(ent)
    if (!Number.isInteger(pid)) continue
    const s = pidStat(pid)
    if (s && s.ppid === postmasterPid) pids.add(pid)
  }
  return [...pids]
}

async function main() {
  const fresh = !existsSync(join(dataDir, 'PG_VERSION'))
  if (fresh) {
    console.log(`[exp] initialising new cluster at ${dataDir}`)
    await pg.initialise()
  } else {
    console.log(`[exp] reusing existing cluster at ${dataDir}`)
  }
  await pg.start()
  console.log(`[exp] postgres started on port ${port}`)

  const c = pg.getPgClient()
  await c.connect()

  // ---- CDC proof -----------------------------------------------------------
  const wal = (await c.query('SHOW wal_level')).rows[0].wal_level
  console.log(`\n=== CDC PROOF (wal_level=${wal}) ===`)

  await c.query('CREATE TABLE IF NOT EXISTS cdc_demo(id serial primary key, val text)')

  // test_decoding slot → human-readable change stream
  await c.query(
    "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name IN ('podium_test','podium_pgoutput')",
  )
  await c.query("SELECT pg_create_logical_replication_slot('podium_test','test_decoding')")

  // pgoutput slot + publication → the EXACT mechanism Electric/PowerSync/Zero use
  await c.query('DROP PUBLICATION IF EXISTS podium_pub')
  await c.query('CREATE PUBLICATION podium_pub FOR ALL TABLES')
  await c.query("SELECT pg_create_logical_replication_slot('podium_pgoutput','pgoutput')")

  await c.query("INSERT INTO cdc_demo(val) VALUES ('hello-from-cdc'),('second-row')")

  const peek = await c.query(
    "SELECT data FROM pg_logical_slot_peek_changes('podium_test', NULL, NULL)",
  )
  console.log('test_decoding stream (proves logical decoding captures the writes):')
  for (const r of peek.rows) console.log('  ', r.data)

  const slots = await c.query(
    'SELECT slot_name, plugin, slot_type, active FROM pg_replication_slots ORDER BY slot_name',
  )
  console.log('\nreplication slots:')
  for (const r of slots.rows)
    console.log(`   ${r.slot_name}  plugin=${r.plugin}  type=${r.slot_type}  active=${r.active}`)

  const pubCnt = (await c.query("SELECT count(*)::int n FROM pg_publication WHERE pubname='podium_pub'")).rows[0].n
  console.log(`\npublication 'podium_pub' present: ${pubCnt === 1}`)
  console.log('=> A CDC sync engine (Electric/PowerSync/Zero) could attach to this server.')

  await c.end()

  // ---- idle memory measurement --------------------------------------------
  // settle
  await new Promise((r) => setTimeout(r, 2500))
  const postmasterPid = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0].trim())
  const pids = postgresProcGroup(postmasterPid)

  console.log(`\n=== IDLE MEMORY (postgres process group, ${pids.length} procs) ===`)
  let rssSum = 0
  let pssSum = 0
  for (const pid of pids.sort((a, b) => a - b)) {
    const m = memOf(pid)
    if (!m) continue
    rssSum += m.rssKb
    pssSum += m.pssKb
    const label = m.cmd || pidStat(pid)?.comm || '?'
    console.log(
      `   pid ${String(pid).padStart(7)}  RSS ${String(Math.round(m.rssKb / 1024)).padStart(4)}M  PSS ${String(Math.round(m.pssKb / 1024)).padStart(4)}M  ${label.slice(0, 70)}`,
    )
  }
  console.log(`   ----`)
  console.log(`   TOTAL  procs=${pids.length}  RSS=${(rssSum / 1024).toFixed(1)}M  PSS=${(pssSum / 1024).toFixed(1)}M`)
  console.log(
    `\n[exp] (RSS double-counts the shared_buffers segment across procs; PSS is the honest number.)`,
  )

  await pg.stop()
  console.log('[exp] postgres stopped')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
