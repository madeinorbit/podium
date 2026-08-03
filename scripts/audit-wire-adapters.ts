#!/usr/bin/env bun
/**
 * THE EXPIRY GATE for concrete wire adapters (POD-308).
 *
 *   bun run audit:wire-adapters           # the gate — exit 1 on any finding
 *   bun run audit:wire-adapters --json
 *   bun run audit:wire-adapters --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * POD-308 ships two things that are easy to confuse: a PERMANENT version-
 * negotiation mechanism, and a TEMPORARY concrete adapter that translates the
 * pre-rewrite wire. The second is the kind of code that survives by default —
 * everything keeps working while it exists, so nothing ever forces the
 * conversation about deleting it. POD-1077's `DeviceGradeUnscopedPolicy` is the
 * pattern this copies: an honestly-named placeholder held to a small allowlist
 * by a gate, so that when its condition arrives every site is FORCED to name a
 * real answer instead of quietly inheriting the placeholder for another year.
 *
 * A legacy adapter with a date in a docstring is a comment. One with a gate
 * counting its call sites is a scheduled deletion.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE SOURCE-TEXT HALF ONLY, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * This file resolves no modules: it reads source text, so it can say "nothing
 * imports X" — a claim a runtime check cannot make, because a module that is
 * never loaded looks exactly like one that does not exist. POD-732's line is the
 * standard: *an empty router satisfies every absence claim perfectly*. So the
 * PRESENCE half — the shipped registry really does hold a v1 adapter, really
 * does refuse a permanent one, really does report nothing expired — lives in
 * `scripts/audit-wire-adapters.test.ts`, which resolves the real objects under
 * vitest. Neither half is sufficient; both are cheap.
 *
 * `--probe` plants fixtures that MUST fail each check, and fails if any check
 * sails past its own planted violation. A gate that cannot say YES to a real
 * violation is not evidence when it says NO.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** The adapter file, and the ONLY sites allowed to name it. Anything else is a
 *  new dependency on a translation that is scheduled for deletion, and it must
 *  be argued for rather than merged. */
const ADAPTER_FILE = 'apps/server/src/gateway/legacy-wire-v1-adapter.ts'
const ALLOWED_CALLERS = [
  // The one registration. Deleting the adapter deletes this line.
  'apps/server/src/gateway/wire-feed-edge.ts',
  // Its own tests, and this gate's running-object half.
  'apps/server/src/gateway/wire-feed-edge.test.ts',
  'scripts/audit-wire-adapters.ts',
  'scripts/audit-wire-adapters.test.ts',
]
const VERSION_FILE = 'packages/protocol/src/version.ts'

export interface Finding {
  check: string
  where: string
  detail: string
}

export interface AuditInput {
  /** Absolute-ish repo-relative reader, injected so `--probe` can plant text. */
  read(path: string): string | null
  /** Every repo-relative source path to scan for call sites. */
  sources(): string[]
}

const MIN_SUPPORTED_RE = /export const MIN_SUPPORTED_VERSION\s*=\s*(\d+)/
const EXPIRES_RE = /expiresWhenMinSupportedReaches:\s*(\d+)/
const PERMANENT_LEGACY_RE = /expiry\s*[:=]\s*null/

