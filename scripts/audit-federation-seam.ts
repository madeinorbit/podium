/**
 * THE FEDERATION-SEAM AUDIT (POD-309, ADR 5 D8).
 *
 * Run:
 *   bun run audit:seam            # the gate — exit 1 on any finding
 *   bun run audit:seam --json
 *   bun run audit:seam --probe    # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHY A SEAM NEEDS A GATE AT ALL
 * ---------------------------------------------------------------------------
 *
 * POD-309 deletes half-built federation and PRESERVES the structure that keeps a future
 * hub possible ([spec:SP-0371]: the rewrite must not deliver hub/node federation AND
 * must not make choices that prevent one). Those two obligations fail in opposite
 * directions and neither failure is loud:
 *
 *   · the RETIREMENT rots by re-growth — a `new UpstreamForwarder(` reappearing, a
 *     `forwardIssueMutation` dep coming back with a well-meaning refactor;
 *   · the SEAM rots by ATTRITION — nobody deletes it, they just bake an assumption into
 *     it. A `bun:sqlite` import lands in `authority/`, `suite.ts` starts naming the one
 *     instantiation that exists, `ChangeProvenanceFields` loses `causationId` because
 *     nothing reads it today. Every one of those compiles, every one passes every test,
 *     and each makes a future hub a flag day.
 *
 * The deletion ratchet (`scripts/rearch-audit.ts`) covers the first direction and cannot
 * cover the second: a ratchet counts what is present and must go DOWN, so it is
 * structurally incapable of noticing something that vanished. Hence this file, whose
 * checks are mostly PRESENCE claims.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`, and what its refusing arm depends on
 * ---------------------------------------------------------------------------
 *
 * The failure this run keeps paying for is a gate whose refusing arm the test
 * environment can never produce. This audit is deliberately built so that it cannot
 * have one: every check is a pure function from SOURCE TEXT to findings, and the probe
 * feeds it text. There is no network, no build, no environment fact to arrange — the
 * only thing a check's refusal depends on is the string it was handed, and the probe
 * hands it a string containing the violation.
 *
 * The probe runs FIRST, always, even without the flag. A green gate whose zero could
 * only mean "the scan broke" is the audit's own worst failure mode
 * (docs/rearch-deletion-audit.md).
 *
 * NOTE ON OVERLAP WITH THE RUNTIME PROOF. This resolves no modules and reads text;
 * `packages/sync/src/authority/second-authority.seam.test.ts` constructs two real
 * Authorities and asserts what they DO. Neither is sufficient — POD-732's standard is
 * that "an empty router satisfies every absence claim perfectly", and its analogue here
 * is that a `packages/sync` deleted wholesale would pass every absence check in this
 * file. That is what checks 1–5 (presence) exist to refuse.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Finding {
  /** Which obligation failed — the ADR 5 D8 seam element or the retirement, in a token. */
  check: string
  /** Where, as `file:line` when a line is known. */
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

/** Every `.ts` under `rel`, recursively, repo-relative and posix-separated. */
function walk(rel: string): string[] {
  const out: string[] = []
  const abs = join(ROOT, rel)
  let entries: string[]
  try {
    entries = readdirSync(abs)
  } catch {
    return out
  }
  for (const name of entries) {
    const child = join(abs, name)
    if (statSync(child).isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue
      out.push(...walk(join(rel, name)))
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(relative(ROOT, child).split('\\').join('/'))
    }
  }
  return out
}

const isTestFile = (rel: string): boolean =>
  /\.(test|spec|browser\.e2e|e2e)\.tsx?$/.test(rel) ||
  rel.includes('/__fixtures__/') ||
  rel.endsWith('/test-support.ts') ||
  rel.endsWith('/test-doubles.ts') ||
  rel.endsWith('/test-plumbing.ts')

// ---------------------------------------------------------------------------
// S1 — authority / feed identity is nameable on every change
// ---------------------------------------------------------------------------

/**
 * ADR 5 D8 S1: "every durable change and command path can name which authority/feed
 * produced it". The shipped carrier is `FeedIdentity` — `feedId` PLUS `epoch`, because
 * ADR 2 D1's whole point is that a cursor without both is meaningless.
 *
 * Checked as three separate tokens rather than as "the file exists": a file that kept
 * its name and lost `epoch` is the exact attrition this check is for, and it is the one
 * a reviewer skimming a rename would wave through.
 */
