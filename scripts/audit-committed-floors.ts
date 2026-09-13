/**
 * THE FLOOR CHECK — POD-3906, the mirror of POD-3904's raise check.
 *
 * `baseline-ratchet.ts` made raising a guardrail's number cost a record. Half
 * this repository's committed numbers are the other shape: a FLOOR, where the
 * measurement must stay ABOVE the number and the escape is therefore LOWERING
 * it. `MIN_ID_FIELD_SITES` is the one that matters most — it is what stops the
 * entity-id scan from reporting a serene zero and banking the whole debt as
 * deleted — and until this file existed, editing `1800` to `0` was a one-token
 * diff that no check in the repository had an opinion about.
 *
 * THE EVIDENCE THAT THIS IS NOT HYPOTHETICAL is the ratchet's own history. The
 * single `RaiseAuthorisation` in the repository records `FIRST_ADMIN_USER_ID`
 * 46 -> `firstAdminMemberId` 42 -> 38: three movements, every one of them
 * DOWNWARD, and `checkRaise` only ever compared upward. The instrument's entire
 * recorded history is travel in the direction it did not guard.
 *
 * WHY A CENSUS RATHER THAN A CHECK IN EACH INSTRUMENT. POD-3904 put its check
 * inside the audit it guards, which is right when the audit has a gate to hang
 * it on. These four do not: `entity-id-audit.ts`'s own `main` is a report and
 * its gate lives in `rearch-audit.ts`, `verify-client-build.ts` has no `main`
 * at all and is a library the release lane calls, and the floor in
 * `audit-telegram-binding.ts` is enforced from inside a scan function. One
 * place that reads every committed number out of git and compares it with the
 * working tree covers all of them without reshaping four unrelated scripts.
 *
 * AND A HAND-KEPT CENSUS IS A LIST THAT ROTS, which is its own way of reporting
 * a green that checked nothing. So the registry is itself checked, three ways:
 * a baseline-shaped constant anywhere under `scripts/` that is neither
 * registered nor excluded FAILS; an exclusion or a registration naming a
 * constant that no longer exists FAILS; and every exclusion carries a written
 * reason. The scan is by CONVENTION over the name, which is its known limit —
 * a floor called `sanity` is invisible to it — and that limit is why each entry
 * also names what the number is a floor under, in prose, for a human.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import {
  type BaselineAuthorisation,
  type BaselineDirection,
  baseRevision,
  checkBaseline,
  constantsIn,
  constantsInFile,
  type Finding,
  fileAtRevision,
  type GitRunner,
  gitIn,
  REPO_ROOT,
} from './baseline-ratchet'

export interface CommittedBaseline {
  /** The name the findings are reported under. */
  readonly instrument: string
  readonly relativePath: string
  /** The `const` the number lives in, parsed out of the file as of the base commit. */
  readonly exportName: string
  /**
   * Which way each key may not move, spelled as {@link qualify} spells it. No
   * default — see `BaselineDirection` in `baseline-ratchet.ts` for why.
   */
  readonly directions: Readonly<Record<string, BaselineDirection>>
  /** What the number is a bound on, for a reader who has not read the script. */
  readonly what: string
}

// ---------------------------------------------------------------------------
// Spelling a parsed constant
// ---------------------------------------------------------------------------

/**
 * `constantsIn` keys a bare `const X = 1` under the EMPTY string and an object
 * literal under its members. Both become findings a human has to read, so put
 * the export's own name on the front: `MIN_ID_FIELD_SITES`, not ``, and
 * `CLIENT_FILE_FLOOR.web`, not `web`.
 */
export const qualify = (
  raw: Readonly<Record<string, number>>,
  exportName: string,
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k === '' ? exportName : `${exportName}.${k}`, v]),
  )

