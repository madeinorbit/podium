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

/**
 * Movements of a number in this census that have been argued for — and, since
 * PDM-325, the FIRST value of one too.
 *
 * THE THIRTY-SIX GENESIS RECORDS BELOW ARE POD-3905’s OWN BILL. Naming the eight
 * bundle ceilings and the twenty-eight god-object budgets is what made them
 * comparable against history; it also made them keys the base commit does not
 * carry, and PDM-325’s rule is that a first value costs the same paragraph a
 * raised one does. That rule is right and it lands on this issue first: a gate
 * registered at whatever the tree happens to say today is a debt banked as a
 * baseline.
 *
 * SO TWENTY OF THE TWENTY-EIGHT BUDGETS ARE RECORDED AS DEBT MARKERS RATHER THAN
 * AS CEILINGS THE TREE MEETS. `server.ts` starts at 900 while the module
 * measures 2451. Starting it at 2451 would have made `review-budget-exceeded` go
 * quiet and turned 1551 unreviewed lines into “reviewed” in one edit — the exact
 * move this issue exists to make expensive, and one this ledger’s own history
 * shows being made four times already. Each of those twenty reasons names its
 * own gap rather than repeating this one.
 *
 * AND FOUR ARE FLAGGED RATHER THAN ARGUED. The settings chunk’s four ceilings
 * have never moved in the twenty-nine commits that have touched
 * `web-bundle-budget.ts`, and carry no comment, no measured headroom and nothing
 * else to say where they came from. Their records fix the value and say exactly
 * that, because a confident sentence invented for a number nobody can source is
 * the rubber stamp this ledger was built to refuse. They are the four to look at
 * first if anyone wants to spend a build on re-deriving something.
 */
