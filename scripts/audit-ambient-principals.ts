/**
 * THE AMBIENT-PRINCIPAL CENSUS — POD-1385, replacing a hand grep that was wrong
 * three separate ways.
 *
 * Run:
 *   bun run audit:ambient-principals            # census + verdict, exit 1 on drift
 *   bun run audit:ambient-principals --json
 *   bun run audit:ambient-principals --sites    # every site, grouped by file
 *   bun run audit:ambient-principals --probe    # prove every check can say YES
 *   bun run audit:ambient-principals --require-base  # CI: fail if history is unreadable
 *
 * ---------------------------------------------------------------------------
 * WHY A LINE GREP WAS THE WRONG INSTRUMENT
 * ---------------------------------------------------------------------------
 *
 * The constraint everyone was quoting — "production FIRST_ADMIN_USER_ID count is
 * 77 and must not rise" — came from:
 *
 *     grep -rn FIRST_ADMIN_USER_ID apps packages --include=*.ts \
 *       | grep -v "\.test\.ts" | wc -l
 *
 * Three faults, found while decomposing `sessions/lifecycle.ts`:
 *
 *  1. THE FILTER MATCHES CONTENT, NOT PATH. `grep -v "\.test\.ts"` drops any
 *     LINE mentioning a test file, which silently removed two entries in
 *     `migrations/drizzle-manifest.generated.ts` whose embedded SQL prose names
 *     `user-accounts.migration.test.ts`. The real line count was 79, not 77 —
 *     every report tonight, mine included, was two low.
 *
 *  2. IT COUNTS IMPORTS AND COMMENTS AS AMBIENT SITES. Of those 79 lines, 16 are
 *     imports and 13 are comments — including migration prose that mentions the
 *     constant precisely to explain why it deliberately does NOT import it (a
 *     migration is frozen history and spells `'user:sole'` literally). Those are
 *     not places the server assumes a principal.
 *
 *  3. IT RISES WHEN YOU MOVE CODE. Splitting a module that uses the constant
 *     gives the new file its own `import`, so a faithful, zero-behaviour
 *     extraction increments the count. Three of `lifecycle.ts`'s four sites sit
 *     in methods scheduled to move, so the decomposition this repo is mid-way
 *     through would have "raised" it repeatedly while assuming nothing new.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COUNTS INSTEAD, AND WHY THE DELTA IS THE VERDICT
 * ---------------------------------------------------------------------------
 *
 * USAGE SITES: occurrences in code, with imports and comments stripped per file.
 * That is the number answering "how many places does the server assume a
 * principal rather than resolve one".
 *
 * And the gate should read the DELTA, not the absolute. Across a pure move the
 * usage delta is EXACTLY 0 — immune to the +1-per-new-import artefact — while a
 * newly defaulted principal is +1 no matter how the files are arranged. An
 * absolute count cannot tell those apart; a delta can.
 *
 * ---------------------------------------------------------------------------
 * AND THE BASELINE ITSELF IS GUARDED — POD-3904
 * ---------------------------------------------------------------------------
 *
 * Everything above measures the TREE against `BASELINE`. Nothing in it measures
 * `BASELINE`, which is a literal twenty lines up from the comparison that reads
 * it: raise it by five and a five-site regression exits 0, with a diff that
 * looks exactly like a fix. POD-3903 demonstrated that with `checkDrift`
 * itself, and the baseline has already been raised once — 41 -> 46 at
 * b12b5bae6 (POD-1669), argued for in the comment, because the convention was
 * the only thing holding it.
 *
 * So the run now also compares `BASELINE` against the value on the commit this
 * branch started from, which the working tree cannot edit (`baseline-ratchet.ts`
 * explains why the merge base and not the tip). A rise needs a
 * `RAISE_AUTHORISATIONS` entry naming the old value, the new value, an issue
 * and a reason — a block a reviewer reads, not a digit they skim past.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRaise, checkRaiseAgainstBase, type RaiseAuthorisation } from './baseline-ratchet'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['apps', 'packages']

/**
 * The vocabularies this census knows about.
 *
 * FIRST_ADMIN_USER_ID is the one the Phase 4 gate quotes. The others are listed
 * as DECLARED-BUT-NOT-ENFORCED on purpose: POD-1408 owns the question of whether
 * they are the same concept, and POD-1394 measured DEVICE_GRADE_PRINCIPAL at 17
 * production sites and DeviceGradeUnscopedPolicy at 10. Folding them into one
 * budget here would pre-decide a vocabulary question that is not this
 * instrument's to answer — but leaving no seat for them would mean rebuilding
 * this when POD-1408 lands. So they are measured and reported, and only
 * `enforced` spellings can fail the run.
 */