/**
 * Every key of one record, all one direction.
 *
 * `directions` is per KEY and has no default, for the reason
 * `BaselineDirection` gives: one instrument can hold both shapes, and a floor
 * that silently inherits ceiling semantics is this issue one level up. That
 * reasoning is about an instrument holding SEVERAL numbers read by SEVERAL
 * comparisons. It does not reach a record whose every member is read by ONE —
 * `GOD_OBJECT_BUDGET` has exactly one, `m.physical > budget`, so every key in
 * it is a ceiling by construction and there is no second shape for a guess to
 * get wrong.
 *
 * Derived rather than spelled out ONLY where the key set is a POPULATION that
 * moves: the god-object budgets gain and lose a key whenever a module crosses
 * or leaves the 600-line threshold, and a hand-kept mirror of a moving set in a
 * second file is precisely the list-that-rots this census exists to refuse. A
 * FIXED vocabulary is spelled out instead — see `WEB_BUNDLE_BUDGET` below,
 * whose eight keys are two graphs measured through four lenses and change only
 * if that gate is redesigned.
 */
export const everyKeyIs = (
  relativePath: string,
  exportName: string,
  direction: BaselineDirection,
): Record<string, BaselineDirection> =>
  Object.fromEntries(
    Object.keys(qualify(constantsInFile(relativePath, exportName), exportName)).map((k) => [
      k,
      direction,
    ]),
  )

/**
 * THE CENSUS. A `floor` is a number the measurement must stay AT OR ABOVE, so
 * lowering it is the escape; a `ceiling` is POD-3904's shape, where raising is.
 * Getting this backwards is easy and consequential, so each entry says which
 * comparison it was read off.
 */