export const BASELINE_AUTHORISATIONS: readonly BaselineAuthorisation[] = [
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/store/types.ts',
    from: null,
    to: 750,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for store/types.ts, a declarations module, reviewed at POD-1385. It starts at 750 because 750 is the last value a reviewer actually accepted, and the module now measures 835 — 85 lines past it, 1.11x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 835 instead would silence that finding and launder 85 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/migrations/schema.ts',
    from: null,
    to: 1600,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for migrations/schema.ts, a declaration table, reviewed at POD-1385 / [spec:SP-4428]. It starts at 1600 because 1600 is the last value a reviewer actually accepted, and the module now measures 2952 — 1352 lines past it, 1.84x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 2952 instead would silence that finding and launder 1352 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/composition/reactions.ts',
    from: null,
    to: 800,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for composition/reactions.ts, a declaration table, reviewed at POD-1385 / POD-355. It starts at 800 because that is the value the review set, and the module measures 721 today — within it, with 79 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/superagent/tools.ts',
    from: null,
    to: 1100,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/superagent/tools.ts, a declaration table, reviewed at POD-1385. It starts at 1100 because that is the value the review set, and the module measures 1009 today — within it, with 91 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/issues/registry.ts',
    from: null,
    to: 1400,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/issues/registry.ts, a declaration table, reviewed at POD-1398. It starts at 1400 because that is the value the review set, and the module measures 1394 today — within it, with 6 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/relay.ts',
    from: null,
    to: 2300,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for relay.ts, the composition root, reviewed at POD-1385 / POD-321 / POD-734 / POD-418. It starts at 2300 because 2300 is the last value a reviewer actually accepted, and the module now measures 3630 — 1330 lines past it, 1.58x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 3630 instead would silence that finding and launder 1330 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/machines/rpc.ts',
    from: null,
    to: 1200,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/machines/rpc.ts, an operation surface, reviewed at POD-1385 / POD-531. It starts at 1200 because 1200 is the last value a reviewer actually accepted, and the module now measures 1911 — 711 lines past it, 1.59x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1911 instead would silence that finding and launder 711 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/store/issues.ts',
    from: null,
    to: 1100,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for store/issues.ts, an operation surface, reviewed at POD-1385 / POD-585 (re-review after POD-1653 + POD-568 projections). It starts at 1100 because 1100 is the last value a reviewer actually accepted, and the module now measures 1611 — 511 lines past it, 1.46x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1611 instead would silence that finding and launder 511 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/store/messages.ts',
    from: null,
    to: 750,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for store/messages.ts, an operation surface, reviewed at POD-1606 / POD-1379 (per-reader ledger) / POD-1385. It starts at 750 because 750 is the last value a reviewer actually accepted, and the module now measures 1095 — 345 lines past it, 1.46x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1095 instead would silence that finding and launder 345 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/store/sessions.ts',
    from: null,
    to: 900,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for store/sessions.ts, an operation surface, reviewed at POD-1385. It starts at 900 because 900 is the last value a reviewer actually accepted, and the module now measures 1198 — 298 lines past it, 1.33x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1198 instead would silence that finding and launder 298 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/store/workflows.ts',
    from: null,
    to: 750,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for store/workflows.ts, an operation surface, reviewed at POD-1385 / POD-362. It starts at 750 because 750 is the last value a reviewer actually accepted, and the module now measures 752 — 2 lines past it, 1.00x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 752 instead would silence that finding and launder 2 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/issues/service/crud.ts',
    from: null,
    to: 950,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/issues/service/crud.ts, an operation surface, reviewed at POD-1385 / POD-320. It starts at 950 because 950 is the last value a reviewer actually accepted, and the module now measures 1851 — 901 lines past it, 1.95x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1851 instead would silence that finding and launder 901 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/issues/service/reads.ts',
    from: null,
    to: 850,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/issues/service/reads.ts, an operation surface, reviewed at POD-1385 / POD-320. It starts at 850 because 850 is the last value a reviewer actually accepted, and the module now measures 870 — 20 lines past it, 1.02x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 870 instead would silence that finding and launder 20 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/workflows/service.ts',
    from: null,
    to: 850,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/workflows/service.ts, an operation surface, reviewed at POD-1385 / POD-732. It starts at 850 because that is the value the review set, and the module measures 795 today — within it, with 55 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/automations/service.ts',
    from: null,
    to: 800,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/automations/service.ts, an operation surface, reviewed at POD-1385. It starts at 800 because that is the value the review set, and the module measures 702 today — within it, with 98 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/server.ts',
    from: null,
    to: 900,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for server.ts, an operation surface, reviewed at POD-1385 / POD-585 (re-review after POD-1670 routes + POD-541 mobile COOP). It starts at 900 because 900 is the last value a reviewer actually accepted, and the module now measures 2451 — 1551 lines past it, 2.72x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 2451 instead would silence that finding and launder 1551 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/settings/service.ts',
    from: null,
    to: 850,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/settings/service.ts, an operation surface, reviewed at POD-1385. It starts at 850 because that is the value the review set, and the module measures 751 today — within it, with 99 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/sessions/command-plane.ts',
    from: null,
    to: 800,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/sessions/command-plane.ts, a documented module, reviewed at POD-1385 / POD-381 / POD-379. It starts at 800 because 800 is the last value a reviewer actually accepted, and the module now measures 905 — 105 lines past it, 1.13x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 905 instead would silence that finding and launder 105 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/operations/engine.ts',
    from: null,
    to: 800,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/operations/engine.ts, a documented module, reviewed at POD-2097 (docs/internal/superpowers/specs/2026-08-14-update-operations-design.md §3.2–§3.4). It starts at 800 because 800 is the last value a reviewer actually accepted, and the module now measures 2083 — 1283 lines past it, 2.60x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 2083 instead would silence that finding and launder 1283 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/issues/service/core.ts',
    from: null,
    to: 1050,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/issues/service/core.ts, a cohesive owner, reviewed at POD-1385 / POD-320. It starts at 1050 because 1050 is the last value a reviewer actually accepted, and the module now measures 1449 — 399 lines past it, 1.38x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1449 instead would silence that finding and launder 399 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/machines/service.ts',
    from: null,
    to: 850,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/machines/service.ts, a cohesive owner, reviewed at POD-1385 / POD-1467 / POD-1505 / POD-1778. It starts at 850 because 850 is the last value a reviewer actually accepted, and the module now measures 1763 — 913 lines past it, 2.07x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1763 instead would silence that finding and launder 913 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/issues/service/workflow.ts',
    from: null,
    to: 1300,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/issues/service/workflow.ts, a cohesive owner, reviewed at POD-1385 / POD-320 / POD-1606 (re-review after the main reconciliation) / POD-417 (re-review after the POD-384 watch). It starts at 1300 because 1300 is the last value a reviewer actually accepted, and the module now measures 1842 — 542 lines past it, 1.42x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1842 instead would silence that finding and launder 542 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/steward.ts',
    from: null,
    to: 1200,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for steward.ts, a cohesive owner, reviewed at POD-355 (boundary ownership review) / POD-1385. It starts at 1200 because that is the value the review set, and the module measures 1143 today — within it, with 57 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/superagent/service.ts',
    from: null,
    to: 1350,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/superagent/service.ts, a cohesive owner, reviewed at POD-1385. It starts at 1350 because 1350 is the last value a reviewer actually accepted, and the module now measures 1694 — 344 lines past it, 1.25x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1694 instead would silence that finding and launder 344 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/sessions/session-state/service.ts',
    from: null,
    to: 800,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/sessions/session-state/service.ts, a cohesive owner, reviewed at POD-393 Phase 4 ledger entry / POD-1385. It starts at 800 because 800 is the last value a reviewer actually accepted, and the module now measures 903 — 103 lines past it, 1.13x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 903 instead would silence that finding and launder 103 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/messaging/service.ts',
    from: null,
    to: 950,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/messaging/service.ts, a cohesive owner, reviewed at POD-1385 / [spec:SP-5d81] / [spec:SP-62c3]. It starts at 950 because that is the value the review set, and the module measures 889 today — within it, with 61 lines of headroom. Carried forward unchanged from the `budget:` field POD-3905 moved out of the ledger entry: this record fixes the number’s history, it does not re-open the review that chose it. Raising it from here costs a further record.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/sessions/session.ts',
    from: null,
    to: 850,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/sessions/session.ts, a cohesive owner, reviewed at POD-1385. It starts at 850 because 850 is the last value a reviewer actually accepted, and the module now measures 1220 — 370 lines past it, 1.44x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 1220 instead would silence that finding and launder 370 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'GOD_OBJECT_BUDGET.apps/server/src/modules/messages/service.ts',
    from: null,
    to: 2100,
    issue: 'POD-3905',
    reason:
      'Physical-line budget for modules/messages/service.ts, a cohesive owner, reviewed at POD-1397 / POD-1385. It starts at 2100 because 2100 is the last value a reviewer actually accepted, and the module now measures 2996 — 896 lines past it, 1.43x. THIS NUMBER IS A DEBT MARKER, NOT A CEILING THE FILE MEETS: the audit has been reporting it as exceeded, and the gap IS the unreviewed growth. Starting the ratchet at 2996 instead would silence that finding and launder 896 unreviewed lines into ’reviewed’ in the same edit — which is precisely the move POD-3905 was filed to make expensive, and which this file’s history shows being made four times already. The honest first value is the reviewed one, left where it is until somebody re-reviews the module or decomposes it.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.eager.raw',
    from: null,
    to: 1650000,
    issue: 'POD-3905',
    reason:
      'Ceiling on raw bytes of the eager graph — payload, downloaded by every session on open. It starts at 1,650,000 because that is the value in the tree, and unlike most numbers in this census that value has a measurement behind it: Set by the POD-2730 paydown at bdc46c002, which measured 1,458,334 after the move and left 191,666 of headroom (~13%). Replaying this file’s 29 commits, this ceiling has moved 6 times, every movement argued for only in a comment beside it — which is the convention POD-3904 was filed about, holding by nothing but goodwill. The genesis value is the post-paydown one, so the clearance the paydown bought is what a future raise has to argue against.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.eager.gzip',
    from: null,
    to: 520000,
    issue: 'POD-3905',
    reason:
      'Ceiling on gzip bytes of the eager graph — payload. It starts at 520,000 because that is the value in the tree, and unlike most numbers in this census that value has a measurement behind it: Set by the same POD-2730 paydown, which measured 460,501 after the move and left 59,499 of headroom (~13%). Replaying this file’s 29 commits, this ceiling has moved 6 times, every movement argued for only in a comment beside it — which is the convention POD-3904 was filed about, holding by nothing but goodwill. The genesis value is the post-paydown one, so the clearance the paydown bought is what a future raise has to argue against.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.eager.brotli',
    from: null,
    to: 447000,
    issue: 'POD-3905',
    reason:
      'Ceiling on Brotli bytes of the eager graph — payload. It starts at 447,000 because that is the value in the tree, and unlike most numbers in this census that value has a measurement behind it: Set by the same POD-2730 paydown, which measured 395,176 after the move and left 51,824 of headroom (~13%). Replaying this file’s 29 commits, this ceiling has moved 6 times, every movement argued for only in a comment beside it — which is the convention POD-3904 was filed about, holding by nothing but goodwill. The genesis value is the post-paydown one, so the clearance the paydown bought is what a future raise has to argue against.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.eager.sourceBytes',
    from: null,
    to: 7000000,
    issue: 'POD-3905',
    reason:
      'Ceiling on parsed source bytes of the eager graph — house style, not bandwidth. It starts at 7,000,000 because that is the value in the tree, and unlike most numbers in this census that value has a measurement behind it: Set by the POD-2730 paydown, which measured 6,189,048 after the move and left 810,952 of clearance (13.1%), deliberately sized against recorded drift of ~53,497 bytes over twenty commits so it lasts months rather than days. Replaying this file’s 29 commits, this ceiling has moved 15 times, every movement argued for only in a comment beside it — which is the convention POD-3904 was filed about, holding by nothing but goodwill. The genesis value is the post-paydown one, so the clearance the paydown bought is what a future raise has to argue against.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.settings.raw',
    from: null,
    to: 105000,
    issue: 'POD-3905',
    reason:
      'Ceiling on raw bytes of the settings chunk. FLAGGED RATHER THAN ARGUED, and deliberately so. Replaying all 29 commits that have touched this file, this number has NEVER moved, and unlike its four eager siblings it carries no comment, no measured headroom and no paydown behind it — the file records nothing about where 105,000 came from. So this record fixes the value at what the tree has always had and claims no more than that: it is not an endorsement that 105,000 is the right ceiling. Re-deriving it needs a build to measure the settings chunk against, which this issue did not have. Inventing a justification here would be the rubber stamp the ledger exists to refuse.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.settings.gzip',
    from: null,
    to: 30000,
    issue: 'POD-3905',
    reason:
      'Ceiling on gzip bytes of the settings chunk. FLAGGED RATHER THAN ARGUED, and deliberately so. Replaying all 29 commits that have touched this file, this number has NEVER moved, and unlike its four eager siblings it carries no comment, no measured headroom and no paydown behind it — the file records nothing about where 30,000 came from. So this record fixes the value at what the tree has always had and claims no more than that: it is not an endorsement that 30,000 is the right ceiling. Re-deriving it needs a build to measure the settings chunk against, which this issue did not have. Inventing a justification here would be the rubber stamp the ledger exists to refuse.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.settings.brotli',
    from: null,
    to: 26000,
    issue: 'POD-3905',
    reason:
      'Ceiling on Brotli bytes of the settings chunk. FLAGGED RATHER THAN ARGUED, and deliberately so. Replaying all 29 commits that have touched this file, this number has NEVER moved, and unlike its four eager siblings it carries no comment, no measured headroom and no paydown behind it — the file records nothing about where 26,000 came from. So this record fixes the value at what the tree has always had and claims no more than that: it is not an endorsement that 26,000 is the right ceiling. Re-deriving it needs a build to measure the settings chunk against, which this issue did not have. Inventing a justification here would be the rubber stamp the ledger exists to refuse.',
  },
  {
    key: 'WEB_BUNDLE_BUDGET.settings.sourceBytes',
    from: null,
    to: 280000,
    issue: 'POD-3905',
    reason:
      'Ceiling on parsed source bytes of the settings chunk. FLAGGED RATHER THAN ARGUED, and deliberately so. Replaying all 29 commits that have touched this file, this number has NEVER moved, and unlike its four eager siblings it carries no comment, no measured headroom and no paydown behind it — the file records nothing about where 280,000 came from. So this record fixes the value at what the tree has always had and claims no more than that: it is not an endorsement that 280,000 is the right ceiling. Re-deriving it needs a build to measure the settings chunk against, which this issue did not have. Inventing a justification here would be the rubber stamp the ledger exists to refuse.',
  },
]

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
