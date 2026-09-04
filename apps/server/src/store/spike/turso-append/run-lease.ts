/**
 * AN EXCLUSIVE LEASE ON THE HOSTED DATABASE, for the proofs that measure TIME
 * [POD-3358].
 *
 * WHY A NAMESPACE IS NOT THE WHOLE FIX. Prefixing every table stops two runs
 * from seeing or destroying each other's ROWS, and that is the defect POD-3292's
 * review reproduced. It does not make them independent, because one thing in a
 * libsql database is emphatically not per-table: THE WRITE LOCK. Two runs in
 * separate namespaces still queue behind each other to write, and four of the
 * proofs are measurements of exactly that:
 *
 *   - proof 5 counts round trips and reports the milliseconds they cost;
 *   - proof 7 asks what a second writer receives against a held transaction —
 *     and a THIRD writer nobody accounted for changes the answer;
 *   - proof 9 asks whether the write budget bounds idle time or total time, by
 *     holding a transaction open for 20 s and seeing whether it commits;
 *   - proof 11 asks the same of the port's watchdog.
 *
 * Proof 9 is the one that shows why this is not tidiness. Its arm A commits
 * after 20 s of chatter, and that is how the proof concludes the budget bounds
 * the GAP rather than the duration. A neighbour holding the write lock for a few
 * seconds can make arm A fail — and the run would then conclude the opposite,
 * that a long transaction is impossible, which is a landed rule's worth of wrong
 * derived from a scheduling accident. Same shape as the sequence defect: not a
 * crash, a plausible wrong number.
 *
 * So the hosted arm takes an exclusive lease and A RUN THAT CANNOT GET IT DOES
 * NOT RUN. The brief for this issue is explicit that the fallback must not be
 * silent, because a silent overlap is the failure being fixed — so a refused
 * lease prints a banner naming the holder and when the lease frees, and the
 * hosted proofs are skipped rather than run against a moving target.
 *
 * THE LEASE LIVES IN THE DATABASE IT PROTECTS, deliberately. The thing being
 * serialised is access to one hosted database, and every process that can reach
 * it can reach this table — a lock kept on one machine's filesystem would not
 * exclude CI, and this slice is meant to stay runnable without the Podium CLI.
 * Its table is NOT namespaced, for the obvious reason: a per-run lock excludes
 * nobody.
 */

import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { type BackendConfig, createCountedClient } from './client'

/** The one row every hosted run contends for. */
const LEASE_TABLE = 'spike_run_lease'
const LEASE_NAME = 'hosted-proof'

/**
 * How long a lease is good for, and how often the holder renews it.
 *
 * SHORT WITH A HEARTBEAT rather than long and hopeful. The hosted proof runs for
 * several minutes, so a TTL that merely covers it would leave the database
 * locked for that long after a crash — and this script is killed by hand often
 * enough for that to matter. Two minutes, renewed every thirty seconds, means a
 * run that dies frees the database in about the time it takes to notice.
 */
const TTL_MS = 120_000
const RENEW_EVERY_MS = 30_000

export interface RunLease {
  /** Stop renewing and give the lease up. */
  release(): Promise<void>
}

/** Who this process is, in a message a human can act on. */
function holderLabel(): string {
  return `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
}

/**
 * Take the lease, or report who holds it.
 *
 * The acquisition is ONE STATEMENT and that is load-bearing. A read-then-write
 * would have exactly the race this whole issue is about: two runs both read "no
 * holder", both write, both believe they are exclusive. `ON CONFLICT DO UPDATE
 * … WHERE` lets the engine decide under its own row lock — the update applies
 * only when the incumbent lease has actually expired, and `rowsAffected` tells
 * the caller which way it went.
 */
export async function acquireRunLease(
  config: BackendConfig,
  now: number = Date.now(),
): Promise<RunLease | { refused: true; holder: string; freeAt: string }> {
  // No prefix: this table is shared on purpose, and the namespace guard would
  // have nothing to say about it in any case.
  const { client } = createCountedClient(config)
  const holder = holderLabel()

  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${LEASE_TABLE} (
       name TEXT PRIMARY KEY,
       holder TEXT NOT NULL,
       expires_at INTEGER NOT NULL
     )`,
  )

  const take = async (at: number): Promise<boolean> => {
    const result = await client.execute({
      sql: `INSERT INTO ${LEASE_TABLE} (name, holder, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
            WHERE ${LEASE_TABLE}.expires_at <= ? OR ${LEASE_TABLE}.holder = ?`,
      args: [LEASE_NAME, holder, at + TTL_MS, at, holder],
    })
    return result.rowsAffected > 0
  }

  if (!(await take(now))) {
    const current = await client.execute({
      sql: `SELECT holder, expires_at FROM ${LEASE_TABLE} WHERE name = ?`,
      args: [LEASE_NAME],
    })
    const row = current.rows[0] as unknown as Record<string, unknown> | undefined
    const freeAt =
      row === undefined ? 'unknown' : new Date(Number(row.expires_at)).toISOString().slice(11, 19)
    client.close()
    return { refused: true, holder: row === undefined ? 'unknown' : String(row.holder), freeAt }
  }

  // Renewal keeps the TTL short without ending the run early. `unref` so a
  // forgotten timer cannot hold the process open after the proofs finish.
  const timer = setInterval(() => {
    void take(Date.now()).catch(() => {})
  }, RENEW_EVERY_MS)
  timer.unref?.()

  return {
    release: async () => {
      clearInterval(timer)
      try {
        await client.execute({
          sql: `DELETE FROM ${LEASE_TABLE} WHERE name = ? AND holder = ?`,
          args: [LEASE_NAME, holder],
        })
      } finally {
        client.close()
      }
    },
  }
}

/** The banner a refused run prints instead of quietly measuring a moving target. */
export function refusalBanner(refusal: { holder: string; freeAt: string }): string {
  const bar = '!'.repeat(72)
  return [
    bar,
    'HOSTED PROOFS SKIPPED — another run holds the spike database.',
    '',
    `  holder:        ${refusal.holder}`,
    `  lease expires: ${refusal.freeAt} UTC`,
    '',
    '  The hosted database is shared, and proofs 5, 7, 9 and 11 measure latency',
    '  and transaction lifetime — a second run writing at the same time changes',
    '  their answers without changing how correct they look. Rerun when the',
    '  lease above has expired. [POD-3358]',
    bar,
  ].join('\n')
}

/**
 * Drop namespaces left behind by runs that died before collecting their own.
 *
 * ONLY SAFE UNDER THE LEASE, and that is why it lives in this file rather than
 * beside the namespace helpers. `sp_…` tables belong to whichever run minted
 * them, and a live neighbour's tables look exactly like an abandoned one's —
 * there is no way to tell them apart from outside. The hosted arm can sweep
 * precisely because holding the lease means there IS no neighbour; a caller
 * without the lease that swept would recreate the original defect with extra
 * steps.
 *
 * Scoped to the `sp_` prefix so it can only ever reach tables this slice
 * minted, and reports what it dropped rather than doing it quietly.
 */
export async function sweepAbandonedNamespaces(config: BackendConfig): Promise<number> {
  const { client } = createCountedClient(config)
  try {
    const found = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sp\\_%' ESCAPE '\\'",
      args: [],
    })
    const names = found.rows.map((row) => String((row as unknown as Record<string, unknown>).name))
    for (const name of names) await client.execute(`DROP TABLE IF EXISTS ${name}`)
    return names.length
  } finally {
    client.close()
  }
}
