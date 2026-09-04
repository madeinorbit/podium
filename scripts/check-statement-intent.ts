/**
 * THE DECLARED-INTENT GATE (POD-3391, epic POD-3221, spec §6 rule 16).
 *
 * Run:
 *   bun run lint:statement-intent           # the gate — exit 1 on any FATAL finding
 *   bun run lint:statement-intent --probe   # prove the check can say YES, both ways
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHY IT IS NOT AN INFERENCE
 * ---------------------------------------------------------------------------
 *
 * `Statement.intent` is the one property of the executor a REPOSITORY chooses:
 * `get`/`all` declare `read`, `writeGet`/`writeAll` declare `write`. Everything
 * else — lanes, transactions, retries, the watchdog, the driver — is fixed in
 * `store/executor/` without a query moving. So a wrong intent is the only defect
 * class whose repair means revisiting every converted call site, and it is the
 * one worth a gate BEFORE the first conversion wave rather than after it.
 *
 * The gate compares the DECLARATION against EVIDENCE derived from the statement
 * text (`store/executor/intent-audit.ts`). It never decides an intent, and
 * nothing it computes reaches the executor: rule 16 bans SQL-text parsing as a
 * ROUTING mechanism, which POD-3247 deleted, and this is the opposite direction —
 * a declaration is what ships, and the text is only ever the witness against it.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS THE LANE, IT DOES NOT SCAN THE SOURCE — AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 *
 * A static scan can only see SQL that exists in the source, and after the flip
 * almost none of it does: a converted repository writes drizzle query builders,
 * and the text — the text POD-3321's defect is visible in, `INSERT … RETURNING`
 * arriving with method `all` — is generated at runtime inside drizzle. A scan
 * over call sites would therefore be permanently blind to the exact defect this
 * gate exists for, and would report a comfortable zero while doing it.
 *
 * So the gate drives the store's own test lane with an audit attached to the
 * statement-probe seam (`store/executor/statement-probe.ts`), which every lane's
 * every statement passes through, downstream of the driver's statement cache and
 * upstream of any engine, on bun:sqlite and libsql alike. A repository cannot
 * opt out of the seam, and the audit sees exactly the text the driver was asked
 * to run.
 *
 * ---------------------------------------------------------------------------
 * A RUN THAT CHECKED NOTHING MUST NOT READ AS A PASS
 * ---------------------------------------------------------------------------
 *
 * Today no repository is converted, so the corpus is the executor's own tests —
 * few hundred statements, and honestly reported as such. Every run prints how
 * many statements it EXAMINED, how many the text was evidence of a write for,
 * and how many it refused to grade. An examined count of zero FAILS: an absence
 * proved by an instrument that ran over nothing is the failure mode a gate like
 * this dies of, and the count is the only thing that separates the two.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ERRORS ARE GRADED, NOT COUNTED TOGETHER
 * ---------------------------------------------------------------------------
 *
 * FATAL is `write-declared-read` only. A write that declared `read` escapes the
 * single write slot, can run beside a real writer, and on a driver with
 * `openReader` is handed a READ-ONLY connection — silent and wrong.
 *
 * `read-declared-write` is printed and never fails. Rule 16 makes `write` the
 * DEFAULT for anything unmarked precisely because it is the safe direction: a
 * read on the write lane is slower and visible in the hot-path measurements, and
 * nothing else. A gate that failed on it would fail on the rule's own
 * recommended state, and the conversion waves would learn to silence it.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import {
  createBunSqliteDriver,
  IntentAudit,
  type IntentFinding,
  instrumentDriver,
  renderFinding,
  StatementProbeHub,
} from '../apps/server/src/store/executor'

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * The test files whose statements the gate audits.
 *
 * A DIRECTORY, not a file list, and deliberately: every conversion wave adds
 * repository tests under `apps/server/src/store/`, and a list would have to be
 * edited by each of them — which is the failure the shard manifest already
 * teaches (a file nobody added runs nowhere and still reports green). A
 * directory filter grows on its own; what it cannot cover is a repository with
 * no test, and `audit:store-census` is the check that watches for that.
 */
const CORPUS = 'apps/server/src/store/'

interface LaneReport {
  totals: { examined: number; derivedWrite: number; derivedRead: number; inconclusive: number }
  findings: IntentFinding[]
}