export const COMMITTED_BASELINES: readonly CommittedBaseline[] = [
  {
    instrument: 'entity-id-audit',
    relativePath: 'scripts/entity-id-audit.ts',
    exportName: 'MIN_ID_FIELD_SITES',
    directions: { MIN_ID_FIELD_SITES: 'floor' },
    what: 'Entity-id field positions the scan must still find (`out.length < MIN_ID_FIELD_SITES` throws). THE COVERAGE FLOOR, and the most consequential number in this census: it is the only thing standing between a scanner that has stopped matching and a count of zero read as a clean tree. Its own message says so — "every count below would be a false zero. Fix the scan; do not rebaseline."',
  },
  {
    instrument: 'verify-client-build',
    relativePath: 'scripts/verify-client-build.ts',
    exportName: 'CLIENT_FILE_FLOOR',
    directions: { 'CLIENT_FILE_FLOOR.web': 'floor', 'CLIENT_FILE_FLOOR.mobile': 'floor' },
    what: 'Files a built client must contain before the build is releasable (`manifest.fileCount < CLIENT_FILE_FLOOR[label]` throws). A truncated or empty dist is the failure it exists to refuse, and lowering the floor is how a truncated dist ships.',
  },
  {
    instrument: 'audit-telegram-binding',
    relativePath: 'scripts/audit-telegram-binding.ts',
    exportName: 'MIN_SCANNED_FILES',
    directions: { MIN_SCANNED_FILES: 'floor' },
    what: 'Files the whole-tree scan must have read before its findings mean anything (`wholeTree.size < MIN_SCANNED_FILES` throws). A second coverage floor: a scan that walked nothing reports no violations.',
  },
  {
    instrument: 'baseline-ratchet',
    relativePath: 'scripts/baseline-ratchet.ts',
    exportName: 'MIN_REASON_LENGTH',
    directions: { MIN_REASON_LENGTH: 'floor' },
    what: 'Characters an authorisation’s reason must run to before the ratchet accepts it. A floor on the ARGUMENT rather than on a measurement, and the ratchet’s own escape hatch: lower it to 0 and every rubber-stamp authorisation in the repository starts passing, including the ones guarding the floors in this census.',
  },
  {
    instrument: 'server-construction-order',
    relativePath: 'scripts/server-construction-order.ts',
    exportName: 'ENROLLMENT_THRESHOLD',
    directions: { ENROLLMENT_THRESHOLD: 'ceiling' },
    what: 'Statements a composition body may reach before it must be an enrolled, order-audited site (`body.statements.length < threshold` SKIPS it). A CEILING, not a floor: raising it is what makes the next unwatched wiring body invisible. POD-3906’s brief listed this one as a floor; the comparison says otherwise.',
  },
  {
    instrument: 'rearch-audit',
    relativePath: 'scripts/rearch-audit.ts',
    exportName: 'DAEMON_COMPOSITION_ROOT_MAX_LINES',
    directions: { DAEMON_COMPOSITION_ROOT_MAX_LINES: 'ceiling' },
    what: 'Lines the daemon composition root may reach before the deletion audit reports it (`lineCount <= MAX` returns no finding). A ceiling. Its sibling test FLOATS against it (`… + 1`), so it proves the check fires at whatever boundary the constant currently names and stays green when the constant moves — which is the shape POD-3904 was filed about.',
  },
  {
    instrument: 'change-row-audit',
    relativePath: 'scripts/change-row-audit.ts',
    exportName: 'CHANGE_ROW_THRESHOLD',
    directions: { CHANGE_ROW_THRESHOLD: 'ceiling' },
    what: 'Change-row keys a record must carry before the detector counts it (`matched >= CHANGE_ROW_THRESHOLD`). A ceiling: raising it narrows the detector, and the script’s own comment already names "a raised CHANGE_ROW_THRESHOLD" as one of the ways the audit comes to report "a serene zero".',
  },
  {
    instrument: 'representation-audit',
    relativePath: 'scripts/representation-audit.ts',
    exportName: 'ENTITY_SHAPE_THRESHOLD',
    directions: { ENTITY_SHAPE_THRESHOLD: 'ceiling' },
    what: 'Distinct entity-concept keys a declaration must hand-declare before it counts as entity-shaped (below it, the site is SKIPPED). A ceiling: raising it shrinks the counted population without touching a single site. Registered for completeness rather than because it is exposed — `representation-audit.test.ts` PINS it with `expect(ENTITY_SHAPE_THRESHOLD).toBe(3)`, and it is the only threshold in the repository a sibling test pins. The pin and this entry fail on different diffs: the pin catches the constant moving alone, this catches it moving together with the test that pins it.',
  },
  {
    instrument: 'audit-god-objects',
    relativePath: 'scripts/audit-god-objects.ts',
    exportName: 'THRESHOLD',
    directions: { THRESHOLD: 'ceiling' },
    what: 'Physical lines a production module may reach before the audit demands a reviewed exception for it (`m.physical > THRESHOLD` selects the population). THE MASTER ESCAPE of that instrument, and the reason it is registered first: raising it does not argue with a single finding, it removes them. At 600 the audit reports 97 items on this branch, and there is a number above which it reports none. Every other bound in that file is an argument about one module; this one is an argument about whether there is an audit.',
  },
  {
    instrument: 'audit-god-objects',
    relativePath: 'scripts/audit-god-objects.ts',
    exportName: 'MIN_ARGUMENT',
    directions: { MIN_ARGUMENT: 'floor' },
    what: 'Characters a ledger entry’s written argument must run to before the audit accepts it (`entry.argument.trim().length < MIN_ARGUMENT` fails). A FLOOR — the one number in that file whose escape is lowering — and the same shape as `MIN_REASON_LENGTH` above. The god-object audit’s own position is that the prose, not the predicates, is what catches a module quietly doing several jobs, so this is the floor under the only check that reads the argument at all.',
  },
  {
    instrument: 'audit-god-objects',
    relativePath: 'scripts/audit-god-objects.ts',
    exportName: 'MAX_SURFACE_STATE',
    directions: { MAX_SURFACE_STATE: 'ceiling' },
    what: 'Private mutable fields an `operation-surface` may hold before its claim is refused (`privateStateFields.length > MAX_SURFACE_STATE`). A ceiling: raising it is how a module that has started entangling its operations through shared state keeps a kind whose whole claim is that they share nothing.',
  },
  {
    instrument: 'audit-god-objects',
    relativePath: 'scripts/audit-god-objects.ts',
    exportName: 'MAX_COUPLED_STATE',
    directions: { MAX_COUPLED_STATE: 'ceiling' },
    what: 'Coupled fields a `cohesive-owner` may declare before the claim stops being cohesion (`declared.length > MAX_COUPLED_STATE`). A ceiling, and one that file calibrated against a measured gap between 11 fields and 18 — so a raise past 17 readmits `messages/service.ts`, the module the bound was cut around, without re-measuring anything.',
  },
  {
    instrument: 'audit-god-objects',
    relativePath: 'scripts/audit-god-objects.ts',
    exportName: 'MAX_METHOD_LINES',
    directions: { MAX_METHOD_LINES: 'ceiling' },
    what: 'Lines the longest method of an `operation-surface` may span before the claim is refused (`maxMethodLines > MAX_METHOD_LINES`). A ceiling: the surface claim IS “many small operations”, so raising this is how one long method comes to hide inside a file whose average still looks fine.',
  },
  {
    instrument: 'audit-god-objects',
    relativePath: 'scripts/audit-god-objects.ts',
    exportName: 'GOD_OBJECT_BUDGET',
    directions: everyKeyIs('scripts/audit-god-objects.ts', 'GOD_OBJECT_BUDGET', 'ceiling'),
    what: 'Physical lines past which each reviewed god-object exception is VOID and must be redone (`m.physical > budget`). Twenty-eight ceilings, one per ledger entry, keyed by the module so the key survives a reordering of the ledger. THE BEST-EVIDENCED ENTRY IN THIS CENSUS: replaying the ledger across the seventeen commits that have touched that file gives four raises, no lowerings, and three of the four sit in commits whose own subject line is “clear the two red audits on main”, “restore package-gate guardrail audits on main” and “Restore all verification lanes” — the number edited until the audit went quiet, with no re-review written beside it. Twenty of the twenty-eight are exceeded right now, so the pressure is live rather than historical.',
  },
  {
    instrument: 'web-bundle-budget',
    relativePath: 'scripts/web-bundle-budget.ts',
    exportName: 'WEB_BUNDLE_BUDGET',
    directions: {
      'WEB_BUNDLE_BUDGET.eager.raw': 'ceiling',
      'WEB_BUNDLE_BUDGET.eager.gzip': 'ceiling',
      'WEB_BUNDLE_BUDGET.eager.brotli': 'ceiling',
      'WEB_BUNDLE_BUDGET.eager.sourceBytes': 'ceiling',
      'WEB_BUNDLE_BUDGET.settings.raw': 'ceiling',
      'WEB_BUNDLE_BUDGET.settings.gzip': 'ceiling',
      'WEB_BUNDLE_BUDGET.settings.brotli': 'ceiling',
      'WEB_BUNDLE_BUDGET.settings.sourceBytes': 'ceiling',
    },
    what: 'Bytes the eager and settings graphs may reach before packaging fails (`actual <= budget` passes). Eight ceilings: two graphs through four lenses each — raw, gzip, Brotli and parsed source. Three of the four eager ones are PAYLOAD, i.e. bandwidth every session pays on open. Spelled out key by key rather than derived, because this vocabulary is fixed by that gate’s design rather than by which modules happen to be large this month. Until POD-3905 these eight were inline call arguments with no name — the second of the two shapes this file’s own header named as ones its scan could not see. The raise log is in the comments beside each comparison; the source ceiling alone has moved seven times.',
  },
]

