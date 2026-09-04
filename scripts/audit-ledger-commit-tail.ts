/**
 * THE LEDGER-COMMIT TAIL AUDIT (POD-3366; POD-3328, POD-3361; spec §3.3).
 *
 * Run:
 *   bun run audit:ledger-tail           # the gate — exit 1 on any finding
 *   bun run audit:ledger-tail --json
 *   bun run audit:ledger-tail --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS EXISTS TO STOP, STATED ONCE
 * ---------------------------------------------------------------------------
 *
 * `Ledger.commit` runs its body inside `store.transact`. When the caller already
 * has a span open that `transact` is a SAVEPOINT, and releasing a savepoint is
 * not a commit — the enclosing span can still roll back and take the rows with
 * it. So the statement AFTER `commit()` returns is on the success path of
 * something that has not necessarily succeeded, and an install placed there
 * records a fact the database may throw away.
 *
 * Thirteen of twenty-two call sites did exactly that. POD-3328 and POD-3361
 * fixed one each by hand; POD-3366 moved the remaining eleven and gave the op
 * an `apply` arm plus a shared `StagedProjection` so the right version is the
 * available one.
 *
 * NONE OF THAT STOPS THE FOURTEENTH SITE, which is why this file exists. The
 * epic's first principle is that completeness comes from the compiler and a
 * lint, never from memory, and "install after the commit returns" is not a
 * shape a type can forbid in general. So:
 *
 *   §1  THE ROSTER IS PINNED. Every `.commit({` call site in the server and the
 *       sync package is counted per file against a roster that records what each
 *       file's sites do and why. A NEW site — or a moved one — changes a count
 *       and fails this audit until somebody classifies it. It is a ratchet, not
 *       a rule of thumb: nothing here decides whether a site is correct, it
 *       decides that a human looked.
 *
 *   §2  THE ISSUE ROW MAP STAYS READ-ONLY. `IssueStore.rows` is a
 *       `ReadonlyMap`, which is what turned "do not install into the map after a
 *       commit" from a rule into a compile error — and it is the reason tsgo,
 *       not a checklist, found audit sites 6 and 7. Widening it back would
 *       silently restore the wrong shape at every one of its readers, and no
 *       test would fail. So the declaration is pinned here.
 *
 *   §3  THE OP HAS ONE SPELLING. Seven narrow ledger ports in apps/server used
 *       to restate `{ write, changes }` by hand, so adding the `apply` arm to
 *       the facade left every one of them unable to express it. They now compose
 *       from `LedgerCommitOp`. A port that hand-restates the op again would
 *       silently be unable to carry the NEXT arm, so a re-declaration is a
 *       finding.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Two of the three checks below are ABSENCE claims, and an absence is exactly
 * what a broken instrument reports. `--probe` runs each check against a planted
 * fixture containing the thing it hunts and fails if the check does not find it,
 * then against a clean fixture and fails if it fires anyway. Both halves: a
 * check that fires on everything is as useless as one that fires on nothing. The
 * probe runs FIRST, always, even without the flag.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Finding {
  /** Which obligation failed — the acceptance criterion, in one token. */
  check: string
  /** Where, as `file` or `file:line`. */
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

// ---------------------------------------------------------------------------
// 1 — the call-site roster is pinned
// ---------------------------------------------------------------------------

interface RosterEntry {
  /** How many `.commit({` sites this file holds. */
  readonly sites: number
  /** What those sites do about their post-commit work, and why it is right. */
  readonly disposition: string
}

/**
 * THE ROSTER, as POD-3361's audit left it and POD-3366 moved it.
 *
 * `sites` is a COUNT and not a line list on purpose: line numbers churn with
 * every edit above them and a roster nobody can keep green is a roster people
 * delete. A count changes only when a call site is added, removed or moved
 * between files — which is exactly when somebody should be made to think.
 */
