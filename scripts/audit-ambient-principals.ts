/**
 * THE AMBIENT-PRINCIPAL CENSUS — POD-1385, replacing a hand grep that was wrong
 * three separate ways.
 *
 * Run:
 *   bun run audit:ambient-principals            # census + verdict, exit 1 on drift
 *   bun run audit:ambient-principals --json
 *   bun run audit:ambient-principals --sites    # every site, grouped by file
 *   bun run audit:ambient-principals --probe    # prove every check can say YES
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
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    symbol: 'FIRST_ADMIN_USER_ID',
    enforced: true,
    note: 'The Phase 4 gate constraint. A site here is code assuming the sole account rather than resolving the caller.',
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
   * 46 usage sites (POD-1669). RAISED FROM 41, and the five are named below —
   * a baseline bumped without naming its sites is how this gate went invisible.
   *
   * The +5 is a NET of ten added sites against five removed. Diffing the census
   * at e635e9b77 (where 41 was set) against the current tree, by file:
   *
   *   REMOVED (-5, real reductions, callers now resolved)
   *      -1  apps/server/src/auth-route.ts
   *      -2  apps/server/src/modules/messages/characterization-support.ts
   *      -2  packages/model/src/authz/issue-authz.ts
   *
   *   MOVED (net 0 — `sessions/lifecycle.ts` decomposed, as this instrument was
   *   built to tolerate)
   *      -4  apps/server/src/modules/sessions/lifecycle.ts
   *      +2  apps/server/src/modules/sessions/session-start.ts
   *      +1  apps/server/src/modules/sessions/session-revival.ts
   *      +1  apps/server/src/modules/sessions/session-authz.ts
   *
   *   ADDED (+10, every one judged for whether a caller exists to resolve)
   *      +7  apps/server/src/instance-password-migration.ts — POD-1554's one-shot
   *          that moves `auth.json`'s hash into the first admin's credential row.
   *          NO CALLER EXISTS: it runs at boot, before the server can serve a
   *          login, and the account it targets is by definition the first admin
   *          of a pre-multi-user instance. Permanent and correct.
   *      +2  apps/server/src/test-support/capabilities.ts — the `OPERATOR`
   *          fixture, moved out of `packages/model` by POD-333 precisely because
   *          no production caller reads it. NO CALLER EXISTS: it is a test
   *          capability shape, not a runtime principal resolution.
   *      +1  packages/runtime/src/session-mint.ts — the break-glass mint.
   *          NO CALLER EXISTS BY CONSTRUCTION: authority comes from state-dir
   *          write access, not an authenticated request. This is the accepted
   *          ADR 3 D14 violation POD-1636 owns; the mint already refuses when
   *          the instance holds more than one account. NOT this issue's to move.
   *
   * None of the ten can resolve a caller, so none is droppable today. What the
   * gate now protects is that the ELEVENTH must argue for itself.
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
  FIRST_ADMIN_USER_ID: 46,
}

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
    checkDrift({ FIRST_ADMIN_USER_ID: 46 }, { FIRST_ADMIN_USER_ID: 45 }),
    checkDrift({ FIRST_ADMIN_USER_ID: 45 }, { FIRST_ADMIN_USER_ID: 45 }),
  )
  expect(
    'ambient-principal-baseline-stale',
    checkDrift({ FIRST_ADMIN_USER_ID: 44 }, { FIRST_ADMIN_USER_ID: 45 }),
    checkDrift({ FIRST_ADMIN_USER_ID: 45 }, { FIRST_ADMIN_USER_ID: 45 }),
  )

  // The measurement itself must discriminate, or the count is meaningless.
  const fixture = [
    "import { FIRST_ADMIN_USER_ID } from '@podium/model'",
    '// FIRST_ADMIN_USER_ID in a line comment',
    '/* FIRST_ADMIN_USER_ID in a block comment */',
    'const a = FIRST_ADMIN_USER_ID',
    'function f() { return FIRST_ADMIN_USER_ID }',
  ].join('\n')
  const seen = sitesIn('probe.ts', fixture, 'FIRST_ADMIN_USER_ID')
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
    '  FIRST_ADMIN_USER_ID,',
    "} from '@podium/model'",
    'const b = FIRST_ADMIN_USER_ID',
  ].join('\n')
  const seen2 = sitesIn('probe.ts', multiline, 'FIRST_ADMIN_USER_ID')
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

  const findings = checkDrift(counts)
  if (wants('--json')) {
    console.log(JSON.stringify({ counts, baseline: BASELINE, findings }, null, 2))
  } else {
    for (const vocab of VOCABULARIES) {
      const n = counts[vocab.symbol] ?? 0
      const tag = vocab.enforced ? `baseline ${BASELINE[vocab.symbol] ?? '—'}` : 'reported only'
      console.log(`${vocab.symbol}: ${n} usage sites  (${tag})`)
    }
    if (findings.length === 0) console.log('\nambient-principal census: no drift')
    else {
      console.error('')
      for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    }
  }
  process.exit(findings.length === 0 ? 0 : 1)
}