/** Movements of a number in this census that have been argued for. */
export const BASELINE_AUTHORISATIONS: readonly BaselineAuthorisation[] = []

export interface CensusExclusion {
  /** `<relative path>:<CONST>`, exactly as the scan spells it. */
  readonly where: string
  readonly why: string
}

/**
 * Baseline-SHAPED names that are not baselines, or not this issue's to register.
 * An entry here is a claim a reader can check, which is the difference between
 * an exclusion and a blind spot.
 */
export const NOT_A_COMMITTED_BASELINE: readonly CensusExclusion[] = [
  {
    where: 'scripts/precompress-dist.ts:MIN_BYTES',
    why: 'Not a gate. It selects which built files are worth compressing (`size < MIN_BYTES` skips one); moving it changes how much work the step does and can make no run pass that would otherwise have failed.',
  },
  {
    where: 'scripts/render-install-banner.ts:THRESHOLD',
    why: 'Not a gate. It is the ink-coverage fraction (0.45) at which the setup banner\u2019s ASCII art fills a half-cell; moving it changes what the banner looks like and can make no check pass that would otherwise have failed.',
  },
]

// ---------------------------------------------------------------------------
// The registry's own check
// ---------------------------------------------------------------------------

/**
 * Names this repository spells a bound with. Widened once already: the first
 * spelling of this pattern missed `THRESHOLD` (no prefix) and
 * `DAEMON_COMPOSITION_ROOT_MAX_LINES` (`_MAX_` in the middle), both of which
 * `docs/baseline-ratchet-census.md` had already listed as silently raisable.
 *
 * TWO THINGS IT STILL CANNOT SEE, and they are named rather than assumed away.
 * A bound spelled as the length of a committed list — `DURABLE_STORES.length`,
 * `RETAINED_REPRESENTATIONS.length` — is not a numeric constant and never
 * matches. And a bound written INLINE at its comparison has no name to match at
 * all. `web-bundle-budget.ts`'s eight byte ceilings were the example given here
 * of the second kind; POD-3905 did not teach the scan to see an inline argument,
 * it gave those eight a name (`WEB_BUNDLE_BUDGET`), which is the only repair
 * available — a convention over names cannot be widened to cover things that
 * have none. The list-length shape is still outside this scan, and is still in
 * the census document. That is why every entry below also says in prose what
 * its number bounds: a human reading the list is the backstop for a
 * convention.
 */