export function feedIdentityPresent(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const token of ['interface FeedIdentity', 'readonly feedId', 'readonly epoch']) {
    if (!source.includes(token)) {
      findings.push({
        check: 'S1-feed-identity',
        where,
        detail: `'${token}' is gone. ADR 5 D8 S1 requires a durable change to be able to name the authority/feed that produced it; a cursor without (feedId, epoch) is meaningless (ADR 2 D1).`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// S2 — origin / causation / mutation identity on the envelope
// ---------------------------------------------------------------------------

/**
 * ADR 5 D8 S2. All three, and the ORDER of failure matters not at all — what matters is
 * that each is named individually. `causationId` is the one most likely to be dropped:
 * nothing in H1 reads it except overlay retirement, so "unused field" is a plausible
 * cleanup, and it is precisely the field a future hub needs for loop prevention.
 */
export function changeProvenancePresent(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const token of ['ChangeProvenanceFields', 'originId', 'causationId', 'mutationId']) {
    if (!source.includes(token)) {
      findings.push({
        check: 'S2-origin-causation',
        where,
        detail: `'${token}' is gone. ADR 5 D8 S2 requires origin, causation and mutation identity on the change envelope. H1 reads causationId only for overlay retirement, which is exactly why deleting it looks safe and is not.`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// S3 — the reserved node-peer surface stays reserved AND stays inert
// ---------------------------------------------------------------------------

/**
 * ADR 5 D4/D8 S3: the node role is declared and REFUSES. Both halves are checked,
 * because they fail in opposite directions — deleting the strategy loses the seam, and
 * making it return `ok: true` ships H2 by accident.
 */
export function nodeRoleReservedAndInert(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  if (!source.includes("role: 'node'")) {
    findings.push({
      check: 'S3-node-reserved',
      where,
      detail:
        "the reserved 'node' peer role is gone. ADR 5 D4 keeps it so a future node can declare itself without a flag day.",
    })
  }
  if (!source.includes("reason: 'role-not-implemented'")) {
    findings.push({
      check: 'S3-node-inert',
      where,
      detail:
        "the node strategy no longer refuses with 'role-not-implemented'. ADR 5 D4: H1 acceptors must ignore reserved caps — no auth elevation, no routing to unimplemented modules.",
    })
  }
  if (/\bok:\s*true\b/.test(source)) {
    findings.push({
      check: 'S3-node-inert',
      where,
      detail:
        'the reserved node strategy authenticates something. That is H2 product behaviour (POD-353), not a seam.',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// S4 — kernel ports carry no storage or transport assumption
// ---------------------------------------------------------------------------

/**
 * ADR 5 D8 S4: "Sync kernel depends on ports, not 'same machine', 'one SQLite file
 * path', or 'must be tRPC'."
 *
 * This overlaps `check-boundaries.ts` rule 11 on purpose and is not redundant with it:
 * rule 11 bans SQLite/Bun/DOM across `packages/sync/src` outside `adapters/`, which
 * catches the STORAGE half. The TRANSPORT half — a tRPC client, a WebSocket, a bare
 * `fetch` — is not a boundary violation and would pass rule 11 cleanly while baking
 * exactly the assumption D8 names.
 */
const TRANSPORT_TOKENS: readonly { token: RegExp; why: string }[] = [
  { token: /@trpc\//, why: 'a tRPC dependency in the kernel is D8 S4\'s "must be tRPC" verbatim' },
  { token: /\bnew WebSocket\b|from 'ws'/, why: 'a socket in the kernel binds it to one transport' },
  { token: /\bfetch\s*\(/, why: 'an HTTP call in the kernel binds it to one transport' },
  {
    token: /from 'node:(fs|net|http|https|dgram)'/,
    why: 'a host facility in the kernel binds it to one machine',
  },
]

export function kernelPortsAreNeutral(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  // Comments describe the retirement at length and legitimately name these words.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const { token, why } of TRANSPORT_TOKENS) {
    const m = token.exec(code)
    if (m) {
      findings.push({
        check: 'S4-kernel-ports-neutral',
        where: `${where}:${lineOf(code, m.index)}`,
        detail: `${m[0]} — ${why}. A second Authority instantiation must stay possible (D8 seam proof).`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// S5 — the conformance suite stays parameterized
// ---------------------------------------------------------------------------

/**
 * ADR 5 D8 S5: "Cross-hop tests written against roles + ports so a future node–hub
 * binding can run the same suite."
 *
 * The check is that `suite.ts` never NAMES the one instantiation that exists. A suite
 * that reaches for `inMemoryInstantiation` is still parameterized on paper — its
 * signature still takes an argument — while being unable to run against anything else,
 * and that is the failure mode `instantiation.ts` warns about in its own header
 * ("nothing in suite.ts may assume the in-memory one"). POD-309 supplies no new
 * instantiation of its own, deliberately: it DELETES a hop rather than adding one, and
 * inventing a fake second storage adapter to satisfy the letter of S5 would be a suite
 * certifying its own fixture.
 */
export function suiteStaysParameterized(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  if (!source.includes('SyncInstantiation')) {
    findings.push({
      check: 'S5-parameterized-suite',
      where,
      detail:
        'the suite no longer takes a SyncInstantiation. D8 S5 requires one suite runnable by a future node–hub hop unchanged.',
    })
  }
  const m = /\binMemoryInstantiation\b|from '\.\/in-memory'/.exec(source)
  if (m) {
    findings.push({
      check: 'S5-parameterized-suite',
      where: `${where}:${lineOf(source, m.index)}`,
      detail: `suite.ts names '${m[0]}'. Reaching for the one instantiation that exists makes the parameter decorative — a future hop could no longer run this suite unchanged.`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// R — the retirement holds
// ---------------------------------------------------------------------------

/**
 * The retired identifiers, as CODE rather than as prose. Every surviving mention in the
 * tree is a comment explaining what was removed, and those must stay legal — a
 * retirement that cannot be described is a retirement nobody can audit. So the scan runs
 * over comment-stripped source and keys on declaration/construction/usage forms.
 *
 * Enumerated by the FORM the concept can take rather than by the file it lived in:
 * `UpstreamForwarder` can come back as a class, as a `new`, or as a dependency named
 * `forwardIssueMutation` on somebody else's deps literal, and a detector that only knew
 * the first would report a serene zero for the third.
 */
const RETIRED_FORMS: readonly { pattern: RegExp; detail: string }[] = [
  {
    pattern: /\b(?:class|new)\s+Upstream(?:Sync|Forwarder|IssuesService)\b/,
    detail: 'the retired node⇄hub dialer / forwarder / issue mirror',
  },
  { pattern: /\bupstreamMirrorFor\b/, detail: 'the hub-mirror composition seam' },
  {
    pattern: /\bsetUpstream(?:Sessions|Conversations|Issues|Stale|OwnMachineIds)\s*\(/,
    detail: 'a hub-mirror apply path',
  },
  {
    pattern: /\bforwardIssueMutation\b|\bisUpstreamIssue\b|\bupstreamIssueRepoPaths\b/,
    detail: 'the issue write-forwarding seam',
  },
  { pattern: /\bissueWrite\s*\(/, detail: 'the retired per-mutation hub-forwarding wrapper' },
  { pattern: /\bmintUpstreamToken(?:Into)?\b/, detail: 'the hub-minted node token primitive' },
  {
    pattern:
      /\benqueueUpstreamMutation\b|\bbumpUpstreamMutationAttempts\b|\bdeleteUpstreamMutation\b/,
    detail: 'a WRITER of the archived upstream_outbox (ADR 5 D8 archives it read-only)',
  },
  { pattern: /\bconfig\.upstream\b/, detail: 'the retired upstream config key' },
]

export function retirementHolds(source: string, where: string): Finding[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const findings: Finding[] = []
  for (const { pattern, detail } of RETIRED_FORMS) {
    const m = pattern.exec(code)
    if (m) {
      findings.push({
        check: 'R-retirement-holds',
        where: `${where}:${lineOf(code, m.index)}`,
        detail: `'${m[0]}' — ${detail}. Federation is DEFERRED (POD-353), not in progress; re-growing it here is out of scope for every issue that is not POD-353.`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Kernel roles, per ADR 8's layering — everything under `packages/sync/src` that is
 *  not an `adapters/` implementation and not a test. */
const KERNEL_DIRS = [
  'packages/sync/src/authority',
  'packages/sync/src/replica',
  'packages/sync/src/outbox',
  'packages/sync/src/feed',
  'packages/sync/src/conformance',
]

/** Where a re-grown federation implementation could plausibly land. */
const RETIREMENT_ROOTS = ['apps', 'packages', 'scripts']

export function auditFederationSeam(): Finding[] {
  const findings: Finding[] = [
    ...feedIdentityPresent(
      read('packages/sync/src/feed/identity.ts'),
      'packages/sync/src/feed/identity.ts',
    ),
    ...changeProvenancePresent(
      read('packages/model/src/fields/change.ts'),
      'packages/model/src/fields/change.ts',
    ),
    ...nodeRoleReservedAndInert(
      read('packages/protocol/src/handshake/strategies/node-reserved.ts'),
      'packages/protocol/src/handshake/strategies/node-reserved.ts',
    ),
    ...suiteStaysParameterized(
      read('packages/sync/src/conformance/suite.ts'),
      'packages/sync/src/conformance/suite.ts',
    ),
  ]
  for (const dir of KERNEL_DIRS) {
    for (const file of walk(dir)) {
      if (isTestFile(file)) continue
      findings.push(...kernelPortsAreNeutral(read(file), file))
    }
  }
  for (const root of RETIREMENT_ROOTS) {
    for (const file of walk(root)) {
      if (isTestFile(file)) continue
      // This audit names every retired form in its own RETIRED_FORMS table.
      if (file === 'scripts/audit-federation-seam.ts' || file === 'scripts/rearch-audit.ts')
        continue
      findings.push(...retirementHolds(read(file), file))
    }
  }
  return findings
}

/**
 * Every check, against a fixture containing exactly what it hunts. A check that finds
 * nothing here is BROKEN, and its zero in the real run means nothing.
 *
 * The presence checks (S1/S2/S3/S5-first-half) are probed by handing them text with the
 * required token REMOVED — their refusing arm is "the token is absent", so the fixture
 * that fires them is an empty string.
 */
function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (name: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: name,
        where: '(probe)',
        detail: 'the check did not find its planted fixture',
      })
    }
  }
  expect('S1-feed-identity', feedIdentityPresent('export interface Nothing {}', '(probe)'))
  expect('S2-origin-causation', changeProvenancePresent('export const Nothing = 1', '(probe)'))
  expect('S3-node-reserved', nodeRoleReservedAndInert('export const strategy = {}', '(probe)'))
  expect(
    'S3-node-inert',
    nodeRoleReservedAndInert(
      "export const s = { role: 'node', reason: 'role-not-implemented', authenticate: () => ({ ok: true }) }",
      '(probe)',
    ),
  )
  expect(
    'S4-kernel-ports-neutral',
    kernelPortsAreNeutral("import { createTRPCClient } from '@trpc/client'", '(probe)'),
  )
  expect(
    'S4-kernel-ports-neutral/ws',
    kernelPortsAreNeutral("import WebSocket from 'ws'", '(probe)'),
  )
  expect(
    'S4-kernel-ports-neutral/fs',
    kernelPortsAreNeutral("import { readFileSync } from 'node:fs'", '(probe)'),
  )
  expect(
    'S5-parameterized-suite/absent',
    suiteStaysParameterized('export function describeSyncConformance() {}', '(probe)'),
  )
  expect(
    'S5-parameterized-suite/assumed',
    suiteStaysParameterized(
      "import { inMemoryInstantiation } from './in-memory'\nexport function f(i: SyncInstantiation) {}",
      '(probe)',
    ),
  )
  for (const [name, fixture] of [
    ['class', 'export class UpstreamForwarder {}'],
    ['new', 'const f = new UpstreamSync({})'],
    ['mirror', 'export function upstreamMirrorFor(m) { return m }'],
    ['apply', 'modules.sessions.setUpstreamSessions(list)'],
    ['forward', 'const r = deps.forwardIssueMutation(proc, input)'],
    ['wrapper', 'return ctx.issueWrite(input, () => local())'],
    ['mint', 'export function mintUpstreamTokenInto(auth) {}'],
    ['writer', 'store.enqueueUpstreamMutation(row)'],
    ['config', 'if (config.upstream) start()'],
  ] as const) {
    expect(`R-retirement-holds/${name}`, retirementHolds(fixture, '(probe)'))
  }
  // NON-VACUITY OF THE COMMENT STRIPPER. Every finding above is reported from
  // comment-stripped text, so a stripper that ate the whole file would make every
  // absence check pass. This proves it does NOT: the retired form is found in code, and
  // the same form inside a comment is not.
  if (retirementHolds('// export class UpstreamForwarder {}', '(probe)').length !== 0) {
    failures.push({
      check: 'comment-stripper',
      where: '(probe)',
      detail: 'a commented-out retired form was reported — the retirement could not be DOCUMENTED',
    })
  }
  if (
    retirementHolds('export class UpstreamForwarder {}\n// and a comment', '(probe)').length !== 1
  ) {
    failures.push({
      check: 'comment-stripper',
      where: '(probe)',
      detail:
        'the stripper removed code, not just comments — every absence check would pass vacuously',
    })
  }
  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Federation-seam audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('federation-seam audit: every probe found its planted fixture')
    return
  }

  const findings = auditFederationSeam()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Federation-seam audit: ${findings.length} finding(s). POD-309's two-directional claim is:\n` +
        '  · the half-built node⇄hub implementation stays RETIRED (POD-353 owns any revival)\n' +
        '  · the seam that keeps a future hub possible stays PRESENT — S1 feed identity,\n' +
        '    S2 origin/causation/mutation identity, S3 reserved node peer, S4 neutral kernel\n' +
        '    ports, S5 an instantiation-parameterized conformance suite\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'federation-seam audit OK — upstream stays retired; S1–S5 of ADR 5 D8 are all present',
  )
}

if (import.meta.main) main()
