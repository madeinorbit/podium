#!/usr/bin/env bun
/**
 * THE ONE-SERVING-PATH GATE (POD-1203).
 *
 *   bun run audit:serving-path           # the gate — exit 1 on any finding
 *   bun run audit:serving-path --json
 *   bun run audit:serving-path --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * The cutover deleted a SECOND way to serve entity state: `publishComputed` /
 * `fanOutSnapshot`, and the thirteen call sites where five features each rebuilt
 * their own full list. Nothing about that deletion is self-sustaining. The next
 * person who needs a client to see something NOW, and finds the feed's coalescing
 * inconvenient, will add one line that sends a list — and it will work, and it
 * will be a second read path again, and the two will agree until the day they do
 * not.
 *
 * So the ratchet is not "the two method names are gone" (a rename defeats that).
 * It is: the five pre-cutover full-list MESSAGE SHAPES may be constructed only by
 * the expiring v1 translation and the prepared-publication worker, both named
 * below with the reason they are exempt.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE SOURCE-TEXT HALF ONLY, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * This file resolves no modules: it reads text, so it can say "nothing
 * constructs X" — a claim a runtime check cannot make, because a module that is
 * never loaded looks exactly like one that does not exist. POD-732's line is the
 * standard: *an empty router satisfies every absence claim perfectly*. The
 * PRESENCE half — the shipped funnel really does have one tail, the shipped
 * sessions service really has no snapshot fan-out, a real edge really does serve
 * a v1 peer from the feed — lives in `scripts/audit-serving-path.test.ts`, which
 * inspects the running objects. Neither half is sufficient; both are cheap.
 *
 * `--probe` plants fixtures that MUST fail each check.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const FUNNEL_FILE = 'apps/server/src/modules/funnel.ts'
const MUX_FILE = 'apps/server/src/gateway/client-mux.ts'
const SERVING_FILE = 'apps/server/src/gateway/feed-serving.ts'
const ADAPTER_FILE = 'apps/server/src/gateway/legacy-wire-v1-adapter.ts'

/**
 * The five message shapes the pre-cutover serving path produced, and the ONLY
 * sites allowed to construct one.
 *
 *  - the v1 translation, which is where they are supposed to be built and which
 *    EXPIRES (`scripts/audit-wire-adapters.ts` owns that condition);
 *  - the prepared-publication worker and the service method that drives it. That
 *    path serves a SCOPED connection its own filtered session view, it predates
 *    the feed, and POD-1203 deliberately did not rewrite it — the cutover
 *    preserved its entanglement rather than absorbing it. It is exempt because
 *    it is a different mechanism, not because it is grandfathered: when the
 *    scoped feed replaces it, these two entries go and this list is one line.
 */
const FULL_LIST_MESSAGES = [
  'sessionsChanged',
  'issuesChanged',
  'conversationsChanged',
  'automationsChanged',
  'automationRunsChanged',
] as const

const FULL_LIST_ALLOWED = [
  ADAPTER_FILE,
  'apps/server/src/modules/sessions/publish-worker-actor.ts',
  'apps/server/src/modules/sessions/publication/coordinator.ts',
]

/**
 * The two method names the deleted path had, matched AS CODE.
 *
 * `\bpublishComputed\b` alone flags every comment that explains the deletion —
 * measured, on the first run of this gate: eight files, all of them prose. A
 * mention is not a call, and a gate that cannot tell them apart trains people to
 * ignore it. So the pattern requires a call or a declaration (`(` or `:` after
 * the name) and comment lines are dropped before matching.
 *
 * A rename would defeat a check on these names alone, which is why the
 * message-shape check is the real ratchet and this is the cheap tripwire that
 * catches a literal revert.
 */
