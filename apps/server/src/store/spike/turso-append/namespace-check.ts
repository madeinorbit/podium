/**
 * THE PROOF THAT THE NAMESPACE HOLDS — and that its absence is detectable
 * [POD-3358].
 *
 *   bun --conditions=@podium/source apps/server/src/store/spike/turso-append/namespace-check.ts [local|remote|both]
 *
 * WHY THIS EXISTS RATHER THAN A PARAGRAPH IN A COMMIT MESSAGE. The fix is a
 * table prefix threaded through nine files. A change of that shape is either
 * complete or silently useless, and nothing about reading it tells you which:
 * every existing proof still passes when run ALONE, because running alone is
 * exactly the case the defect does not appear in. So the check runs two full
 * runs AT THE SAME TIME against ONE database and asks the only question that
 * distinguishes the two worlds — did either run see a row it did not write.
 *
 * IT RUNS BOTH ARMS, and the control is the point. A concurrency test that only
 * shows the new arrangement passing is an untested rearrangement: it cannot tell
 * a working namespace from a test too weak to notice a broken one. So the same
 * script, the same statements and the same two-process schedule are run a second
 * time with `PODIUM_SPIKE_TABLE_PREFIX` forced empty, which restores the
 * pre-fix table names exactly (`changes`, `change_latest`, `locks`,
 * `feed_identity`). The two arms differ by ONE environment variable and nothing
 * else — not a build, not a branch, not a code path. The run is only evidence if
 * the control arm FAILS.
 *
 * WHAT EACH WORKER ASSERTS, in the order the failures matter:
 *   1. every row in the log carries this run's tag — the isolation property;
 *   2. the seqs it was handed are contiguous from 1 — the property POD-3292's
 *      review saw come back FALSE-but-plausible under concurrency;
 *   3. `sqlite_sequence` agrees with the number of rows it wrote.
 * Workers interleave deliberately (several rounds with a pause between) so that
 * two runs overlap for most of their length rather than by luck.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startLocalServer } from './backend'
import { type BackendConfig, localBackend, normalizeTursoUrl, remoteBackend } from './client'
import { openSlice } from './fixture'
import { PREFIX_ENV } from './namespace'
import { appendChangesLiteral, changesSince, maxChangeSeq } from './sync-append'

/** Rounds, rows per round, and the pause between them — tuned to overlap. */
const ROUNDS = 5
const ROWS_PER_ROUND = 20
const PAUSE_MS = 400

class CheckFailure extends Error {}

/**
 * One run: append in rounds, and after every round demand that the log contains
 * this run's rows and ONLY this run's rows.
 *
 * The tag is what makes the isolation question answerable rather than
 * statistical. Every row this run writes is `<tag>-<n>`, so a foreign row is not
 * a count that looks wrong, it is a row that names somebody else — which is a
 * failure you can print.
 */
async function worker(config: BackendConfig): Promise<void> {
  const tag = randomBytes(4).toString('hex')
  const slice = await openSlice(config)
  console.log(`worker ${tag}: prefix=${slice.prefix || '(none — shared tables)'}`)
  try {
    let written = 0
    for (let round = 0; round < ROUNDS; round++) {
      const rows = Array.from({ length: ROWS_PER_ROUND }, (_, i) => ({
        entity: 'issue',
        entityId: `${tag}-${written + i}`,
        op: 'upsert' as const,
        payload: JSON.stringify({ round }),
      }))
      const seqs = await slice.withSession((s) =>
        appendChangesLiteral(s, slice.db, slice.tables, rows, 1_000 + round),
      )

      // (2) The contiguity claim, checked against where this run's log actually
      // starts. This is the assertion that came back true-but-meaningless when a
      // neighbour had just emptied the table.
      const expectedFirst = written + 1
      if (seqs[0] !== expectedFirst || !seqs.every((seq, i) => seq === expectedFirst + i)) {
        throw new CheckFailure(
          `round ${round}: expected seqs ${expectedFirst}..${expectedFirst + rows.length - 1}, ` +
            `got ${seqs[0]}..${seqs[seqs.length - 1]}`,
        )
      }
      written += rows.length

      // (1) The isolation claim. Any row that is not ours means another run is
      // writing into our tables, which is the whole defect.
      const all = await slice.withSession((s) => changesSince(s, slice.db, slice.tables, 0))
      const foreign = all.find((row) => !row.entityId.startsWith(`${tag}-`))
      if (foreign !== undefined) {
        throw new CheckFailure(
          `round ${round}: found a row this run did not write — ` +
            `seq ${foreign.seq} entity_id ${foreign.entityId} (this run is ${tag})`,
        )
      }
      if (all.length !== written) {
        throw new CheckFailure(
          `round ${round}: wrote ${written} rows but the log holds ${all.length} — ` +
            'rows were deleted underneath this run',
        )
      }

      // (3) The high-water mark the feed's cursor arithmetic depends on.
      const head = await slice.withSession((s) => maxChangeSeq(s, slice.tables))
      if (head !== written) {
        throw new CheckFailure(`round ${round}: sqlite_sequence head ${head}, expected ${written}`)
      }

      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
    }
    console.log(`worker ${tag}: OK — ${written} rows, contiguous 1..${written}, no foreign rows`)
  } finally {
    // Collect the namespace. A check that proves runs are isolated by giving
    // each one its own tables must not leave those tables behind, or the
    // evidence run is itself the thing that fills the shared database.
    await slice.dropTables().catch(() => {})
    await slice.close()
  }
}

