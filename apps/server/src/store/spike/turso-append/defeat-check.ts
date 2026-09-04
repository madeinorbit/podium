/**
 * THE PROOF THAT THE PROOF CAN SAY NO [POD-3357].
 *
 *   bun --conditions=@podium/source apps/server/src/store/spike/turso-append/defeat-check.ts [local|remote]
 *
 * WHY THIS FILE IS THE DELIVERABLE AND `run-proofs.ts`'s ASSERTIONS ARE NOT.
 * Adding `check(...)` to a script is a change anyone can read and nobody can
 * verify. A check is not evidence until it has been watched to FAIL: this epic
 * has now caught three that could not, and the most recent — POD-3358's own
 * transport guard — inspected a `fetch` body that `@libsql/client/web` never
 * sets, so it passed on every run while looking rigorous. Assume the first
 * version of any assertion is vacuous. This file is how that assumption is
 * discharged, invariant by invariant.
 *
 * WHAT IT DOES. For each entry in the matrix below it runs `run-proofs.ts` twice
 * over the same backend, differing by ONE environment variable — the same shape
 * POD-3358 used — and demands that the injected run go RED, at the named
 * invariants, with exit 1. Then it demands the CONTROL go green. The verdict is
 * conjunctive on purpose:
 *
 *   - a control that fails means the backend, not the check, is the story, and
 *     every red below is unattributable;
 *   - an injection that comes back GREEN means the check it targets is not
 *     wired to the thing it claims to measure — the vacuity this exists to find;
 *   - an injection that never reached its site exits 4 from the child and is
 *     reported as an ERROR, not as a result, because a green run from an
 *     unapplied break is exactly the false comfort described above.
 *
 * EVERY INJECTION PERTURBS THE MEASURED SYSTEM, never the assertion's input: it
 * burns a sequence number, commits before the deliberate failure, widens an idle
 * gap past the server's budget, releases a savepoint instead of rolling it back.
 * An injection that flipped a boolean on its way into `check` would demonstrate
 * only that `check` can print the word FAIL.
 *
 * ONE ENTRY IS HONEST ABOUT BEING WEAKER THAN THE OTHERS — `log-gap`. See its
 * `caveat`, which is printed in the report rather than left to a reader.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RUN_PROOFS = fileURLToPath(new URL('./run-proofs.ts', import.meta.url))

/** The child's exit codes, mirrored from `run-proofs.ts`. */
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_SKIPPED = 3
const EXIT_INJECTION_UNUSED = 4

interface Defeat {
  /** `PODIUM_SPIKE_BREAK` value. */
  readonly id: string
  /** `PODIUM_SPIKE_ONLY` — the proofs that hold the targeted invariants. */
  readonly proofs: string
  /** What the injection actually changes about the system under measurement. */
  readonly breaks: string
  /** Substrings of the invariant labels that MUST come back FAIL. */
  readonly mustFail: readonly string[]
  /** Named limitation, printed in the report. */
  readonly caveat?: string
}