export interface Vocabulary {
  readonly symbol: string
  /** Whether a drift in this spelling fails the audit, or is reported only. */
  readonly enforced: boolean
  readonly note: string
}

export const VOCABULARIES: readonly Vocabulary[] = [
  {
    symbol: 'firstAdminMemberId',
    enforced: true,
    note: 'The Phase 4 gate constraint. A site here is code assuming the first admin rather than resolving the caller. Spelled `FIRST_ADMIN_USER_ID` until A2 retired the constant; the sites are the same sites.',
  },
  {
    symbol: 'DEVICE_GRADE_PRINCIPAL',
    enforced: false,
    note: 'POD-1394 measured 17 production sites. Reported, not enforced — POD-1408 owns whether this is the same concept.',
  },
  {
    symbol: 'DeviceGradeUnscopedPolicy',
    enforced: false,
    note: 'POD-1394 measured 10 production sites. Reported, not enforced, for the same reason.',
  },
]

export interface Site {
  readonly file: string
  readonly line: number
  readonly symbol: string
  readonly text: string
}

export interface Finding {
  check: string
  where: string
  detail: string
}

/** Strip comments, preserving newlines so line numbers survive. Strings are kept
 *  so a symbol quoted inside one is still seen — that is a usage worth counting,
 *  and pretending otherwise would be a way to hide one. */
export const stripComments = (src: string): string => {
  let out = ''
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (mode === 'code') {
      if (two === '//') {
        mode = 'line'
        i += 2
        continue
      }
      if (two === '/*') {
        mode = 'block'
        i += 2
        continue
      }
      if (src[i] === "'") mode = 'single'
      else if (src[i] === '"') mode = 'double'
      else if (src[i] === '`') mode = 'template'
      out += src[i]
      i += 1
      continue
    }
    if (mode === 'line') {
      if (src[i] === '\n') {
        mode = 'code'
        out += '\n'
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (two === '*/') {
        mode = 'code'
        i += 2
        continue
      }
      if (src[i] === '\n') out += '\n'
      i += 1
      continue
    }
    if (src[i] === '\\') {
      out += src[i] + (src[i + 1] ?? '')
      i += 2
      continue
    }
    const closes =
      (mode === 'single' && src[i] === "'") ||
      (mode === 'double' && src[i] === '"') ||
      (mode === 'template' && src[i] === '`')
    out += src[i]
    if (closes) mode = 'code'
    i += 1
  }
  return out
}

/** Remove whole import statements, including multi-line ones. An import is how a
 *  module REACHES a symbol, not a place it assumes a principal — and counting it
 *  is what made the old number rise on every file split. */
export const stripImports = (src: string): string =>
  src.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, (m) => m.replace(/[^\n]/g, ''))

/** Usage sites for one vocabulary in one file. */
export const sitesIn = (file: string, src: string, symbol: string): Site[] => {
  const bare = stripImports(stripComments(src))
  const out: Site[] = []
  bare.split('\n').forEach((line, idx) => {
    if (new RegExp(`\\b${symbol}\\b`).test(line))
      out.push({ file, line: idx + 1, symbol, text: line.trim().slice(0, 100) })
  })
  return out
}

const walk = (dir: string, out: string[] = []): string[] => {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    // PATH-based test exclusion. The bug this replaces filtered on line CONTENT.
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.generated.ts')
    )
      out.push(full)
  }
  return out
}

export const census = (root = ROOT): Map<string, Site[]> => {
  const files = ROOTS.flatMap((r) => walk(join(root, r)))
  const bySymbol = new Map<string, Site[]>()
  for (const vocab of VOCABULARIES) bySymbol.set(vocab.symbol, [])
  for (const full of files) {
    const src = readFileSync(full, 'utf8')
    const rel = relative(root, full)
    for (const vocab of VOCABULARIES) {
      if (!src.includes(vocab.symbol)) continue
      bySymbol.get(vocab.symbol)?.push(...sitesIn(rel, src, vocab.symbol))
    }
  }
  return bySymbol
}

