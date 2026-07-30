/**
 * THE ARBITRATION-DIRECTION TRIPWIRE — ADR 1 D1 enforced rather than asserted.
 *
 * "Conflict arbitration code paths reference the annotations ONLY from
 * Authority-side code" (POD-304 acceptance criterion). The Replica applies an
 * order the Authority decided; it never merges, never invents LWW, and never
 * overrides a revision — and multi-user does not relax that, including for
 * `op-stream`.
 *
 * WHAT IS CHECKED: the import site. A file that imports the arbitration
 * surface can arbitrate, whether or not today's code does — so the detector
 * fires on the import, in the spirit of POD-387's capability-read tripwire.
 * Reading a matrix ROW is fine anywhere (a UI explaining "this is
 * admin-managed" is not arbitrating); reading the CONFLICT RULE is not.
 *
 * WHY THE DETECTOR IS UNIT-TESTED TOO: a scanner that reports zero violations
 * because it is looking in the wrong place is indistinguishable from a clean
 * repo. `describe('the detector itself')` plants violations in synthetic inputs
 * and requires each one to be caught, so the zero below is a measurement and
 * not an artefact.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** The reads that constitute arbitration. Deliberately NOT `MatrixRow` or the
 *  visibility resolvers — those are documentation and default-closed policy
 *  input, readable anywhere. */
export const ARBITRATION_SYMBOLS = [
  'conflictRuleFor',
  'requiresExpectedRevision',
  'permitsFieldLww',
  'FIELD_LWW_CLOCK',
] as const

/**
 * Paths whose code IS the Authority (or is the model/annotation home itself).
 * Anything else is a Replica, a client, or a transport — and none of those may
 * arbitrate.
 *
 * Expressed as prefixes with an explicit exclusion for the replica-side
 * subtrees of an otherwise Authority-side package, because `packages/sync`
 * holds BOTH the kernel and the replica/outbox: a prefix allowlist alone would
 * bless the replica by association.
 */
export const AUTHORITY_PREFIXES = [
  'apps/server/src',
  'packages/model/src/annotations',
  'packages/sync/src',
] as const

/** Replica-side subtrees that are NOT Authority even though their package is. */
export const REPLICA_EXCEPTIONS = [
  'packages/sync/src/replica',
  'packages/sync/src/outbox',
  'packages/sync/src/upstream',
] as const

export function isAuthoritySide(relPath: string): boolean {
  const p = relPath.split(sep).join('/')
  if (REPLICA_EXCEPTIONS.some((x) => p.startsWith(x))) return false
  return AUTHORITY_PREFIXES.some((prefix) => p.startsWith(prefix))
}

/** Does this file's SOURCE import the arbitration surface? Matches both the
 *  package specifier and the intra-package relative path, so moving the module
 *  cannot silently disable the check. */
export function importsArbitration(source: string): readonly string[] {
  const hits: string[] = []
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs
  for (const match of source.matchAll(importRe)) {
    const [, names = '', specifier = ''] = match
    const fromModel = specifier === '@podium/model' || /annotations\/arbitration$/.test(specifier)
    if (!fromModel) continue
    for (const symbol of ARBITRATION_SYMBOLS) {
      // Word-boundary match so `conflictRuleForDisplay` is not a false positive
      // and `conflictRuleFor as x` is not a false negative.
      if (new RegExp(`\\b${symbol}\\b`).test(names)) hits.push(symbol)
    }
  }
  return hits
}

export interface DirectionViolation {
  readonly file: string
  readonly symbols: readonly string[]
}

export function scan(
  files: readonly { readonly relPath: string; readonly source: string }[],
): readonly DirectionViolation[] {
  const out: DirectionViolation[] = []
  for (const file of files) {
    if (isAuthoritySide(file.relPath)) continue
    const symbols = importsArbitration(file.source)
    if (symbols.length > 0) out.push({ file: file.relPath, symbols })
  }
  return out
}

// ---------------------------------------------------------------------------
// Prove the detector fires BEFORE believing its zero
// ---------------------------------------------------------------------------