const MATRIX: readonly Defeat[] = [
  {
    id: 'seq-burned',
    proofs: '1,3',
    breaks:
      'one stray row is appended between two chunks, consuming a seq the append never learns about',
    mustFail: [
      'contiguous from 1',
      'sqlite_sequence head is the last seq handed out',
      'every range contiguous and non-overlapping',
    ],
  },
  {
    id: 'no-rollback',
    proofs: '4',
    breaks:
      'the append commits the first two chunks before the deliberate throw, so the rollback has nothing left to undo',
    mustFail: [
      'counter rolled back',
      'no rows survived in changes',
      'no rows survived in change_latest',
      'no seq was burned',
    ],
  },
  {
    id: 'roundtrip-extra',
    proofs: '5',
    breaks:
      'one extra statement is issued inside every measured window — the regression rule 24 exists to catch',
    mustFail: [
      'append 100 rows, literal port',
      'append 100 rows, batched',
      'append 250 rows (3 chunks), literal port',
      'append 250 rows (3 chunks), batched',
      'append 1 row, literal port',
      'lock acquire, uncontended',
      'lock acquire, refused',
      'lock read',
      'bootstrap read',
      'head read',
      'changesSince(0)',
    ],
  },
  {
    id: 'batch-atomic',
    proofs: '8',
    breaks:
      'the raw batch is wrapped in a savepoint, which makes the engine atomic here and the recorded finding false',
    mustFail: [
      'the failed RAW batch left its first statement applied',
      'the port savepoint is LOAD-BEARING',
    ],
  },
  {
    id: 'contention-none',
    proofs: '7',
    breaks:
      'client A releases the write lock before B arrives, so there is no contention to measure',
    mustFail: [
      'client A holds an open write transaction',
      'client B BLOCKED on the holder',
      "client A's own commit failed",
    ],
  },
  {
    id: 'log-gap',
    proofs: '7',
    breaks: 'one row is deleted from the log before the gap-free check reads it',
    mustFail: ['log is gap-free and every seq unique'],
    caveat:
      'This one perturbs the DATA, not the engine: nothing available here can make libsql interleave ' +
      'two writers. It establishes that the check reads the real table and would see a gap that was ' +
      'really there. It does NOT establish that the engine could produce one — that remains an ' +
      'unfalsified negative, and is the weakest entry in this matrix.',
  },
  {
    id: 'outer-commits',
    proofs: '10',
    breaks:
      'the enclosing span is RELEASED instead of rolled back, so the seq-reuse hazard never arises',
    mustFail: [
      'SEQS WERE REUSED',
      'a replica told about seq',
      'the proof detects the POD-3260 class',
    ],
  },
  {
    id: 'chatty-gap',
    proofs: '9',
    breaks:
      "arm A's pause is widened past the server's idle budget, so the transaction that must commit is reaped",
    mustFail: ['20 s transaction, chatty — COMMITS', 'the budget bounds the GAP, not the duration'],
  },
  {
    id: 'idle-short',
    proofs: '9',
    breaks:
      "arm B's gap is shortened to inside the budget, so the transaction that must die survives",
    mustFail: ['12 s transaction, one gap — DIES', 'the budget bounds the GAP, not the duration'],
  },
  {
    id: 'watchdog-chatty',
    proofs: '11',
    breaks:
      "arm A's pause is widened past the watchdog's budget, so it speaks about a transaction the engine is happy with",
    mustFail: [
      'arm A: the watchdog stayed SILENT',
      'the watchdog follows the engine, not the clock',
    ],
  },
  {
    id: 'watchdog-quiet',
    proofs: '11',
    breaks:
      "arm B's gap is shortened to inside the budget, so the arm that must die survives and the watchdog has nothing to report",
    mustFail: [
      'arm B died',
      'arm B: the watchdog reported exactly once',
      'arm B: raised at the budget',
      'the watchdog follows the engine, not the clock',
    ],
  },
]

/**
 * INVARIANTS THAT COULD NOT BE DEFEATED, and exactly why.
 *
 * Listed rather than omitted, because the honest failure mode of a defeat list
 * is that it quietly covers the easy checks and leaves the rest looking
 * verified. Each entry here is a check that survives in `run-proofs.ts` and
 * whose wiring rests on an argument rather than on an observed red.
 */