/**
 * THE BASELINE. Usage sites, not lines. Update it only with a stated reason —
 * a rise means a new place assumes a principal, which is the thing the Phase 4
 * gate cares about and the thing a file split can no longer fake.
 */
export const BASELINE: Readonly<Record<string, number>> = {
  /**
   * 38 usage sites (POD-3903). LOWERED FROM 42, re-measured on the PDM-107 epic
   * branch at e9820be79. The 42 was accurate when A2 set it at e7371f6d0; phase
   * B has been retiring sites since, and nobody lowered it on the way past.
   *
   * The -4 is a NET of twelve sites removed against eight added, so read the
   * movements rather than the delta:
   *
   *   REMOVED (-12, callers now resolve a member)
   *      -4  apps/daemon/.../fixtures/server-recovery-worker.ts
   *      -2  apps/server/src/modules/sessions/view.ts
   *      -2  apps/server/src/modules/superagent/service.ts
   *      -1  apps/server/src/modules/sessions/session-start.ts
   *      -1  apps/server/src/modules/sessions/session-authz.ts   (file has none left)
   *      -1  apps/server/src/modules/sessions/session.ts         (file has none left)
   *      -1  packages/janitor/src/janitor.ts                     (file has none left)
   *
   *   ADDED (+8, and none of them is a production caller defaulting a principal)
   *      +2  packages/model/src/identity/first-admin.ts   the accessor grew a
   *          store-taking overload beside the deprecated fixture one, so its own
   *          definition now spells itself three times instead of once
   *      +4  apps/server/src/test-support/{session-state-principal,session-facts,
   *          open-test-store}.ts   fixture helpers that prime the sole-human
   *          identity for tests
   *      +1  apps/server/src/modules/issues/service/crud.ts
   *      +1  apps/server/src/modules/messages/characterization-support.ts
   *
   * Three of the 38 are the accessor's own definition in
   * `packages/model/src/identity/first-admin.ts` (two overload signatures and the
   * implementation). They are left in rather than special-cased: the census counts
   * a spelling, and carving out the one file that may legitimately use it is the
   * kind of exception that later hides a second one.
   *
   * Six of the 38 are in `apps/server/src/relay.ts` (lines 930, 1642, 1727, 1987,
   * 2003, 2455) — PDM-295 observed the last three without touching them, and they
   * are still here.
   *
   * The journey to the original 41 is still the point:
   *   77  the hand grep everyone quoted (content filter dropped 2 lines)
   *   79  the same grep with the filter corrected to match PATH
   *   45  imports and comments stripped
   *   41  `*.generated.ts` excluded
   *
   * The last 4 were all in `migrations/drizzle-manifest.generated.ts`, inside
   * `--` SQL comments embedded in template strings — prose explaining why that
   * migration deliberately spells `'user:sole'` literally INSTEAD of importing
   * the constant. Counting an explanation of not-using-it as a use of it is the
   * same error as counting the import, one layer down.
   *
   * Generated files are excluded rather than special-cased: they are not
   * hand-authored, so an ambient principal appearing in one is a property of its
   * GENERATOR and should be audited there, where a human could fix it.
   */
  firstAdminMemberId: 38,
}

/**
 * THE RAISE LEDGER — every time `BASELINE` moved UP, or lost a key, with the
 * argument that made it acceptable.
 *
 * `from` is the value on the commit this branch started from. It cannot be
 * filled in without looking that value up, which is the entire mechanism: the
 * failure mode this guards is a hurried author under a red gate editing one
 * digit, and this makes the cheapest way out a paragraph naming what grew.
 *
 * Entries are kept after they land. They are inert once the base commit agrees
 * with the tree, and they are the record of how a gate that says "must not
 * rise" came to be at the number it is at.
 */