/** Run two workers at once over one database and report what each one did. */
async function bothAtOnce(
  label: string,
  config: BackendConfig,
  env: Record<string, string>,
): Promise<{ green: number; red: number }> {
  console.log(`\n${'-'.repeat(72)}\n${label}\n${'-'.repeat(72)}`)
  const self = fileURLToPath(import.meta.url)
  const run = (n: number): Promise<{ code: number; output: string }> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['--conditions=@podium/source', self, '--worker', config.url],
        {
          env: {
            ...process.env,
            ...env,
            ...(config.authToken === undefined ? {} : { SPIKE_AUTH_TOKEN: config.authToken }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += String(chunk)
      })
      child.on('close', (code) => resolve({ code: code ?? -1, output: `run ${n}: ${output}` }))
    })

  const results = await Promise.all([run(1), run(2)])
  let green = 0
  let red = 0
  for (const result of results) {
    if (result.code === 0) green += 1
    else red += 1
    process.stdout.write(result.output.trimEnd().replace(/^/gm, '  ') + '\n')
  }
  console.log(`  => ${green} run(s) green, ${red} red`)
  return { green, red }
}

/**
 * Both arms against one backend, and the verdict.
 *
 * The verdict is deliberately conjunctive: the namespaced arm must be all-green
 * AND the shared arm must produce at least one red. A run where both arms are
 * green has not proven the fix — it has proven the check cannot see the bug, and
 * it says so rather than reporting success.
 */
async function checkBackend(name: string, config: BackendConfig): Promise<boolean> {
  console.log(`\n${'='.repeat(72)}\nBACKEND: ${name}  (${normalizeTursoUrl(config.url)})\n${'='.repeat(72)}`)

  const fixed = await bothAtOnce('FIXED — a per-run table prefix (this is the change)', config, {})
  const control = await bothAtOnce(
    `CONTROL — ${PREFIX_ENV}='' restores the pre-fix shared table names`,
    config,
    { [PREFIX_ENV]: '' },
  )

  const isolated = fixed.red === 0
  const controlBroke = control.red > 0
  console.log(`\nVERDICT for ${name}:`)
  console.log(`  namespaced: both runs green ................. ${isolated ? 'YES' : 'NO'}`)
  console.log(`  shared (control): a run failed .............. ${controlBroke ? 'YES' : 'NO'}`)
  if (!isolated) console.log('  => the namespace does NOT isolate concurrent runs.')
  if (!controlBroke)
    console.log('  => the control did not reproduce the defect, so this run proves nothing.')
  if (isolated && controlBroke) console.log('  => PASS: isolated when namespaced, corrupted when not.')
  return isolated && controlBroke
}

if (process.argv[2] === '--worker') {
  const url = process.argv[3]
  if (url === undefined) throw new Error('--worker needs a url')
  const token = process.env.SPIKE_AUTH_TOKEN
  try {
    await worker({ url, ...(token === undefined ? {} : { authToken: token }) })
    process.exit(0)
  } catch (error) {
    console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

const which = process.argv[2] ?? 'both'
let allPassed = true

if (which === 'local' || which === 'both') {
  // One server, two runs — the local mirror of the hosted situation. The
  // proof's own local backend makes a fresh directory per server, so a shared
  // local database has to be arranged on purpose.
  const server = await startLocalServer()
  try {
    process.env.TURSO_DEV_URL = server.config.url
    allPassed = (await checkBackend('local sqld, one shared database', localBackend())) && allPassed
  } finally {
    await server.dispose()
  }
}

if (which === 'remote' || which === 'both') {
  const config = remoteBackend()
  if (config === undefined) {
    console.log('\nremote SKIPPED: TURSO_SPIKE_URL / TURSO_SPIKE_TOKEN are not set')
  } else {
    allPassed = (await checkBackend('hosted Turso (spike database)', config)) && allPassed
  }
}

process.exit(allPassed ? 0 : 1)