const LIMITATIONS: readonly { readonly invariant: string; readonly why: string }[] = [
  {
    invariant: "PROOF 3 — 'returned seqs address the rows that client wrote'",
    why:
      "Defeating it requires `lastInsertRowid` to report the DATABASE's last insert rather than " +
      "this statement's — an engine or port-arithmetic change, not something an injection into " +
      'the proof can stage. Injecting a stray row (`seq-burned`) defeats the CONTIGUITY check ' +
      'beside it, but leaves each range still addressing its own rows. The remaining coverage is ' +
      "the mutation in `seqRangeFrom` recorded in this issue's handoff, applied to the port and " +
      'reverted.',
  },
  {
    invariant: "PROOF 7 — 'log is gap-free and every seq unique' (as an ENGINE property)",
    why:
      'Nothing available here can make libsql interleave two writers. `log-gap` deletes a row and ' +
      'shows the check reads the real table; it does not show the engine could produce the gap. ' +
      'The invariant is a watched negative, not a defeated one.',
  },
  {
    invariant:
      "PROOF 11 — the UPPER bound of 'arm B: raised at the budget, while alive' (idleMs < 11 s)",
    why:
      "Making the watchdog report LATE than its budget needs a budget at or above the driver's " +
      '9 s write budget, and `createScheduler` refuses exactly that configuration ("the engine ' +
      'would reap the stream before the watchdog could report it"). The bad setting is ' +
      'unreachable, so the bound cannot go red — which is a guard doing its job, not a vacuous ' +
      'check. The presence and LOWER bound of the report are defeated by `watchdog-quiet`.',
  },
]

/**
 * The negative control for the matrix itself.
 *
 * An id no site matches. It must exit 4 — proving that an injection which fails
 * to apply is REPORTED rather than passing as a green run. Without this entry
 * every row above could be silently unapplied and this file would call that
 * success.
 */
const UNAPPLIED_ID = 'no-such-site'

interface RunResult {
  readonly code: number
  readonly output: string
  readonly failedLabels: readonly string[]
}

async function runProofs(backend: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--conditions=@podium/source', RUN_PROOFS, backend], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('close', (code) => {
      const failedLabels = output
        .split('\n')
        .filter((l) => l.startsWith('  FAIL '))
        .map((l) => l.slice(7).trimEnd())
      resolve({ code: code ?? -1, output, failedLabels })
    })
  })
}

const backend = process.argv[2] ?? 'local'
if (backend !== 'local' && backend !== 'remote') {
  console.log('usage: defeat-check.ts [local|remote]')
  process.exit(2)
}

console.log(`${'='.repeat(72)}`)
console.log(`DEFEAT CHECK — can the ${backend} proof run say NO?  [POD-3357]`)
console.log(`${'='.repeat(72)}`)

/* ------------------------------------------------------------------ *
 * THE CONTROL. Every red below is only attributable if this is green. *
 * ------------------------------------------------------------------ */
console.log('\nCONTROL — the same proofs, no injection. Must be GREEN and exit 0.')
const controlProofs = [...new Set(MATRIX.flatMap((d) => d.proofs.split(',')))].sort().join(',')
const control = await runProofs(backend, { PODIUM_SPIKE_ONLY: controlProofs })
if (control.code === EXIT_SKIPPED) {
  console.log('  SKIPPED — the backend did not run (no credentials, or the hosted lease is held).')
  console.log('  Nothing below can be attempted. [POD-3358]')
  process.exit(EXIT_SKIPPED)
}
const controlGreen = control.code === EXIT_OK && control.failedLabels.length === 0
console.log(
  `  proofs ${controlProofs}: exit ${control.code}, ${control.failedLabels.length} failed invariant(s)`,
)
console.log(`  => control ${controlGreen ? 'GREEN' : 'RED'}`)
if (!controlGreen) for (const l of control.failedLabels) console.log(`       FAIL ${l}`)

/* --------------------------------------- *
 * THE NEGATIVE CONTROL for the matrix.    *
 * --------------------------------------- */
