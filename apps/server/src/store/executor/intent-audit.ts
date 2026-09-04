/**
 * THE DECLARED-INTENT AUDIT [POD-3391, spec §6 rule 16].
 *
 * ---------------------------------------------------------------------------
 * THE ONE DEFECT CLASS THAT WOULD MEAN REVISITING EVERY CONVERTED QUERY
 * ---------------------------------------------------------------------------
 *
 * Everything else about the executor is invisible to a repository. Lanes,
 * transactions, retries, the watchdog, the driver — a defect in any of them is
 * fixed in `store/executor/` and no query moves. {@link Statement.intent} is the
 * exception, because it is a CALL-SITE choice: `get`/`all` declare `read`,
 * `writeGet`/`writeAll` declare `write` (`queryClientOver` in `driver.ts`), and
 * a repository picks one when it is converted. So a wrong intent RULE is the one
 * defect that reaches back into every wave that already shipped.
 *
 * POD-3321 found one instance before a single repository had been converted:
 * drizzle prepares every `INSERT`/`UPDATE`/`DELETE` carrying a `RETURNING`
 * clause with method `all`, and a client that read the method as intent declared
 * those writes as reads — past the single write slot, beside a real writer, and
 * on a driver with `openReader` onto a READ-ONLY connection. The next one might
 * not be caught for free.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A CHECK, NOT AN INFERENCE — AND THE DISTINCTION IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * Rule 16 BANS deriving intent from SQL text, and POD-3247 deleted exactly that
 * mechanism. Nothing here decides an intent. {@link deriveWriteEvidence} produces
 * EVIDENCE that is compared against a declaration somebody typed, and the
 * comparison's only output is a finding. No caller of this module may route,
 * choose a lane, or alter a statement by what it returns; the executor never
 * imports it, and the audit runs as a {@link StatementProbe}, which by
 * construction cannot influence the statement it observes.
 *
 * That is also why {@link WriteEvidence} has a THIRD verdict. Rule 16's argument
 * against text parsing is that `PRAGMA`, `EXPLAIN`, CTEs and `sql.raw` make it
 * wrong in ways nothing would catch — and a parser forced to answer read-or-write
 * for those is wrong SILENTLY. `inconclusive` is this module conceding the same
 * point: those statements are counted and named, and never produce a finding in
 * either direction. An audit that says "I cannot tell" about 4 of 700 statements
 * is worth more than one that guesses about all 700.
 *
 * ---------------------------------------------------------------------------
 * THE TWO ERRORS ARE NOT SYMMETRIC
 * ---------------------------------------------------------------------------
 *
 * Rule 16 is explicit that the asymmetry is the argument, and this audit grades
 * by it rather than reporting "mismatch" twice:
 *
 *   FATAL — {@link IntentFinding} `write-declared-read`. The statement mutates
 *     and the call site declared `read`. Silent, and a correctness defect: it
 *     escapes the write slot and can be handed a read-only connection.
 *
 *   REPORTED, NEVER FATAL — `read-declared-write`. A plain `SELECT` declared
 *     `write` takes the write slot: slower, visible in the hot-path
 *     measurements, harmless to correctness. Rule 16 makes `write` THE DEFAULT
 *     for anything unmarked, so failing a gate on over-declaration would fail
 *     the gate on the rule's own recommended state. It is reported because a
 *     read on the write lane is a real cost on the remote driver and is exactly
 *     what a conversion wave should be told about — not because it is wrong.
 */

import type { Statement, StatementIntent } from './driver'
import type { StatementObservation, StatementProbe } from './statement-probe'

/**
 * What the statement text is evidence OF.
 *
 * `inconclusive` is a first-class answer, not a failure. See the header: it is
 * the concession rule 16's ban is built on, and it is never a finding.
 */
export type WriteEvidence = 'write' | 'read' | 'inconclusive'

export interface EvidenceVerdict {
  readonly evidence: WriteEvidence
  /** Why, in the words the report prints. Always populated. */
  readonly reason: string
}

/**
 * How the declaration and the evidence disagreed.
 *
 * `write-declared-read` is the dangerous direction and the only fatal one; see
 * the header for why they are graded rather than counted together.
 */
export type IntentDisagreement = 'write-declared-read' | 'read-declared-write'

export interface IntentFinding {
  readonly disagreement: IntentDisagreement
  /** True only for `write-declared-read`. The gate fails on this and nothing else. */
  readonly fatal: boolean
  /** What the call site said. */
  readonly declared: StatementIntent
  /** What the statement text is evidence of. */
  readonly derived: WriteEvidence
  readonly reason: string
  readonly sql: string
  /**
   * `file:line` of the nearest frame outside `store/executor/`.
   *
   * It comes from {@link StatementObservation.issueStack}, captured at the
   * driver's door BEFORE the call was awaited — after the await the caller's
   * frames are gone and an audit that built its own stack would attribute every
   * finding to the executor. A statement whose issuer really is inside
   * `store/executor/`, or one graded outside a seam that captures, reports
   * `unattributed`; the SQL text is the identity that is ALWAYS present, which
   * is why it is a separate field.
   */
  readonly site: string
}