const COMMIT_SITE_ROSTER: ReadonlyMap<string, RosterEntry> = new Map([
  [
    'apps/server/src/modules/automations/service.ts',
    {
      sites: 6,
      disposition:
        'UNAFFECTED. All six read and write the database and return a value; no process-owned ' +
        'map is touched on the success path, so there is no install to defer [POD-3361 audit].',
    },
  ],
  [
    'apps/server/src/modules/funnel.ts',
    {
      sites: 1,
      disposition:
        'THE MECHANISM, not a site: `WriteFunnel.run` opens the span the others nest inside.',
    },
  ],
  [
    'apps/server/src/modules/issue-session-lifecycle.ts',
    {
      sites: 2,
      disposition:
        'MOVED [POD-3366 Group D, audit sites 6 and 7]. The runtime plans run in the `apply` arm; ' +
        'the broadcasts are mechanism 3 through `afterCommit`.',
    },
  ],
  [
    'apps/server/src/modules/issues/authority-arbitration.ts',
    {
      sites: 1,
      disposition:
        'UNAFFECTED. A pass-through wrapper that adds an `arbitrate` clause and installs nothing. ' +
        'It composes from `LedgerCommitOp`, so it carries a caller’s `apply` arm through.',
    },
  ],
  [
    'apps/server/src/modules/issues/service/core.ts',
    {
      sites: 2,
      disposition:
        'MOVED [POD-3366 Group C, audit sites 3 and 4]. `installDraft` goes through the staged ' +
        '`installRow`; the event announcement goes through `afterCommit`.',
    },
  ],
  [
    'apps/server/src/modules/issues/service/crud.ts',
    {
      sites: 1,
      disposition:
        'MOVED [POD-3366 Group E, audit site 5]. The whole-map `reload()` became a staged targeted ' +
        'removal plus the in-memory cascade; `reconcileAndPublish` stays in the span because it ' +
        'appends change rows durably.',
    },
  ],
  [
    'apps/server/src/modules/memory/service.ts',
    {
      sites: 2,
      disposition:
        'MOVED [POD-3366 Group A, audit sites 9 and 10]. The conversation list is a ' +
        '`StagedProjection` — the arm alone would break `setConversationMeta`’s own ' +
        'precondition read.',
    },
  ],
  [
    'apps/server/src/modules/sessions/repository.ts',
    {
      sites: 1,
      disposition:
        'MOVED [POD-3361, audit sites 1, 2 and 13]. `capturedSessionStates` gains a staged layer ' +
        'promoted by a commit application.',
    },
  ],
  [
    'apps/server/src/modules/sessions/session-kill.ts',
    {
      sites: 1,
      disposition:
        'MOVED [POD-3366 Group D, audit site 8]. The irreversible runtime teardown runs in the ' +
        '`apply` arm; the broadcast and the death notification are mechanism 3.',
    },
  ],
  [
    'apps/server/src/modules/shipping/service.ts',
    {
      sites: 6,
      disposition:
        'TWO MOVED, FOUR UNAFFECTED [POD-3366 Group B, audit sites 11 and 12]. The two claims ' +
        'install through `LeaseProjection`, which is staged. The other four only call `audit()`, ' +
        'which appends an events ROW — a durable write that rolls back with the transaction.',
    },
  ],
  [
    'packages/sync/src/ledger.ts',
    {
      sites: 1,
      disposition: 'THE FACADE ITSELF: `Ledger.commit` delegating to `Authority.commit`.',
    },
  ],
])

const SCANNED_DIRS = ['apps/server/src', 'packages/sync/src'] as const

/** Every non-test `.ts` under the scanned trees, as repo-relative paths. */
function sourceFiles(dirs: readonly string[] = SCANNED_DIRS): string[] {
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      const child = join(abs, entry)
      if (statSync(child).isDirectory()) {
        if (entry === 'node_modules') continue
        walk(child)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (entry.includes('.test.')) continue
      out.push(relative(ROOT, child))
    }
  }
  for (const dir of dirs) walk(join(ROOT, dir))
  return out.sort()
}