console.log('\nNEGATIVE CONTROL — an injection id no site matches. Must exit 4, not 0.')
const unapplied = await runProofs(backend, {
  PODIUM_SPIKE_ONLY: '2',
  PODIUM_SPIKE_BREAK: UNAPPLIED_ID,
})
const guardWorks = unapplied.code === EXIT_INJECTION_UNUSED
console.log(`  exit ${unapplied.code} (want ${EXIT_INJECTION_UNUSED})`)
console.log(
  guardWorks
    ? '  => an injection that does not apply is REPORTED, so no row below can be silently unapplied.'
    : '  => THE GUARD IS BROKEN. An unapplied injection would read as a green run, and every row below is worthless.',
)

/* ---------------- *
 * THE DEFEAT LIST. *
 * ---------------- */
const results: {
  defeat: Defeat
  defeated: boolean
  code: number
  missed: string[]
  failedLabels: readonly string[]
}[] = []
for (const defeat of MATRIX) {
  console.log(`\n${'-'.repeat(72)}`)
  console.log(`BREAK '${defeat.id}'  (proof ${defeat.proofs})`)
  console.log(`  injects: ${defeat.breaks}`)
  const run = await runProofs(backend, {
    PODIUM_SPIKE_ONLY: defeat.proofs,
    PODIUM_SPIKE_BREAK: defeat.id,
  })
  const missed = defeat.mustFail.filter(
    (want) => !run.failedLabels.some((got) => got.includes(want)),
  )
  const defeated = run.code === EXIT_FAILED && missed.length === 0
  console.log(
    `  exit ${run.code} (want ${EXIT_FAILED}), ${run.failedLabels.length} invariant(s) went red:`,
  )
  for (const l of run.failedLabels) console.log(`       ${l}`)
  if (run.code === EXIT_INJECTION_UNUSED)
    console.log('  !! THE INJECTION NEVER APPLIED — this row proves nothing.')
  for (const want of missed) console.log(`  !! expected to defeat "${want}" and did not`)
  if (defeat.caveat !== undefined) console.log(`  CAVEAT: ${defeat.caveat}`)
  console.log(`  => ${defeated ? 'DEFEATED — the check said no.' : 'NOT DEFEATED.'}`)
  results.push({ defeat, defeated, code: run.code, missed, failedLabels: run.failedLabels })
}

/* --------- *
 * VERDICT.  *
 * --------- */
console.log(`\n${'='.repeat(72)}`)
console.log(`DEFEAT LIST — ${backend}`)
console.log(`${'='.repeat(72)}`)
for (const r of results) {
  console.log(
    `  ${r.defeated ? 'DEFEATED    ' : 'NOT DEFEATED'}  ${r.defeat.id.padEnd(18)} proof ${r.defeat.proofs.padEnd(4)} ` +
      `${r.failedLabels.length} red, exit ${r.code}`,
  )
}
console.log(`\n${'-'.repeat(72)}`)
console.log('NOT DEFEATED BY INJECTION, and why — these rest on an argument, not a red:')
console.log(`${'-'.repeat(72)}`)
for (const limitation of LIMITATIONS) {
  console.log(`\n  ${limitation.invariant}`)
  console.log(`      ${limitation.why}`)
}

const allDefeated = results.every((r) => r.defeated)
console.log('')
console.log(`  control green .............................. ${controlGreen ? 'YES' : 'NO'}`)
console.log(`  unapplied-injection guard works ............ ${guardWorks ? 'YES' : 'NO'}`)
console.log(`  every injection defeated its invariants .... ${allDefeated ? 'YES' : 'NO'}`)
if (!controlGreen)
  console.log(
    '  => the control did not come back clean, so no red above is attributable to its injection.',
  )
if (!guardWorks)
  console.log(
    '  => an unapplied injection would have looked green, so the rows above are not trustworthy.',
  )
if (!allDefeated)
  console.log(
    '  => at least one check could not be made to fail. Treat it as vacuous until it can.',
  )
if (controlGreen && guardWorks && allDefeated)
  console.log('  => PASS: green when whole, red at the right invariant when broken.')

process.exit(controlGreen && guardWorks && allDefeated ? EXIT_OK : EXIT_FAILED)
