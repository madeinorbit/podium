/**
 * THE PER-RUN TABLE NAMESPACE — why every table in this slice carries a prefix
 * [POD-3358].
 *
 * The hosted spike database is ONE database shared by every run, and
 * {@link openSlice} drops and recreates its tables on the way in. Two runs
 * overlapping therefore did not merely contend: each one deleted the other's
 * rows mid-flight. POD-3292's review reproduced it deliberately and got FALSE
 * SEQUENCE RESULTS — a proof about contiguous seqs starting from 1 reported a
 * clean answer that was an artefact of the neighbour's `DROP TABLE`, not of the
 * engine. POD-3345 met the same defect from the other side on the same day: an
 * arm died at 0.2 s with a parse error it could not reproduce and guessed,
 * correctly, that the database had been reset underneath it.
 *
 * A crash is survivable. The reason this got its own issue is the OTHER
 * outcome: a plausible wrong number, produced by a proof whose entire purpose is
 * to establish facts the epic's design is being built on.
 *
 * SO EVERY RUN GETS ITS OWN TABLE NAMES. The prefix is minted once per process
 * and every table, index and `sqlite_sequence` lookup in the slice is spelled
 * through it, which means two concurrent runs cannot see or destroy each other's
 * rows even though they share one database. A namespace rather than a lease
 * because a lease serialises: runs would queue behind each other over a ~95 ms
 * link, and the contention proof genuinely needs two clients writing at once.
 *
 * WHAT THIS DOES NOT BUY, stated here so nobody reads more into it: the
 * database's WRITE LOCK is still shared. Row isolation is total; exclusivity is
 * not. Proofs that measure latency or transaction lifetime (5, 7, 9, 11) can
 * still be perturbed by a neighbour holding the write lock, so `run-proofs.ts`
 * takes a separate lease around the hosted arm — see `run-lease.ts`.
 */

import { randomBytes } from 'node:crypto'

/**
 * The environment variable that pins the prefix, and the one control the
 * POD-3358 evidence run needs.
 *
 * Set to a value, every slice in the process uses it — which is how two
 * processes can be pointed at the SAME namespace on purpose. Set to the EMPTY
 * string, the slice uses no prefix at all and the tables are named exactly as
 * they were before this fix: `changes`, `change_latest`, `locks`,
 * `feed_identity`. That is not a convenience, it is the A/B control. The
 * concurrency check runs its "old arrangement" arm by setting this to empty and
 * nothing else, so the failing arm and the passing arm differ by one
 * environment variable rather than by a build.
 */
export const PREFIX_ENV = 'PODIUM_SPIKE_TABLE_PREFIX'

/** The physical table names this slice creates, without any prefix. */
export const SPIKE_TABLE_BASENAMES = [
  'changes',
  'change_latest',
  'locks',
  'feed_identity',
] as const

/**
 * Mint a fresh namespace.
 *
 * RANDOM RATHER THAN A PID OR A TIMESTAMP. Two runs on two machines — this
 * laptop and CI — can hold the same pid, and a second-resolution timestamp
 * collides whenever a script launches two runs at once, which is precisely the
 * case the fix exists for. 48 bits of randomness makes a collision between the
 * handful of runs that are ever live at once not worth reasoning about.
 *
 * The shape is `sp_<hex>_`: it starts with a letter so it is a bare SQL
 * identifier needing no quoting, and it ends with `_` so the prefixed name has
 * no word boundary before the base name — which is what lets
 * {@link unprefixedTableUse} tell `sp_ab12_changes` from a bare `changes` with a
 * single regex.
 */
export function newTablePrefix(): string {
  return `sp_${randomBytes(6).toString('hex')}_`
}

let processPrefix: string | undefined

/**
 * The prefix every slice in THIS process shares, minted on first use.
 *
 * Process-wide and not per-slice, because several proofs deliberately open two
 * or three slices over the same tables — proof 3 has two clients appending
 * alternately and proof 7 has one holding a write transaction while another
 * contends. Those are the questions the proof exists to ask, so slices within a
 * run must land in the same namespace; only separate RUNS are isolated.
 */
export function runTablePrefix(): string {
  const pinned = process.env[PREFIX_ENV]
  if (pinned !== undefined) return pinned
  processPrefix ??= newTablePrefix()
  return processPrefix
}

/** Prefix one base table or index name. */
export function prefixed(prefix: string, name: string): string {
  return `${prefix}${name}`
}

/**
 * Find a table name that escaped the namespace, or `undefined` when none did.
 *
 * THIS IS THE MECHANISM THAT MAKES THE FIX HOLD, and it is here because a
 * prefix threaded by hand through nine files is exactly the kind of change that
 * is 95% done and silently wrong. The slice does not only build its SQL through
 * drizzle: `run-proofs.ts` and the integration test issue a dozen raw statements
 * that name `changes` in a template string, and one of them is a
 * `sqlite_sequence` lookup keyed on the LITERAL 'changes'. Miss any one and that
 * statement quietly goes back to the shared table — the defect restored, with
 * every test still green.
 *
 * So rather than trusting a grep, the counted client runs this over the body of
 * every request it sends and throws on a hit. A missed site fails loudly at its
 * first statement instead of corrupting a neighbour.
 *
 * The word boundary is doing the work. A prefixed name is `sp_ab12_changes`, so
 * the character before `changes` is `_` — a word character — and `\bchanges\b`
 * cannot match there. A bare `changes` is always preceded by a space, a quote, a
 * parenthesis or nothing, all of which are boundaries. The same holds for the
 * quoted literal inside the `sqlite_sequence` lookup, which is the site most
 * likely to be forgotten and the one a table-name-only check would not see.
 */
export function unprefixedTableUse(sqlText: string): string | undefined {
  const pattern = new RegExp(`\\b(${SPIKE_TABLE_BASENAMES.join('|')})\\b`)
  return pattern.exec(sqlText)?.[1]
}