/** How many `.commit({` call sites a source text holds. */
export function commitSiteCount(source: string): number {
  return source.split('.commit({').length - 1
}

export function rosterFindings(sources: ReadonlyMap<string, string>): Finding[] {
  const findings: Finding[] = []
  const seen = new Set<string>()
  for (const [file, source] of sources) {
    const count = commitSiteCount(source)
    if (count === 0) continue
    seen.add(file)
    const entry = COMMIT_SITE_ROSTER.get(file)
    if (!entry) {
      findings.push({
        check: 'commit-site-roster',
        where: file,
        detail:
          `${count} unclassified \`.commit({\` call site(s). A ledger commit's post-commit work ` +
          'runs on the success path of a possibly-nested commit, and a released savepoint is not ' +
          'a commit. Decide what this site installs and where it belongs — the `apply` arm, a ' +
          '`StagedProjection`, or nothing — then add it to COMMIT_SITE_ROSTER in this file with ' +
          'the reason (POD-3366).',
      })
      continue
    }
    if (entry.sites !== count) {
      findings.push({
        check: 'commit-site-roster',
        where: file,
        detail:
          `the roster records ${entry.sites} \`.commit({\` site(s); the file now has ${count}. ` +
          'Classify the change and update the roster entry (POD-3366).',
      })
    }
  }
  for (const file of COMMIT_SITE_ROSTER.keys()) {
    if (seen.has(file)) continue
    findings.push({
      check: 'commit-site-roster',
      where: file,
      detail:
        'the roster records commit sites here and the file has none. Delete the stale entry so ' +
        'the roster keeps describing this checkout (POD-3366).',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the issue row map stays read-only
// ---------------------------------------------------------------------------

const ROW_GETTER = /get rows\(\)\s*:\s*ReadonlyMap<string, IssueRow>/

export function rowMapReadOnly(source: string, file: string): Finding[] {
  if (!source.includes('get rows()')) return []
  if (ROW_GETTER.test(source)) return []
  const index = source.indexOf('get rows()')
  return [
    {
      check: 'issue-rows-readonly',
      where: `${file}:${lineOf(source, index)}`,
      detail:
        "`IssueStore.rows` must stay a `ReadonlyMap<string, IssueRow>`. That is what makes " +
        '"do not install into the map after a commit" a COMPILE error rather than a rule — it is ' +
        'how tsgo found the two lifecycle sites POD-3366 had not reached yet. Widening it back ' +
        'restores the wrong shape at every reader with no test failing. Install through ' +
        '`installRow`, which stages and waits for the outermost commit (POD-3366).',
    },
  ]
}

// ---------------------------------------------------------------------------
// 3 — the op has one spelling
// ---------------------------------------------------------------------------

/** A hand-restated `commit` op: `commit<T>(op: { write: …` rather than `LedgerCommitOp`. */
const RESTATED_OP = /commit<[A-Za-z]+>\(\s*\w+\s*:\s*\{\s*write\s*:/g

export function restatedCommitOp(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(RESTATED_OP)) {
    findings.push({
      check: 'one-commit-op',
      where: `${file}:${lineOf(source, match.index)}`,
      detail:
        'this port hand-restates `Ledger.commit`’s op instead of composing from ' +
        '`LedgerCommitOp<T>`. Seven ports did that before POD-3366, and adding the `apply` arm ' +
        'left every one of them unable to express it — the first converted site failed with ' +
        '"‘apply’ does not exist in type". Use `LedgerCommitOp<T>` / ' +
        '`LedgerCommitResult<T>`, or `Omit<LedgerCommitOp<T>, ‘apply’>` to refuse the ' +
        'arm deliberately.',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditLedgerCommitTail(): Finding[] {
  const sources = new Map<string, string>()
  for (const file of sourceFiles()) sources.set(file, read(file))
  const findings = rosterFindings(sources)
  for (const [file, source] of sources) {
    findings.push(...rowMapReadOnly(source, file))
    // The facade DECLARES the op; it is not a port restating it.
    if (file !== 'packages/sync/src/ledger.ts') {
      findings.push(...restatedCommitOp(source, file))
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The probe — every check must be able to say YES and to stay quiet
// ---------------------------------------------------------------------------

function probe(): Finding[] {
  const broken: Finding[] = []
  const expectFinds = (check: string, found: Finding[], what: string): void => {
    if (found.length === 0) {
      broken.push({ check, where: '<probe>', detail: `did not find a planted ${what}` })
    }
  }
  const expectClean = (check: string, found: Finding[]): void => {
    if (found.length > 0) {
      broken.push({ check, where: '<probe>', detail: `fired on a clean fixture: ${found[0]?.detail}` })
    }
  }

  expectFinds(
    'commit-site-roster',
    rosterFindings(new Map([['apps/server/src/modules/planted/service.ts', 'x.commit({ write: 1 })']])),
    'commit site in an unrostered file',
  )
  expectFinds(
    'commit-site-roster',
    rosterFindings(new Map([['apps/server/src/modules/funnel.ts', '.commit({\n.commit({\n']])),
    'changed site count in a rostered file',
  )
  expectFinds(
    'commit-site-roster',
    rosterFindings(new Map([['apps/server/src/modules/funnel.ts', 'nothing here']])),
    'stale roster entry for a file with no sites',
  )
  expectClean(
    'commit-site-roster',
    rosterFindings(
      new Map([...COMMIT_SITE_ROSTER].map(([file, e]) => [file, '.commit({\n'.repeat(e.sites)])),
    ),
  )

  expectFinds(
    'issue-rows-readonly',
    rowMapReadOnly('  get rows(): Map<string, IssueRow> {\n    return this.hydrated\n  }', '<probe>'),
    'a writable rows getter',
  )
  expectClean(
    'issue-rows-readonly',
    rowMapReadOnly('  get rows(): ReadonlyMap<string, IssueRow> {\n    return this.hydrated\n  }', '<probe>'),
  )
  expectClean('issue-rows-readonly', rowMapReadOnly('no getter here at all', '<probe>'))

  expectFinds(
    'one-commit-op',
    restatedCommitOp('  commit<T>(op: { write: () => T; changes: (r: T) => S[] }): R', '<probe>'),
    'a hand-restated commit op',
  )
  expectClean('one-commit-op', restatedCommitOp('  commit<T>(op: LedgerCommitOp<T>): R', '<probe>'))
  expectClean(
    'one-commit-op',
    restatedCommitOp("  commit<T>(op: Omit<LedgerCommitOp<T>, 'apply'>): R", '<probe>'),
  )
  return broken
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Ledger-tail audit: THE INSTRUMENT IS BROKEN — a check cannot say YES or NO.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('ledger-tail audit: every check found its planted fixture and spared the clean one')
    return
  }

  const findings = auditLedgerCommitTail()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Ledger-tail audit: ${findings.length} finding(s). POD-3366's claims are:\n` +
        '  · every `.commit({` call site is classified, because a released savepoint is not a commit\n' +
        '  · `IssueStore.rows` stays a ReadonlyMap, so a map install after a commit cannot compile\n' +
        "  · `Ledger.commit`'s op has ONE spelling, so a port cannot silently lose an arm\n",
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  const sites = [...COMMIT_SITE_ROSTER.values()].reduce((sum, e) => sum + e.sites, 0)
  console.log(
    `ledger-tail audit OK — ${sites} commit sites across ${COMMIT_SITE_ROSTER.size} files, all ` +
      'classified; the issue row map is read-only; one spelling of the op',
  )
}

if (import.meta.main) main()