/** Every statement the audit saw, graded. */
export interface IntentAuditTotals {
  readonly examined: number
  readonly derivedWrite: number
  readonly derivedRead: number
  readonly inconclusive: number
}

const WRITE_HEADS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

/**
 * DDL mutates too, and a `CREATE TABLE` issued through `get` is the same defect
 * wearing different clothes. Listed rather than pattern-matched so that adding
 * one is a decision somebody made.
 */
const DDL_HEADS = new Set(['CREATE', 'DROP', 'ALTER', 'REINDEX', 'VACUUM'])

/**
 * Heads this module refuses to grade. See {@link WriteEvidence}.
 *
 * `PRAGMA` is a read (`PRAGMA user_version`) or a write (`PRAGMA journal_mode =
 * WAL`) depending on whether an `=` follows, and getting that wrong in the
 * fatal direction would fail a gate on a correct call site. `EXPLAIN INSERT …`
 * runs no insert at all, so the leading-keyword rule inverts on it. `ANALYZE`
 * writes statistics tables but is issued by maintenance that declares its own
 * lane. Each is counted and named; none is a finding.
 */
const UNGRADABLE_HEADS = new Set(['PRAGMA', 'EXPLAIN', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK'])

/**
 * Remove everything a keyword could hide inside.
 *
 * `SELECT 'DELETE FROM users'` is a read, and `SELECT note FROM t WHERE note =
 * 'x RETURNING y'` is a read. Without this the audit reports both as fatal
 * writes — a false fatal, which is the failure mode that gets a gate switched
 * off. Comments go for the same reason: a RETURNING inside a block comment is
 * not a clause.
 */
function stripQuotedAndComments(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      out += ' '
      continue
    }
    // Single quotes are string literals; the rest are identifier quotings. All
    // four hide keywords, and SQLite doubles the delimiter to escape it.
    const closer =
      char === "'" ? "'" : char === '"' ? '"' : char === '`' ? '`' : char === '[' ? ']' : undefined
    if (closer !== undefined) {
      index += 1
      while (index < sql.length) {
        if (sql[index] === closer) {
          if (sql[index + 1] === closer && closer !== ']') {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      out += ' '
      continue
    }
    out += char
    index += 1
  }
  return out
}

const LEADING_KEYWORD = /^[\s(;]*([A-Za-z_]+)/
const DML_ANYWHERE = /\b(INSERT\s+INTO|INSERT\s+OR\b|UPDATE\s|DELETE\s+FROM|REPLACE\s+INTO)/i
const RETURNING_CLAUSE = /\bRETURNING\b/i

/**
 * What the statement TEXT is evidence of. Never called to decide a route.
 *
 * The order matters. `RETURNING` is checked before the leading keyword because
 * it is the case that produced POD-3321's defect and the one a reader will
 * look for; a `WITH`-prefixed statement is searched for DML because SQLite
 * allows `WITH … DELETE FROM …`, where the leading keyword says nothing.
 */
export function deriveWriteEvidence(sql: string): EvidenceVerdict {
  const bare = stripQuotedAndComments(sql)
  const head = LEADING_KEYWORD.exec(bare)?.[1]?.toUpperCase()
  if (head === undefined) return { evidence: 'inconclusive', reason: 'no leading keyword' }
  if (UNGRADABLE_HEADS.has(head)) {
    return { evidence: 'inconclusive', reason: `${head} is not graded by text (rule 16)` }
  }
  if (RETURNING_CLAUSE.test(bare)) {
    return { evidence: 'write', reason: 'RETURNING clause' }
  }
  if (WRITE_HEADS.has(head)) return { evidence: 'write', reason: `leading ${head}` }
  if (DDL_HEADS.has(head)) return { evidence: 'write', reason: `leading ${head} (DDL)` }
  if (head === 'WITH' && DML_ANYWHERE.test(bare)) {
    return { evidence: 'write', reason: 'DML under a WITH prefix' }
  }
  return { evidence: 'read', reason: `leading ${head}` }
}

/**
 * Compare one statement's declaration against its evidence.
 *
 * Returns `undefined` when they agree AND when the evidence is inconclusive —
 * the two cases that are not findings.
 */
export function auditStatement(
  statement: Pick<Statement, 'sql' | 'intent'>,
  site = 'unattributed',
): IntentFinding | undefined {
  const { evidence, reason } = deriveWriteEvidence(statement.sql)
  if (evidence === 'inconclusive') return undefined
  const declared = statement.intent
  if (evidence === 'write' && declared === 'read') {
    return {
      disagreement: 'write-declared-read',
      fatal: true,
      declared,
      derived: evidence,
      reason,
      sql: statement.sql,
      site,
    }
  }
  if (evidence === 'read' && declared === 'write') {
    return {
      disagreement: 'read-declared-write',
      fatal: false,
      declared,
      derived: evidence,
      reason,
      sql: statement.sql,
      site,
    }
  }
  return undefined
}

/**
 * The executor's own modules are the observer, never the call site.
 *
 * TEST FILES IN THE SAME DIRECTORY ARE NOT EXCLUDED, and the distinction is not
 * cosmetic: today the entire corpus is `store/executor/*.test.ts`, so a filter
 * that skipped the directory would attribute every finding it can currently
 * make to `unattributed` — an audit that names no site is one nobody can act on.
 * The scaffolding (`harness.ts`) has no `.test.ts` suffix and stays skipped,
 * which is right: it issues no statement of its own.
 */
const OBSERVER_FRAME = /store[/\\]executor[/\\][^/\\]*$/
const TEST_FRAME = /\.test\.tsx?$/

/**
 * `file:line` of the nearest frame that is not this observer.
 *
 * Only ever called once a finding exists, so the cost of building a stack is
 * paid per DEFECT rather than per statement — which is what lets the audit run
 * with a lane's full traffic through it.
 */
export function callSite(stack: string | undefined): string {
  if (!stack) return 'unattributed'
  for (const line of stack.split('\n').slice(1)) {
    const at = /\(?([^()\s]+\.(?:ts|tsx|js|mjs)):(\d+):\d+\)?$/.exec(line.trim())
    if (!at) continue
    const [, file, lineNumber] = at
    if (file === undefined || file.includes('node_modules')) continue
    if (OBSERVER_FRAME.test(file) && !TEST_FRAME.test(file)) continue
    // Repo-relative: the report is read next to a diff, and an absolute path
    // carries the worktree it happened to run in, which no reader needs.
    const root = `${process.cwd()}/`
    return `${file.startsWith(root) ? file.slice(root.length) : file}:${lineNumber}`
  }
  return 'unattributed'
}

/**
 * The audit as a collector: totals, findings, and the probe that feeds them.
 *
 * IT IS A PROBE AND THAT IS THE MECHANISM ARGUMENT. The seam already routes
 * every statement any lane runs through one place (`statement-probe.ts`),
 * downstream of the driver's statement cache and upstream of any engine, on
 * bun:sqlite and on libsql alike. A repository cannot opt out of it, and — the
 * part a static scan cannot match — it sees the SQL DRIZZLE GENERATED, which is
 * the only text in which POD-3321's `RETURNING` defect is visible at all.
 */
export class IntentAudit {
  private examined = 0
  private derivedWrite = 0
  private derivedRead = 0
  private inconclusiveCount = 0
  private readonly found: IntentFinding[] = []

  /**
   * Attach this to a {@link StatementProbeHub} — WITH `wantsIssueSite`, or every
   * finding reports `unattributed`:
   *
   *     hub.attach(audit.probe, { wantsIssueSite: true })
   */
  readonly probe: StatementProbe = (observation) => this.observe(observation)

  /**
   * Grade one statement. Takes the observation shape so the probe is a
   * one-liner, and `undeclared` — the legacy raw-handle seam, which has no
   * call site to have declared anything — is counted and skipped rather than
   * graded against a declaration nobody made.
   */
  observe(
    observation: Pick<StatementObservation, 'sql' | 'intent'> & { issueStack?: string },
  ): void {
    if (observation.intent === 'undeclared') return
    this.examined += 1
    const { evidence } = deriveWriteEvidence(observation.sql)
    if (evidence === 'write') this.derivedWrite += 1
    else if (evidence === 'read') this.derivedRead += 1
    else this.inconclusiveCount += 1
    const finding = auditStatement(
      { sql: observation.sql, intent: observation.intent },
      // Resolved HERE rather than in `auditStatement`, so the pure comparison
      // stays testable without a stack.
      evidence === 'inconclusive' ? 'unattributed' : callSite(observation.issueStack),
    )
    if (finding) this.found.push(finding)
  }

  get totals(): IntentAuditTotals {
    return {
      examined: this.examined,
      derivedWrite: this.derivedWrite,
      derivedRead: this.derivedRead,
      inconclusive: this.inconclusiveCount,
    }
  }

  get findings(): readonly IntentFinding[] {
    return this.found
  }

  /** Only `write-declared-read`. What a gate fails on. */
  get fatal(): readonly IntentFinding[] {
    return this.found.filter((f) => f.fatal)
  }
}

/** One line per finding, in the form the gate prints. */
export function renderFinding(finding: IntentFinding): string {
  const grade = finding.fatal ? 'FATAL' : 'over-declared'
  return `${finding.site}  ${grade}  declared=${finding.declared} derived=${finding.derived} (${finding.reason})\n    ${collapse(finding.sql)}`
}

function collapse(sql: string): string {
  const folded = sql.replace(/\s+/g, ' ').trim()
  return folded.length > 160 ? `${folded.slice(0, 157)}...` : folded
}