export const BASELINE_SHAPED_NAME =
  /^(MIN|MAX)_|_(FLOOR|CEILING|THRESHOLD|BUDGET|LIMIT|MAX|MIN)$|^(THRESHOLD|FLOOR|CEILING|BUDGET|LIMIT)$|_(MAX|MIN)_/

/** `<relative path>:<CONST>` for every baseline-shaped NUMBER under `scripts/`. */
export const baselineShapedConstants = (root: string = REPO_ROOT): string[] => {
  const dir = join(root, 'scripts')
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    const source = readFileSync(join(dir, entry), 'utf8')
    const sf = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true)
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText(sf)
        if (!BASELINE_SHAPED_NAME.test(name)) continue
        // Through the SAME parser the ratchet reads baselines with, so the scan
        // cannot disagree with the comparison about what counts as a number.
        if (Object.keys(constantsIn(source, name)).length === 0) continue
        out.push(`scripts/${entry}:${name}`)
      }
    }
  }
  return out
}

export interface RegistryInput {
  /** What the scan found. */
  readonly found: readonly string[]
  /** `<path>:<CONST>` for every census entry. */
  readonly registered: readonly string[]
  /** `<path>:<CONST>` for every written exclusion. */
  readonly excluded: readonly string[]
}

/** Findings for a census that has drifted away from the tree, in either direction. */
export const checkRegistry = ({ found, registered, excluded }: RegistryInput): Finding[] => {
  const findings: Finding[] = []
  const accounted = new Set([...registered, ...excluded])
  for (const where of found) {
    if (accounted.has(where)) continue
    findings.push({
      check: 'committed-baseline-unregistered',
      where,
      detail: `a baseline-shaped constant that this census neither guards nor excuses, so nothing compares it against the commit this branch started from. Add it to COMMITTED_BASELINES with a direction — 'floor' if the measurement must stay AT OR ABOVE it (the escape is lowering), 'ceiling' if at or below (the escape is raising) — or, if it is not a gate at all, say so in NOT_A_COMMITTED_BASELINE.`,
    })
  }
  const present = new Set(found)
  for (const where of excluded) {
    if (present.has(where)) continue
    findings.push({
      check: 'committed-baseline-exclusion-stale',
      where,
      detail: `excused as not-a-baseline, but no such constant exists any more. A dead exclusion is a name a future floor can be hidden under: delete the entry.`,
    })
  }
  for (const where of registered) {
    if (present.has(where)) continue
    findings.push({
      check: 'committed-baseline-registration-stale',
      where,
      detail: `registered in the census, but no such constant exists any more — so this entry has been guarding nothing. If it was renamed, register the new spelling; if it is gone, delete the entry.`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface CensusRun {
  readonly findings: Finding[]
  readonly how: string
  readonly current: Record<string, number>
}

/**
 * Every registered number, in the working tree and as of the base commit.
 *
 * The base revision is resolved ONCE and every entry compared against it, so a
 * report cannot mix two commits — and `how` is printed whatever happens, so a
 * run that could not look says so rather than passing quietly.
 */
export const auditCommittedBaselines = (
  opts: {
    readonly requireBase?: boolean
    readonly git?: GitRunner
    readonly env?: NodeJS.ProcessEnv
    readonly baselines?: readonly CommittedBaseline[]
  } = {},
): CensusRun => {
  const git = opts.git ?? gitIn()
  const baselines = opts.baselines ?? COMMITTED_BASELINES
  const { commit, how } = baseRevision(git, opts.env)
  const resolvedHow = commit === null ? how : `${how} (${commit.slice(0, 9)})`
  const findings: Finding[] = []
  const current: Record<string, number> = {}
  for (const b of baselines) {
    const here = qualify(constantsInFile(b.relativePath, b.exportName), b.exportName)
    Object.assign(current, here)
    const source = commit === null ? null : fileAtRevision(commit, b.relativePath, git)
    const base = source === null ? null : qualify(constantsIn(source, b.exportName), b.exportName)
    findings.push(
      ...checkBaseline({
        instrument: b.instrument,
        current: here,
        base,
        directions: b.directions,
        authorisations: BASELINE_AUTHORISATIONS,
        enforced: Object.keys(b.directions),
        how: resolvedHow,
        requireBase: opts.requireBase ?? false,
      }),
    )
  }
  findings.push(
    ...checkRegistry({
      found: baselineShapedConstants(),
      registered: baselines.map((b) => `${b.relativePath}:${b.exportName}`),
      excluded: NOT_A_COMMITTED_BASELINE.map((e) => e.where),
    }),
  )
  return { findings, how: resolvedHow, current }
}

// ---------------------------------------------------------------------------
// --probe: every check, planted
// ---------------------------------------------------------------------------

/**
 * Proves each check in this file CAN fire, on every run of the gate rather than
 * only in a unit test. A gate whose own negative case is only ever exercised by
 * its test file is one nobody notices going inert.
 */
export const probe = (): Finding[] => {
  const broken: Finding[] = []
  const expect = (check: string, dirty: Finding[], clean: Finding[]) => {
    if (!dirty.some((f) => f.check === check))
      broken.push({ check, where: '<probe>', detail: 'missed its planted violation' })
    if (clean.length > 0)
      broken.push({ check, where: '<probe>', detail: 'fired on the clean fixture' })
  }

  const floorArgs = (over: Partial<Parameters<typeof checkBaseline>[0]>) =>
    checkBaseline({
      instrument: '<probe>',
      current: { PROBE_FLOOR: 1200 },
      base: { PROBE_FLOOR: 1800 },
      directions: { PROBE_FLOOR: 'floor' },
      authorisations: [],
      enforced: ['PROBE_FLOOR'],
      how: '<probe>',
      requireBase: false,
      ...over,
    })
  const authorised: BaselineAuthorisation = {
    key: 'PROBE_FLOOR',
    from: 1800,
    to: 1200,
    issue: 'POD-0000',
    reason: 'a probe fixture reason long enough to clear the minimum length the check requires',
  }
  // The clean arm of a floor is the floor moving UP — the exact opposite of the
  // clean arm POD-3904's probe uses, which is the whole point of this issue.
  expect(
    'baseline-lowered-without-authorisation',
    floorArgs({}),
    floorArgs({ current: { PROBE_FLOOR: 2400 } }),
  )
  expect(
    'baseline-lowered-without-authorisation',
    floorArgs({ authorisations: [{ ...authorised, reason: 'short' }] }),
    floorArgs({ authorisations: [authorised] }),
  )
  expect(
    'baseline-direction-undeclared',
    floorArgs({ directions: {} }),
    floorArgs({ current: { PROBE_FLOOR: 1800 } }),
  )
  expect(
    'committed-baseline-unregistered',
    checkRegistry({ found: ['scripts/probe.ts:MIN_X'], registered: [], excluded: [] }),
    checkRegistry({
      found: ['scripts/probe.ts:MIN_X'],
      registered: ['scripts/probe.ts:MIN_X'],
      excluded: [],
    }),
  )
  expect(
    'committed-baseline-exclusion-stale',
    checkRegistry({ found: [], registered: [], excluded: ['scripts/probe.ts:GONE'] }),
    checkRegistry({
      found: ['scripts/probe.ts:GONE'],
      registered: [],
      excluded: ['scripts/probe.ts:GONE'],
    }),
  )
  expect(
    'committed-baseline-registration-stale',
    checkRegistry({ found: [], registered: ['scripts/probe.ts:GONE'], excluded: [] }),
    checkRegistry({
      found: ['scripts/probe.ts:GONE'],
      registered: ['scripts/probe.ts:GONE'],
      excluded: [],
    }),
  )

  // PDM-325. A key the base commit does not have used to be skipped at ANY
  // value, and this census is the caller where that was total: it has no drift
  // check of its own, so nothing else ever looked at the number. Planted on
  // every run because the unit tests for it live in a lane this epic has
  // already shown can be red and unread.
  expect(
    'baseline-introduced-without-authorisation',
    floorArgs({ base: {} }),
    floorArgs({
      base: {},
      authorisations: [
        {
          key: 'PROBE_FLOOR',
          from: null,
          to: 1200,
          issue: 'POD-0000',
          reason:
            'a probe fixture reason long enough to clear the minimum length the check requires',
        },
      ],
    }),
  )
  // And `from: null` must not become the cheap way to launder a movement: the
  // same record against a base that DOES carry the key is a raise, not a birth.
  if (
    floorArgs({
      authorisations: [
        {
          key: 'PROBE_FLOOR',
          from: null,
          to: 1200,
          issue: 'POD-0000',
          reason:
            'a probe fixture reason long enough to clear the minimum length the check requires',
        },
      ],
    }).length === 0
  )
    broken.push({
      check: 'baseline-genesis-cannot-launder-a-lowering',
      where: '<probe>',
      detail: 'a lowering recorded as if the key had never existed was accepted',
    })

  // A lowering authorised at the WRONG `from` must not pass: the number an
  // author cannot write from memory is the entire mechanism.
  if (floorArgs({ authorisations: [{ ...authorised, from: 1700 }] }).length === 0)
    broken.push({
      check: 'baseline-lower-from-must-match',
      where: '<probe>',
      detail: 'a lowering authorised from the wrong previous value was accepted',
    })
  return broken
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  if (argv.includes('--probe')) {
    const broken = probe()
    for (const f of broken) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    console.log(
      broken.length === 0
        ? 'committed-floor census: every check found its planted fixture'
        : `\n${broken.length} check(s) could not be made to fire`,
    )
    process.exit(broken.length === 0 ? 0 : 1)
  }
  const run = auditCommittedBaselines({ requireBase: argv.includes('--require-base') })
  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        { current: run.current, baseSource: run.how, findings: run.findings },
        null,
        2,
      ),
    )
  } else {
    for (const b of COMMITTED_BASELINES)
      for (const [key, direction] of Object.entries(b.directions))
        console.log(`${key}: ${run.current[key] ?? '—'}  (${direction}, ${b.instrument})`)
    console.log(`compared against: ${run.how}`)
    if (run.findings.length === 0)
      console.log('\ncommitted-floor census: no unargued lowering, and nothing unregistered')
    else {
      console.error('')
      for (const f of run.findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    }
  }
  process.exit(run.findings.length === 0 ? 0 : 1)
}