describe('the detector itself (deliberate-violation probes)', () => {
  const violation = (relPath: string, source: string) => scan([{ relPath, source }])

  it('catches a replica-side package importing the conflict rule', () => {
    expect(
      violation(
        'packages/client-core/src/replica/apply.ts',
        "import { conflictRuleFor } from '@podium/model'\n",
      ),
    ).toEqual([{ file: 'packages/client-core/src/replica/apply.ts', symbols: ['conflictRuleFor'] }])
  })

  it('catches the web client, the mobile client and the daemon', () => {
    for (const path of [
      'apps/web/src/features/issues/merge.ts',
      'apps/mobile/src/store.ts',
      'apps/daemon/src/mirror.ts',
    ]) {
      expect(violation(path, "import { permitsFieldLww } from '@podium/model'\n")).toHaveLength(1)
    }
  })

  it('catches the replica-side subtree of an Authority-side package', () => {
    // The case a prefix allowlist alone would MISS: packages/sync holds both the
    // kernel and the replica.
    expect(
      violation(
        'packages/sync/src/replica/store.ts',
        "import { FIELD_LWW_CLOCK } from '@podium/model'\n",
      ),
    ).toHaveLength(1)
    // ... while the kernel in the same package is allowed.
    expect(
      violation(
        'packages/sync/src/kernel/funnel.ts',
        "import { FIELD_LWW_CLOCK } from '@podium/model'\n",
      ),
    ).toEqual([])
  })

  it('catches a type-only import and an aliased import', () => {
    expect(
      violation(
        'apps/web/src/x.ts',
        "import type { ConflictRule, conflictRuleFor } from '@podium/model'\n",
      ),
    ).toHaveLength(1)
    expect(
      violation('apps/web/src/y.ts', "import { conflictRuleFor as decide } from '@podium/model'\n"),
    ).toHaveLength(1)
  })

  it('catches a multi-line import list', () => {
    expect(
      violation(
        'apps/web/src/z.ts',
        "import {\n  OWNERSHIP_MATRIX,\n  requiresExpectedRevision,\n} from '@podium/model'\n",
      ),
    ).toHaveLength(1)
  })

  it('catches the relative import path too, so moving the module cannot disable it', () => {
    expect(
      violation(
        'packages/client-core/src/a.ts',
        "import { conflictRuleFor } from '../annotations/arbitration'\n",
      ),
    ).toHaveLength(1)
  })

  it('does NOT flag reading a matrix row, a visibility class, or a lookalike name', () => {
    // Documentation reads are legitimate everywhere; a UI that says "this is
    // admin-managed" is not arbitrating. This is the false-positive counterfactual.
    for (const source of [
      "import { OWNERSHIP_MATRIX, visibilityClassOf } from '@podium/model'\n",
      "import { isTenantVisible, grantVerbsOf } from '@podium/model'\n",
      "import type { MatrixRow, ConflictRule } from '@podium/model'\n",
      "import { conflictRuleForDisplay } from './local-helper'\n",
      "import { SessionMeta } from '@podium/model'\n",
    ]) {
      expect(violation('apps/web/src/panel.tsx', source), source).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// The repo scan
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')
const ROOTS = ['apps', 'packages'] as const
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'build', 'coverage', '.git'])

function sourceFiles(): { relPath: string; source: string }[] {
  const out: { relPath: string; source: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      // `readFileSync` rather than a shell grep ON PURPOSE: a NUL byte makes
      // shell grep answer "no match" instead of erroring, which has silently
      // hidden whole files from sweeps on this branch before.
      out.push({ relPath: relative(REPO_ROOT, full), source: readFileSync(full, 'utf8') })
    }
  }
  for (const root of ROOTS) walk(join(REPO_ROOT, root))
  return out
}

describe('the repo obeys the direction', () => {
  const files = sourceFiles()

  it('scanned a plausible number of files (instrument check)', () => {
    // A zero-violation result over zero files is not evidence of anything.
    expect(files.length).toBeGreaterThan(500)
    // And the scan can actually SEE the arbitration module it is policing.
    expect(files.some((f) => f.relPath.endsWith('annotations/arbitration.ts'))).toBe(true)
  })

  it('has no replica-side, client-side or daemon-side arbitration reads', () => {
    const violations = scan(files)
    // Per-site output, not a total: a count tells a reviewer nothing about where.
    expect(violations.map((v) => `${v.file} → ${v.symbols.join(', ')}`)).toEqual([])
  })
})