const DELETED_TAIL = /\b(?:publishComputed|fanOutSnapshot)\s*[(:]/

/** Source with comment-only lines removed. Block-comment bodies in this repo are
 *  written with a leading `*`, which is what makes this cheap and sufficient. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

export interface Finding {
  check: string
  where: string
  detail: string
}

export interface AuditInput {
  read(path: string): string | null
  sources(): string[]
}

/** `type: 'sessionsChanged'` — a CONSTRUCTION, not a mention. A comment naming
 *  the message, or a `msg.type === 'sessionsChanged'` comparison, is not a
 *  producer, and a gate that cannot tell them apart trains people to ignore it. */
const constructionOf = (message: string) => new RegExp(`type:\\s*'${message}'`)

export function runChecks(input: AuditInput): Finding[] {
  const findings: Finding[] = []

  // ---- 1. the deleted tail stays deleted --------------------------------
  for (const path of input.sources()) {
    if (!path.startsWith('apps/server/src/')) continue
    const source = input.read(path)
    if (source === null || !DELETED_TAIL.test(code(source))) continue
    findings.push({
      check: 'deleted-tail-stays-deleted',
      where: path,
      detail:
        'names `publishComputed` or `fanOutSnapshot`. Those were the second serving path: a ' +
        'full-list fan-out beside the feed, which could and did disagree with it. Serve through ' +
        'the feed (`gateway/feed-serving.ts`); a legacy client gets its lists from the v1 adapter.',
    })
  }

  // ---- 2. the five full-list shapes are the translation's alone ----------
  for (const path of input.sources()) {
    if (!path.startsWith('apps/server/src/')) continue
    // Tests construct these constantly — as EXPECTATIONS, which is the opposite
    // of a producer. Excluded by suffix rather than by allowlist so a new suite
    // does not have to be registered here to be written.
    if (path.endsWith('.test.ts')) continue
    if (FULL_LIST_ALLOWED.includes(path)) continue
    const source = input.read(path)
    if (source === null) continue
    for (const message of FULL_LIST_MESSAGES) {
      if (!constructionOf(message).test(code(source))) continue
      findings.push({
        check: 'full-list-messages-allowlisted',
        where: path,
        detail:
          `constructs a '${message}' message. The pre-cutover full-list shapes are produced ONLY ` +
          `by the expiring v1 translation (${ADAPTER_FILE}) and the prepared-publication worker. ` +
          'Building one anywhere else re-creates the dual read path POD-1203 deleted — it will ' +
          'work, and it will disagree with the feed the first time the two are computed from ' +
          'different state.',
      })
    }
  }

  // ---- 3. the serving edge is actually wired ----------------------------
  // A mechanism with no caller is "stopped short", not done. These are PRESENCE
  // checks and they are the half most likely to rot silently: deleting the two
  // lines in the mux leaves every other check here perfectly green.
  const mux = input.read(MUX_FILE)
  for (const [what, pattern] of [
    ['attach', /\bfeed\.attach\(/],
    ['detach', /\bfeed\.detach\(/],
    ['renegotiate at hello', /\bfeed\.renegotiate\(/],
  ] as const) {
    if (mux !== null && pattern.test(mux)) continue
    findings.push({
      check: 'serving-edge-is-wired',
      where: MUX_FILE,
      detail:
        `the client mux does not call the serving edge to ${what}. A connection that is never ` +
        'admitted to the feed is a connection served nothing — and every absence check in this ' +
        'gate would still pass, which is exactly why this is checked positively.',
    })
  }

  // ---- 4. the funnel has ONE tail ---------------------------------------
  const funnel = input.read(FUNNEL_FILE)
  if (funnel !== null && !/serving:\s*FeedServingPort/.test(funnel)) {
    findings.push({
      check: 'funnel-has-one-tail',
      where: FUNNEL_FILE,
      detail:
        'the write funnel no longer declares a single `serving` tail. Its dependency list is where ' +
        'a second fan-out would reappear first — that is how the deleted one was wired.',
    })
  }

  // ---- controls: a detector that stopped matching must THROW -------------
  //
  // Every check above reports a finding when something is WRONG, so its silent
  // failure mode is a zero it has not earned — indistinguishable from a clean
  // tree. Each control is a site KNOWN to contain what a detector looks for, and
  // a miss throws. A throw cannot be mistaken for a clean tree; a zero can.
  const controls: { path: string; pattern: RegExp; what: string }[] = [
    {
      path: ADAPTER_FILE,
      pattern: constructionOf('sessionsChanged'),
      what: 'the full-list construction pattern, against the translation that legitimately uses it',
    },
    {
      path: SERVING_FILE,
      pattern: /\bpublishTo\(/,
      what: 'the per-connection serve call, against the edge composition',
    },
  ]
  for (const control of controls) {
    const source = input.read(control.path)
    if (source === null || !control.pattern.test(code(source))) {
      throw new Error(
        `serving-path audit: the detector no longer matches ${control.what} in ${control.path}. ` +
          'Every "nothing constructs a full list" result here would be a zero this detector has ' +
          'not earned. Fix the pattern (or the control, if the code legitimately moved) before ' +
          'trusting any result from this gate.',
      )
    }
  }

  return findings
}

/** Run one probe fixture and report WHAT HAPPENED, a throw included as an
 *  outcome rather than a crash. Shared by `--probe` and the running-object test,
 *  so the demonstration lives in the committed lane and not in a terminal. */
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
    const listed = Bun.spawnSync(['git', 'ls-files', '--', 'apps/**/*.ts', 'packages/**/*.ts'], {
      cwd: ROOT,
    })
    return new TextDecoder()
      .decode(listed.stdout)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  },
})

/** Planted violations, one per check. Each must produce its OWN check's finding —
 *  a fixture that fails some other check would let the intended one rot. */
export const PROBES: { name: string; input: AuditInput; expect: string }[] = (() => {
  const base = realInput()
  const overlay = (
    files: Record<string, string | null>,
    extraSources: string[] = [],
  ): AuditInput => ({
    read: (path) => {
      if (!Object.hasOwn(files, path)) return base.read(path)
      // An overlaid key maps to the file's content, or to null for "deleted".
      return files[path] ?? null
    },
    sources: () => [...base.sources(), ...extraSources],
  })
  return [
    {
      name: 'a feature calls the deleted snapshot tail again',
      expect: 'deleted-tail-stays-deleted',
      input: overlay(
        { 'apps/server/src/modules/revived.ts': 'funnel.publishComputed(snapshot)\n' },
        ['apps/server/src/modules/revived.ts'],
      ),
    },
    {
      name: 'a feature builds a full list of its own',
      expect: 'full-list-messages-allowlisted',
      input: overlay(
        {
          'apps/server/src/modules/eager.ts':
            "send({ type: 'issuesChanged', issues: this.allWire() })\n",
        },
        ['apps/server/src/modules/eager.ts'],
      ),
    },
    {
      // The exemption must be NARROW: the worker's own file is allowed, a file
      // that merely sits beside it is not.
      name: 'a NEW file beside the allowed worker builds a session list',
      expect: 'full-list-messages-allowlisted',
      input: overlay(
        {
          'apps/server/src/modules/sessions/publish-worker-helper.ts':
            "return { type: 'sessionsChanged', sessions }\n",
        },
        ['apps/server/src/modules/sessions/publish-worker-helper.ts'],
      ),
    },
    {
      name: 'the mux stops admitting connections to the feed',
      expect: 'serving-edge-is-wired',
      input: overlay({ [MUX_FILE]: '// the gateway forgot the feed\n' }),
    },
    {
      name: 'the funnel grows a second tail',
      expect: 'funnel-has-one-tail',
      input: overlay({ [FUNNEL_FILE]: 'export class WriteFunnel {}\n' }),
    },
    {
      name: 'the full-list detector stops matching its control',
      expect: 'detector-throws',
      input: overlay({
        [ADAPTER_FILE]: (base.read(ADAPTER_FILE) ?? '').replace(/type: 'sessionsChanged'/g, 'x'),
      }),
    },
    {
      // The SECOND control, broken on its own: two controls that only ever fail
      // together would be one control wearing two names.
      name: 'the edge-composition control stops matching',
      expect: 'detector-throws',
      input: overlay({ [SERVING_FILE]: '// the composition moved\n' }),
    },
  ]
})()

if (import.meta.main) {
  const KNOWN_FLAGS = new Set(['--json', '--probe'])
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => !KNOWN_FLAGS.has(a))
  if (unknown.length > 0) {
    // Fails CLOSED on a typo: a misspelled flag that quietly runs the gate and
    // exits 0 is the worst outcome this tool can produce — it looks like it ran.
    console.error(`serving-path audit: unknown flag(s) ${unknown.join(', ')}`)
    process.exit(2)
  }

  if (args.includes('--probe')) {
    let bad = 0
    for (const probe of PROBES) {
      const found = outcomesOf(probe.input)
      const ok = found.includes(probe.expect)
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${probe.name} → expected ${probe.expect}, got [${found}]`,
      )
      if (!ok) bad++
    }
    // And the clean tree must be SPARED, or "every probe fires" is satisfied by
    // a gate that reports everything.
    const clean = runChecks(realInput())
    if (clean.length > 0) {
      console.log(`FAIL  the real tree should be clean, got ${clean.length} finding(s)`)
      for (const finding of clean) console.log(`      ${finding.check} — ${finding.where}`)
      bad++
    } else {
      console.log('PASS  the real tree is spared')
    }
    if (bad > 0) {
      console.error(
        `\nserving-path audit: ${bad} probe(s) could not say YES — the gate is not evidence`,
      )
      process.exit(1)
    }
    console.log('\nserving-path audit: every check can say YES, and the real tree is clean')
    process.exit(0)
  }

  const findings = runChecks(realInput())
  if (args.includes('--json')) console.log(JSON.stringify({ findings }, null, 2))
  else
    for (const finding of findings) {
      console.log(`${finding.check}\n  ${finding.where}\n  ${finding.detail}\n`)
    }
  if (findings.length > 0) {
    console.error(`serving-path audit: ${findings.length} finding(s)`)
    process.exit(1)
  }
  if (!args.includes('--json')) {
    console.log(
      'serving-path audit OK — one serving path, the five legacy list shapes confined to the ' +
        'expiring translation and the publication worker, and the edge is wired (the running-object ' +
        'half is scripts/audit-serving-path.test.ts)',
    )
  }
}