export const RAISE_AUTHORISATIONS: readonly RaiseAuthorisation[] = [
  {
    key: 'FIRST_ADMIN_USER_ID',
    from: 46,
    renamedTo: 'firstAdminMemberId',
    to: 42,
    issue: 'POD-3904',
    reason:
      'A2 retired the `FIRST_ADMIN_USER_ID` constant in favour of the `firstAdminMemberId()` accessor (65be6da71), and the baseline key was renamed with it. The sites are the same sites — a rename moves none — and the count FELL 46 -> 42 in the same work, because three sites in `server.ts` and one in `auth-route.ts` now resolve the earliest admin member out of the store instead of defaulting to a compiled-in id. Recorded rather than passed over because a rename that carries a value across is how a baseline loses its history, and this instrument now refuses one that is not argued for.',
  },
]

export const checkDrift = (
  counts: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>> = BASELINE,
): Finding[] => {
  const findings: Finding[] = []
  for (const vocab of VOCABULARIES) {
    if (!vocab.enforced) continue
    const expected = baseline[vocab.symbol]
    if (expected === undefined) continue
    const actual = counts[vocab.symbol] ?? 0
    if (actual > expected)
      findings.push({
        check: 'ambient-principal-added',
        where: vocab.symbol,
        detail: `${actual} usage sites, baseline ${expected} (+${actual - expected}). A site was ADDED: somewhere now assumes the sole account instead of resolving the caller. Note this counts USAGE, not lines — moving code between files cannot cause this.`,
      })
    if (actual < expected)
      findings.push({
        check: 'ambient-principal-baseline-stale',
        where: vocab.symbol,
        detail: `${actual} usage sites, baseline ${expected} (${actual - expected}). Sites were removed, which is good — lower the baseline in the same commit so the next rise is measured from here.`,
      })
  }
  return findings
}