export function runChecks(input: AuditInput): Finding[] {
  const findings: Finding[] = []
  const versionSource = input.read(VERSION_FILE)
  const adapterSource = input.read(ADAPTER_FILE)

  const min = Number(versionSource?.match(MIN_SUPPORTED_RE)?.[1] ?? Number.NaN)
  if (!Number.isInteger(min)) {
    findings.push({
      check: 'min-supported-readable',
      where: VERSION_FILE,
      detail:
        'could not read MIN_SUPPORTED_VERSION. Every other check here is relative to the support ' +
        'floor, so an unreadable floor is a broken gate, not a pass.',
    })
    return findings
  }

  if (adapterSource === null) {
    // The adapter is GONE. That is the successful end state, and the only thing
    // left to check is that the floor was raised with it — an adapter deleted
    // while the window still advertises v1 leaves peers accepted and unserved.
    if (min < 2) {
      findings.push({
        check: 'floor-follows-deletion',
        where: VERSION_FILE,
        detail:
          `${ADAPTER_FILE} is gone but MIN_SUPPORTED_VERSION is still ${min}. The window still ` +
          'advertises wire 1 with nothing to serve it. Raise the floor to 2.',
      })
    }
    return findings
  }

  const expiresAt = Number(adapterSource.match(EXPIRES_RE)?.[1] ?? Number.NaN)
  if (!Number.isInteger(expiresAt)) {
    findings.push({
      check: 'expiry-is-mechanical',
      where: ADAPTER_FILE,
      detail:
        'no `expiresWhenMinSupportedReaches` found. A legacy adapter must carry a MECHANICAL ' +
        'expiry condition — a date in a docstring is satisfied by nobody reading it.',
    })
  } else if (min >= expiresAt) {
    findings.push({
      check: 'expired-adapter-still-present',
      where: ADAPTER_FILE,
      detail:
        `MIN_SUPPORTED_VERSION is ${min} and this adapter expires at ${expiresAt}: its condition ` +
        'has ARRIVED. Delete the file, its registration, its tests, this gate’s entry for it, and ' +
        'the `legacy-wire-v1-adapter` ratchet item. Do not disable it — a disabled translation is ' +
        'the placeholder this gate exists to stop.',
    })
  }

  if (PERMANENT_LEGACY_RE.test(adapterSource)) {
    findings.push({
      check: 'legacy-adapter-not-permanent',
      where: ADAPTER_FILE,
      detail:
        'this adapter declares `expiry: null`, which means PERMANENT. The MECHANISM is permanent; ' +
        'a translator for a version the server is migrating away from is not.',
    })
  }

  // THE DETECTOR MUST PROVE IT CAN STILL MATCH (POD-309's ZERO_BY_DESIGN move,
  // applied to the other half of the same rule).
  //
  // The allowlist scan below reports a finding when someone adds a call site.
  // Its silent failure is the mirror of an unearned zero: if either pattern ever
  // stops matching — a rename, a regex edit, an import style this does not
  // cover — the loop finds nothing and the gate says OK, which is exactly what
  // it says when the tree is genuinely clean. Those two must not be spelled the
  // same way.
  //
  // So the patterns are run against sites that are KNOWN to contain what they
  // look for, and a miss THROWS rather than passing. A throw cannot be mistaken
  // for a clean tree; a zero can.
  const controls: { path: string; pattern: RegExp; what: string }[] = [
    { path: ADAPTER_FILE, pattern: /\bLegacyWireV1Adapter\b/, what: 'the exported class name' },
    {
      path: 'apps/server/src/gateway/wire-feed-edge.ts',
      pattern: /from\s+['"][^'"]*legacy-wire-v1-adapter(?:\.ts)?['"]/,
      what: 'the one registration import',
    },
  ]
  for (const control of controls) {
    const source = input.read(control.path)
    if (source === null || !control.pattern.test(source)) {
      throw new Error(
        `wire-adapter audit: the call-site detector no longer matches ${control.what} in ` +
          `${control.path}. Every "no unexpected call sites" result below would be a zero this ` +
          'detector has not earned — indistinguishable from a clean tree. Fix the pattern (or the ' +
          'control, if the code legitimately moved) before trusting any result from this gate.',
      )
    }
  }

  // A REFERENCE, not a mention. The first version of this check matched the
  // adapter's path anywhere in a file, and `--probe` immediately caught it
  // flagging `version.ts` for naming the file in a docstring — a prose mention
  // is not a dependency, and a gate that cannot tell them apart trains people to
  // ignore it. Matched: an import of the module, or the exported identifier.
  const IMPORTS_ADAPTER = /from\s+['"][^'"]*legacy-wire-v1-adapter(?:\.ts)?['"]/
  const NAMES_ADAPTER = /\bLegacyWireV1Adapter\b/
  for (const path of input.sources()) {
    if (path === ADAPTER_FILE || ALLOWED_CALLERS.includes(path)) continue
    const source = input.read(path)
    if (source === null) continue
    if (IMPORTS_ADAPTER.test(source) || NAMES_ADAPTER.test(source)) {
      findings.push({
        check: 'call-sites-allowlisted',
        where: path,
        detail:
          'names the legacy v1 adapter from outside the allowlist. Every site that depends on a ' +
          'scheduled deletion is one more site that must be rewritten on the day it happens — ' +
          `which is the cost this allowlist keeps visible. Allowed: ${ALLOWED_CALLERS.join(', ')}.`,
      })
    }
  }

  return findings
}

/**
 * Run one probe fixture and report WHAT HAPPENED, with a throw as an outcome
 * rather than a crash.
 *
 * Exported and used by BOTH the `--probe` CLI and `audit-wire-adapters.test.ts`,
 * so the demonstration that each check fires on its own planted violation lives
 * in the committed test lane and not in whichever terminal last ran it. POD-309
 * paid for that distinction: a guard demonstrated only by a hand-run mutant is
 * zero guards the moment the session ends, and its `git checkout --` cleanup ate
 * the guard along with the mutant.
 */
export function outcomesOf(input: AuditInput): string[] {
  try {
    return runChecks(input).map((finding) => finding.check)
  } catch {
    return ['detector-throws']
  }
}

// ---------------------------------------------------------------------------
// I/O + probe
// ---------------------------------------------------------------------------