/** Run the corpus with the audit reporting, and sum every worker's line. */
function runCorpus(repoRoot: string): { report: LaneReport; workers: number } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pod-3391-gate-'))
  const reportPath = path.join(dir, 'intent-audit.jsonl')
  writeFileSync(reportPath, '')
  try {
    const result = spawnSync(
      'bun',
      [
        '--bun',
        'node_modules/vitest/vitest.mjs',
        'run',
        '--passWithNoTests',
        '--config',
        'vitest.unit.config.ts',
        '--project',
        'node',
        CORPUS,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: { ...process.env, PODIUM_STATEMENT_INTENT_REPORT: reportPath },
      },
    )
    if (result.status !== 0) {
      console.error(
        `\nTHE CORPUS DID NOT RUN CLEAN (vitest exit ${result.status}). The audit's count is` +
          ' incomplete, so this run proves nothing either way.',
      )
      process.exit(2)
    }
    const lines = readFileSync(reportPath, 'utf8').split('\n').filter(Boolean)
    const report: LaneReport = {
      totals: { examined: 0, derivedWrite: 0, derivedRead: 0, inconclusive: 0 },
      findings: [],
    }
    for (const line of lines) {
      const worker = JSON.parse(line) as LaneReport
      report.totals.examined += worker.totals.examined
      report.totals.derivedWrite += worker.totals.derivedWrite
      report.totals.derivedRead += worker.totals.derivedRead
      report.totals.inconclusive += worker.totals.inconclusive
      report.findings.push(...worker.findings)
    }
    return { report, workers: lines.length }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Every check can say YES — `--probe`
// ---------------------------------------------------------------------------

/**
 * Plant both disagreements and the honest case, through a REAL driver and the
 * real client, and report which of them the instrument failed to see.
 *
 * Through the client rather than a hand-built {@link Statement} on purpose: the
 * declaration under test is the one `queryClientOver` binds to the method a call
 * site chose, and a probe that constructed its own statement would be proving
 * the audit against a declaration no repository can produce.
 */
async function probe(): Promise<string[]> {
  const broken: string[] = []
  const dir = mkdtempSync(path.join(tmpdir(), 'pod-3391-probe-'))
  const raw = openDatabase(path.join(dir, 'probe.db'))
  raw.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  const hub = new StatementProbeHub()
  const audit = new IntentAudit()
  hub.attach(audit.probe, { wantsIssueSite: true })
  const driver = instrumentDriver(createBunSqliteDriver({ database: raw }), hub)
  const session = await driver.open('write')
  const client = driver.client(
    (statement) => session.execute(statement),
    (statements) => session.executeBatch(statements),
  )
  try {
    // 1. The dangerous direction: an INSERT declared `read`, because `all`
    //    declares `read` and drizzle prepares RETURNING writes with `all`.
    await client.all("INSERT INTO notes (body) VALUES ('planted-read-declared')")
    // 1b. The SAME defect in the shape POD-3321 actually found: drizzle prepares
    //     a RETURNING write with method `all`, so the leading keyword is not the
    //     only thing standing between this and the read lane.
    await client.all("INSERT INTO notes (body) VALUES ('planted-returning') RETURNING id")
    // 2. The safe direction: a plain SELECT declared `write`.
    await client.writeAll('SELECT * FROM notes')
    // 3. Honest traffic, which must stay quiet while still being counted.
    await client.run("INSERT INTO notes (body) VALUES ('honest')")
    await client.get('SELECT * FROM notes WHERE id = 1')
    await client.writeGet("INSERT INTO notes (body) VALUES ('honest') RETURNING id")
  } finally {
    await session.close()
    await driver.close()
    rmSync(dir, { recursive: true, force: true })
  }

  const fatal = audit.fatal
  if (fatal.length !== 2) {
    broken.push(
      `planted a read-declared INSERT and a read-declared RETURNING write, and the audit` +
        ` reported ${fatal.length} FATAL, not 2`,
    )
  }
  const mislabelled = fatal.filter((f) => f.declared !== 'read' || f.derived !== 'write')
  for (const finding of mislabelled) {
    broken.push(`a FATAL finding named declared=${finding.declared} derived=${finding.derived}`)
  }
  if (!fatal.some((f) => f.reason === 'RETURNING clause')) {
    broken.push('the RETURNING write was not caught by its RETURNING clause — the POD-3321 shape')
  }
  for (const finding of fatal) {
    if (finding.site === 'unattributed') {
      broken.push(`a FATAL finding named no call site: ${finding.sql}`)
    }
  }

  const over = audit.findings.filter((f) => f.disagreement === 'read-declared-write')
  if (over.length !== 1) {
    broken.push(`planted a write-declared SELECT and the audit reported ${over.length}, not 1`)
  } else if (over[0]?.fatal) {
    broken.push('an over-declared read was graded FATAL; rule 16 makes `write` the safe default')
  }

  if (audit.findings.length !== 3) {
    broken.push(
      `the three honest statements were not quiet: ${audit.findings.length} findings, expected 3`,
    )
  }
  if (audit.totals.examined !== 6) {
    broken.push(`the audit examined ${audit.totals.examined} of the 6 statements it was given`)
  }
  return broken
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const broken = await probe()
  if (broken.length > 0) {
    console.error('THE AUDIT IS BROKEN — its own probe failed:')
    for (const reason of broken) console.error(`  ${reason}`)
    process.exit(2)
  }
  if (process.argv.includes('--probe')) {
    console.log(
      'probe: a read-declared INSERT is FATAL with both values named, a write-declared SELECT is' +
        ' reported and not fatal, and honest traffic is quiet.',
    )
    return
  }

  const repoRoot = process.cwd()
  const { report, workers } = runCorpus(repoRoot)
  const { examined, derivedWrite, derivedRead, inconclusive } = report.totals
  const fatal = report.findings.filter((f) => f.fatal)
  const over = report.findings.filter((f) => !f.fatal)

  console.log('\n# Declared write intent vs the statement text (spec §6 rule 16)')
  console.log(`\nCorpus: ${CORPUS} under the unit lane, ${workers} worker process(es) reporting.`)
  console.log(`Statements examined: ${examined}`)
  console.log(`  text is evidence of a write: ${derivedWrite}`)
  console.log(`  text is evidence of a read:  ${derivedRead}`)
  console.log(`  not graded by text (PRAGMA/EXPLAIN/…): ${inconclusive}`)

  console.log(`\n## FATAL — a write declared as a read (${fatal.length})`)
  console.log(fatal.length ? fatal.map(renderFinding).join('\n') : '(none)')
  console.log(`\n## Reported, not fatal — a read declared as a write (${over.length})`)
  console.log(over.length ? over.map(renderFinding).join('\n') : '(none)')

  if (examined === 0) {
    console.error(
      '\nTHE GATE EXAMINED NOTHING. An absence proved by an instrument that ran over no' +
        ' statements is not a pass; the corpus or the report sink is broken.',
    )
    process.exit(1)
  }
  process.exit(fatal.length === 0 ? 0 : 1)
}

if (import.meta.main) await main()