export const countsOf = (c: Map<string, Site[]>): Record<string, number> =>
  Object.fromEntries([...c.entries()].map(([k, v]) => [k, v.length]))

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export const probe = (): Finding[] => {
  const broken: Finding[] = []
  const expect = (check: string, dirty: Finding[], clean: Finding[]) => {
    if (!dirty.some((f) => f.check === check))
      broken.push({ check, where: '<probe>', detail: 'missed its planted violation' })
    if (clean.length > 0)
      broken.push({ check, where: '<probe>', detail: `fired on the clean fixture` })
  }

  expect(
    'ambient-principal-added',
    checkDrift({ firstAdminMemberId: 46 }, { firstAdminMemberId: 45 }),
    checkDrift({ firstAdminMemberId: 45 }, { firstAdminMemberId: 45 }),
  )
  expect(
    'ambient-principal-baseline-stale',
    checkDrift({ firstAdminMemberId: 44 }, { firstAdminMemberId: 45 }),
    checkDrift({ firstAdminMemberId: 45 }, { firstAdminMemberId: 45 }),
  )

  // THE RAISE CHECK, planted both ways. `probe()` proving the DRIFT checks can
  // fire is what POD-3903 pointed out says nothing about the baseline's own
  // direction of travel, so the new checks get the same treatment — and the
  // clean fixture for each is the authorised form, not an empty one, so a
  // rubber-stamp authorisation would show up as a probe that never fires.
  const raiseArgs = (over: Partial<Parameters<typeof checkRaise>[0]>) =>
    checkRaise({
      instrument: '<probe>',
      current: { seats: 46 },
      base: { seats: 41 },
      authorisations: [],
      enforced: ['seats'],
      how: '<probe>',
      requireBase: false,
      ...over,
    })
  const authorised: RaiseAuthorisation = {
    key: 'seats',
    from: 41,
    to: 46,
    issue: 'POD-0000',
    reason: 'a probe fixture reason long enough to clear the minimum length the check requires',
  }
  expect(
    'baseline-raised-without-authorisation',
    raiseArgs({}),
    raiseArgs({ authorisations: [authorised] }),
  )
  expect(
    'baseline-key-disappeared',
    raiseArgs({ current: { chairs: 41 } }),
    raiseArgs({
      current: { chairs: 41 },
      authorisations: [{ ...authorised, from: 41, to: 41, renamedTo: 'chairs' }],
    }),
  )
  expect(
    'baseline-enforcement-dropped',
    raiseArgs({ current: { seats: 41 }, enforced: [] }),
    raiseArgs({ current: { seats: 41 } }),
  )
  expect(
    'baseline-base-unavailable',
    raiseArgs({ base: null, requireBase: true }),
    raiseArgs({ base: null, requireBase: false }),
  )

  // A raise authorised at the WRONG `from` must not pass: the number an author
  // has to look up is the only part of the record they cannot write from memory.
  if (raiseArgs({ authorisations: [{ ...authorised, from: 45 }] }).length === 0)
    broken.push({
      check: 'baseline-raise-from-must-match',
      where: '<probe>',
      detail: 'an authorisation naming the wrong previous value was accepted',
    })
  if (raiseArgs({ authorisations: [{ ...authorised, reason: 'because' }] }).length === 0)
    broken.push({
      check: 'baseline-raise-reason-required',
      where: '<probe>',
      detail: 'an authorisation with a one-word reason was accepted',
    })

  // The measurement itself must discriminate, or the count is meaningless.
  const fixture = [
    "import { firstAdminMemberId } from '@podium/model'",
    '// firstAdminMemberId in a line comment',
    '/* firstAdminMemberId in a block comment */',
    'const a = firstAdminMemberId()',
    'function f() { return firstAdminMemberId() }',
  ].join('\n')
  const seen = sitesIn('probe.ts', fixture, 'firstAdminMemberId')
  if (seen.length !== 2)
    broken.push({
      check: 'measure-usage-sites',
      where: '<probe>',
      detail: `counted ${seen.length} usage sites in a fixture with exactly 2 (an import, a line comment and a block comment must NOT count)`,
    })

  // Multi-line imports are the form that made the old grep wrong.
  const multiline = [
    'import {',
    '  computePriorities,',
    '  firstAdminMemberId,',
    "} from '@podium/model'",
    'const b = firstAdminMemberId()',
  ].join('\n')
  const seen2 = sitesIn('probe.ts', multiline, 'firstAdminMemberId')
  if (seen2.length !== 1)
    broken.push({
      check: 'measure-multiline-import',
      where: '<probe>',
      detail: `counted ${seen2.length} usage sites where a multi-line import plus one real use should give 1`,
    })

  return broken
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const wants = (f: string) => process.argv.includes(f)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('ambient-principal census: THE INSTRUMENT IS BROKEN:')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe'))
    console.log('ambient-principal census: every check found its planted fixture')

  const c = census()
  const counts = countsOf(c)

  if (wants('--sites')) {
    for (const vocab of VOCABULARIES) {
      const sites = c.get(vocab.symbol) ?? []
      console.log(
        `\n${vocab.symbol}: ${sites.length} usage sites${vocab.enforced ? '' : '  (reported, not enforced)'}`,
      )
      const byFile = new Map<string, Site[]>()
      for (const s of sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s])
      for (const [file, fs] of [...byFile.entries()].sort())
        console.log(`  ${String(fs.length).padStart(3)}  ${file}`)
    }
    process.exit(0)
  }

  // THE BASELINE ITSELF, against the commit this branch started from. Reported
  // on every run rather than only in CI: an instrument whose second half only
  // exists in a workflow file is one nobody develops against.
  const raise = checkRaiseAgainstBase({
    instrument: 'audit-ambient-principals',
    relativePath: 'scripts/audit-ambient-principals.ts',
    exportName: 'BASELINE',
    current: BASELINE,
    authorisations: RAISE_AUTHORISATIONS,
    enforced: VOCABULARIES.filter((v) => v.enforced).map((v) => v.symbol),
    requireBase: wants('--require-base'),
  })

  const findings = [...checkDrift(counts), ...raise.findings]
  if (wants('--json')) {
    console.log(
      JSON.stringify(
        { counts, baseline: BASELINE, base: raise.base, baseSource: raise.how, findings },
        null,
        2,
      ),
    )
  } else {
    for (const vocab of VOCABULARIES) {
      const n = counts[vocab.symbol] ?? 0
      const tag = vocab.enforced ? `baseline ${BASELINE[vocab.symbol] ?? '—'}` : 'reported only'
      console.log(`${vocab.symbol}: ${n} usage sites  (${tag})`)
    }
    console.log(`baseline compared against: ${raise.how}`)
    if (findings.length === 0)
      console.log('\nambient-principal census: no drift, and no unargued raise')
    else {
      console.error('')
      for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    }
  }
  process.exit(findings.length === 0 ? 0 : 1)
}