const realInput = (): AuditInput => ({
  read: (path) => {
    try {
      return readFileSync(join(ROOT, path), 'utf8')
    } catch {
      return null
    }
  },
  sources: () => {
    const out = new Set<string>()
    for (const root of ['apps', 'packages', 'scripts']) {
      const listed = Bun.spawnSync([
        'git',
        'ls-files',
        '--',
        `${root}/**/*.ts`,
        `${root}/**/*.tsx`,
      ], { cwd: ROOT })
      for (const line of new TextDecoder().decode(listed.stdout).split('\n')) {
        if (line.trim() !== '') out.add(line.trim())
      }
    }
    return [...out]
  },
})

/**
 * Planted violations, one per check. Each must produce its OWN check's finding —
 * a fixture that fails some other check would let the intended one rot.
 */
export const PROBES: { name: string; input: AuditInput; expect: string }[] = (() => {
  const base = realInput()
  const overlay = (files: Record<string, string | null>, extraSources: string[] = []): AuditInput => ({
    read: (path) => {
      if (!Object.hasOwn(files, path)) return base.read(path)
      // An overlaid key maps to the file's content, or to null for "deleted".
      return files[path] ?? null
    },
    sources: () => [...base.sources(), ...extraSources],
  })
  const adapter = base.read(ADAPTER_FILE) ?? ''
  return [
    {
      name: 'expired adapter still present',
      expect: 'expired-adapter-still-present',
      input: overlay({ [VERSION_FILE]: 'export const MIN_SUPPORTED_VERSION = 2\n' }),
    },
    {
      name: 'expiry is only a docstring',
      expect: 'expiry-is-mechanical',
      input: overlay({ [ADAPTER_FILE]: adapter.replace(/expiresWhenMinSupportedReaches:\s*\d+/g, 'deleteAfter: "some friday"') }),
    },
    {
      name: 'legacy adapter declares itself permanent',
      expect: 'legacy-adapter-not-permanent',
      input: overlay({
        [ADAPTER_FILE]: `${adapter}\nexport const sneaky = { expiry: null }\n`,
      }),
    },
    {
      name: 'a new call site appears outside the allowlist',
      expect: 'call-sites-allowlisted',
      input: overlay(
        { 'apps/server/src/some-new-feature.ts': 'import { LegacyWireV1Adapter } from "./x"' },
        ['apps/server/src/some-new-feature.ts'],
      ),
    },
    {
      // The mirror of POD-309's control-string guard: break the thing the
      // detector keys on and the gate must THROW, never quietly report zero
      // call sites — which is what it also reports when the tree is clean.
      name: 'the call-site detector stops matching its control',
      expect: 'detector-throws',
      input: overlay({
        [ADAPTER_FILE]: (adapter ?? '').replace(/LegacyWireV1Adapter/g, 'RenamedAdapter'),
      }),
    },
    {
      // The SECOND control, broken on its own. Two controls that only ever fail
      // together would be one control wearing two names — and the registration
      // import is the half most likely to move (a barrel file, a rename), which
      // is exactly why it is checked separately.
      name: 'the registration-import control stops matching',
      expect: 'detector-throws',
      input: overlay({
        'apps/server/src/gateway/wire-feed-edge.ts': '// the registration moved somewhere else\n',
      }),
    },
    {
      name: 'adapter deleted but the floor was not raised',
      expect: 'floor-follows-deletion',
      input: overlay({ [ADAPTER_FILE]: null }),
    },
  ]
})()

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))

  if (args.has('--probe')) {
    let bad = 0
    for (const probe of PROBES) {
      const found = outcomesOf(probe.input)
      const ok = found.includes(probe.expect)
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${probe.name} → expected ${probe.expect}, got [${found}]`)
      if (!ok) bad++
    }
    // And the clean tree must be SPARED, or "every probe fires" is satisfied by
    // a gate that reports everything.
    const clean = runChecks(realInput())
    if (clean.length > 0) {
      console.log(`FAIL  the real tree should be clean, got ${clean.length} finding(s)`)
      bad++
    } else {
      console.log('PASS  the real tree is spared')
    }
    if (bad > 0) {
      console.error(`\nwire-adapter audit: ${bad} probe(s) could not say YES — the gate is not evidence`)
      process.exit(1)
    }
    console.log('\nwire-adapter audit: every check fired on its planted violation and spared the clean tree')
    process.exit(0)
  }

  const findings = runChecks(realInput())
  if (args.has('--json')) {
    console.log(JSON.stringify({ findings }, null, 2))
  } else {
    for (const finding of findings) {
      console.error(`${finding.check}\n  ${finding.where}\n  ${finding.detail}\n`)
    }
  }
  if (findings.length > 0) {
    console.error(`wire-adapter audit: ${findings.length} finding(s)`)
    process.exit(1)
  }
  console.log(
    'wire-adapter audit OK — the legacy v1 adapter carries a mechanical expiry that has not ' +
      'arrived, declares no permanence, and is named only from its allowlist ' +
      '(the running-object half is scripts/audit-wire-adapters.test.ts)',
  )
}
