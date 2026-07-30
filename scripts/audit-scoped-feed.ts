/**
 * THE SCOPED-FEED AUDIT (POD-1077; ADR 2 Amendment 1 D12–D14, ADR 9 D3/D4).
 *
 * Run:
 *   bun run audit:scoped-feed           # the gate — exit 1 on any finding
 *   bun run audit:scoped-feed --json
 *   bun run audit:scoped-feed --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS, BECAUSE NEITHER CAN SEE THE OTHER'S FAILURE
 * ---------------------------------------------------------------------------
 *
 * SOURCE-TEXT checks (§1–§4) resolve no modules and read source as text. They run
 * in a fresh checkout, in a worktree with no local install of the `@podium` scope,
 * and before anything is built. They catch textual regressions a running object
 * cannot see: a second `DeviceGradeUnscopedPolicy` appearing at a new composition
 * root, an unscoped `subscribe(` overload growing back, `op: 'remove'` reappearing
 * on a revocation path.
 *
 * RUNNING-OBJECT checks (§5) construct the real `Authority` and the real
 * `FeedPublisher` and ask them questions. They catch what text cannot: whether the
 * filter actually filters, and — the one that matters more — whether a SUPPRESSED
 * range still advances the receiver's position. POD-732's line is the standard
 * here ("an empty router satisfies every absence claim perfectly"): a source scan
 * that found no unscoped calls would be perfectly satisfied by a publisher that
 * delivers nothing to anyone.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Most checks below are ABSENCE claims, and an absence is exactly what a broken
 * instrument reports. `--probe` runs each check against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it, and then
 * against a CLEAN fixture and fails if it fires anyway. Both halves: a check that
 * fires on everything is as useless as one that fires on nothing. The probe runs
 * FIRST, always, even without the flag.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Finding {
  /** Which obligation failed — the acceptance criterion, in one token. */
  check: string
  /** Where, as `file:line` when a line is known. */
  where: string
  detail: string
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

// ---------------------------------------------------------------------------
// 1 — the permissive policy has exactly ONE declared home
// ---------------------------------------------------------------------------

/**
 * `DeviceGradeUnscopedPolicy` says "everyone may see everything", which is the
 * honest answer for a transport that cannot tell two people apart
 * (`CLIENT_PRINCIPAL_GRADE === 'device'`). It is also, obviously, a hole if it
 * spreads: one `new DeviceGradeUnscopedPolicy()` at a new composition root turns
 * a scoped feed back into an unscoped one with no test failing, because every
 * scoped test constructs its own policy.
 *
 * So the site list is a RATCHET, not a rule of thumb. The allowlist is the file
 * that owns the pre-cutover oplog facade, and its own module.
 */
const UNSCOPED_POLICY_ALLOWLIST: ReadonlySet<string> = new Set([
  // The definition itself, and the one composition root whose transport has a
  // single principal. When per-user login lands, this list goes to zero and the
  // export is deleted.
  'packages/sync/src/feed/visibility.ts',
  'packages/sync/src/ledger.ts',
])

const SCANNED_DIRS = ['packages', 'apps'] as const

export function unscopedPolicySites(
  files: ReadonlyMap<string, string>,
  allowlist: ReadonlySet<string> = UNSCOPED_POLICY_ALLOWLIST,
): Finding[] {
  const findings: Finding[] = []
  for (const [file, source] of files) {
    if (allowlist.has(file)) continue
    // Tests legitimately construct one to stand for the single-principal
    // deployment; they cannot widen production, and forbidding it there would
    // push every suite into inventing its own permissive fake — a SECOND
    // definition of "everyone", which is strictly worse than the audited one.
    if (file.includes('.test.') || file.includes('/conformance/')) continue
    for (const match of source.matchAll(/new DeviceGradeUnscopedPolicy\s*\(/g)) {
      findings.push({
        check: 'unscoped-policy-sites',
        where: `${file}:${lineOf(source, match.index)}`,
        detail:
          'a second composition root declares the device-grade "everyone" policy. It is allowed at ' +
          `exactly ${[...allowlist].join(' and ')} — see feed/visibility.ts on why the export exists ` +
          'and what deleting it is meant to force.',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — no unscoped read seam
// ---------------------------------------------------------------------------

/**
 * The Authority's two read paths take a principal, and there must be no overload,
 * default or optional parameter that makes the unscoped form reachable — because
 * the default is what every new call site takes (D12.7).
 *
 * Checked on the DECLARATION rather than on call sites: a call site that forgot
 * one is a type error already, and scanning calls would be a proxy for the thing
 * that actually decides.
 */
export function unscopedReadSeams(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const patterns: readonly { rx: RegExp; detail: string }[] = [
    {
      rx: /\bsubscribe\s*\(\s*subscriber\b/g,
      detail: '`subscribe` takes a subscriber alone — an unscoped subscription (ADR 2 Am1 D12.7)',
    },
    {
      rx: /\bchangesSince\s*\(\s*cursor\s*:\s*number\s*\|\s*null\s*\)/g,
      detail: '`changesSince` takes a cursor alone — an unscoped catch-up read',
    },
    {
      rx: /principal\s*\?\s*:/g,
      detail: 'an OPTIONAL principal: the unscoped read becomes the default, which is what new call sites take',
    },
  ]
  for (const { rx, detail } of patterns) {
    for (const match of source.matchAll(rx)) {
      findings.push({
        check: 'unscoped-read-seam',
        where: `${file}:${lineOf(source, match.index)}`,
        detail,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — `remove` is never how a revocation is expressed (D14.5)
// ---------------------------------------------------------------------------

/**
 * Amendment 1 D14.5 is normative: reusing `remove` for eviction makes the replica
 * render a revoked share as a DELETION and a later re-grant as a resurrection, and
 * the lie is type-correct and silent.
 *
 * Text, not types, because both ops are the same type. The scan is narrow on
 * purpose: it looks for a `remove` op literal within a few lines of revocation
 * vocabulary, which is where the substitution would actually be written.
 */
// No `\b` anchors, deliberately: the substitution this hunts would be written in
// a method called `onRevoke` or `handleUnshare` as readily as in a bare `revoke`,
// and a word-boundary regex misses every camelCase spelling of the concept. The
// detector must cover how the CONCEPT can be written, not one syntax for it.
const REVOCATION_WORDS = /(revoke|revoked|revocation|unshare|unshared|evict|eviction)/i

export function removeUsedForRevocation(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const lines = source.split('\n')
  const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line)

  // (a) A `remove` on a line that also names revocation — the blunt spelling.
  for (const [i, line] of lines.entries()) {
    if (!/op:\s*'remove'/.test(line) || isComment(line)) continue
    if (!REVOCATION_WORDS.test(line)) continue
    findings.push({
      check: 'remove-for-revocation',
      where: `${file}:${i + 1}`,
      detail: "an `op: 'remove'` on a line that names revocation (ADR 2 Am1 D14.5)",
    })
  }

  // (b) A `remove` produced INSIDE a function whose name names revocation. This is
  //     the shape the substitution actually takes, and it is why this check is not
  //     a proximity scan: a nearby `evict` is far more often the DOCUMENTATION of
  //     the distinction (`replica/ports.ts` defines both ops four lines apart) than
  //     the violation, and a detector that cried wolf there would be suppressed by
  //     the next reader rather than fixed.
  const declaration = /(?:function|const|let|async|=>|\b)\s*([A-Za-z_$][\w$]*)\s*(?:=\s*)?\([^)]*\)\s*(?::[^{\n]+)?\{/g
  for (const match of source.matchAll(declaration)) {
    const name = match[1] ?? ''
    if (!REVOCATION_WORDS.test(name)) continue
    const open = source.indexOf('{', match.index + match[0].length - 1)
    let depth = 0
    let end = source.length
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const body = source.slice(open, end)
    for (const hit of body.matchAll(/op:\s*'remove'/g)) {
      const at = open + (hit.index ?? 0)
      if (isComment(lines[lineOf(source, at) - 1] ?? '')) continue
      findings.push({
        check: 'remove-for-revocation',
        where: `${file}:${lineOf(source, at)}`,
        detail:
          `\`${name}\` emits an \`op: 'remove'\`. D14.5 forbids it: \`remove\` is global and terminal, ` +
          'eviction is per-principal and reversible, and the replica renders the first as a deletion ' +
          '(and a later re-grant as a resurrection).',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — the delivery type keeps the range and the rows together
// ---------------------------------------------------------------------------

/**
 * D13's mechanism is that a filtered list cannot travel without the range it was
 * filtered over. That is enforced by `ScopedDelivery` having BOTH fields required
 * on the batch arm. An optional `throughSeq`, or a second delivery type carrying
 * only rows, re-opens the protocol break — so the shape is checked here as well as
 * compiled.
 */
export function deliveryShape(source: string): Finding[] {
  const findings: Finding[] = []
  const batchArm = /kind:\s*'batch'[\s\S]{0,400}?\}/.exec(source)
  if (batchArm === null) {
    return [
      {
        check: 'delivery-shape',
        where: 'packages/sync/src/authority/scoping.ts',
        detail:
          "the `batch` arm of ScopedDelivery is GONE. That is a finding, not a pass: the type is " +
          'what makes filter-without-watermark unrepresentable.',
      },
    ]
  }
  const arm = batchArm[0]
  if (!/readonly throughSeq:\s*number/.test(arm)) {
    findings.push({
      check: 'delivery-shape',
      where: 'packages/sync/src/authority/scoping.ts',
      detail:
        '`throughSeq` is not a required `number` on the batch arm. Optional, and a filtered list can ' +
        'be delivered with no certified range — every suppressed row becomes a permanent invisible gap ' +
        '(ADR 2 D2, POD-351).',
    })
  }
  if (!/readonly changes:/.test(arm)) {
    findings.push({
      check: 'delivery-shape',
      where: 'packages/sync/src/authority/scoping.ts',
      detail: 'the batch arm carries no `changes` — the rows and the range must travel together',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 5 — the RUNNING objects: does the filter filter, and does the watermark advance
// ---------------------------------------------------------------------------

/**
 * Everything above is text. This is the half that resolves modules and asks the
 * shipped classes.
 *
 * Deliberately asserting BOTH directions in each case: "Grace did not receive
 * Ada's row" is satisfied by a publisher that delivers nothing at all, and
 * "everyone got everything" is satisfied by no filter. Only the pair distinguishes
 * a working scoped feed from either broken one.
 */
/**
 * The kernel classes, injected.
 *
 * Injected rather than imported inside, for two reasons. It is what lets
 * `audit-scoped-feed.test.ts` PROVE these checks can say YES, by handing them a
 * deliberately-broken publisher and asserting the findings appear — the planted
 * fixture the source-text half gets from `--probe`. And it keeps this module
 * import-free, so the text checks still run in a checkout where the `@podium`
 * scope is not installed (which is every worktree in this fan-out).
 */
export interface KernelUnderTest {
  Authority: new (deps: never) => {
    subscribe(principal: unknown, subscriber: (delivery: never) => void): () => void
    capture(specs: readonly never[]): unknown
    changesSince(cursor: number | null, principal: unknown): { kind: string; throughSeq?: number; changes?: readonly { entityId: string }[] } | null
  }
  FeedPublisher: new (deps: never) => {
    connect(id: string, fromSeq: number, principal: unknown): {
      isDemoted(): boolean
      drain(): readonly { kind: string; fromSeq?: number; seq?: number }[]
    }
    publish(principal: unknown, delivery: unknown): void
  }
  FeedIdentityRegistry: new (store: never, mint: () => string) => unknown
  GrantEdgeVisibilityPolicy: new (state: never) => unknown
}

/** Resolve the real kernel. Only reachable where the workspace is installed. */
export async function shippedKernel(): Promise<KernelUnderTest> {
  const { Authority } = await import('../packages/sync/src/authority/authority')
  const { FeedPublisher, FeedIdentityRegistry, GrantEdgeVisibilityPolicy } = await import(
    '../packages/sync/src/feed'
  )
  return {
    Authority,
    FeedPublisher,
    FeedIdentityRegistry,
    GrantEdgeVisibilityPolicy,
  } as unknown as KernelUnderTest
}

export async function runtimeChecks(kernel: KernelUnderTest): Promise<Finding[]> {
  const findings: Finding[] = []
  const fail = (check: string, detail: string): void => {
    findings.push({ check, where: 'packages/sync (running objects)', detail })
  }

  const { Authority, FeedPublisher, FeedIdentityRegistry, GrantEdgeVisibilityPolicy } = kernel

  type Row = { seq: number; entity: string; entityId: string; op: string; payload: string | null }
  const rows: Row[] = []
  let nextSeq = 1
  const store = {
    appendChanges(batch: readonly Omit<Row, 'seq'>[]) {
      const seqs: number[] = []
      for (const r of batch) {
        rows.push({ seq: nextSeq, ...r })
        seqs.push(nextSeq)
        nextSeq += 1
      }
      return seqs
    },
    maxChangeSeq: () => nextSeq - 1,
    minChangeSeq: () => rows[0]?.seq ?? null,
    changesSince: (cursor: number) => rows.filter((r) => r.seq > cursor),
    planChangePrune: () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: () => 0,
    // Latest per (entity, id) — the port's contract, and what the sqlite
    // adapter's GROUP BY returns. A fake that hands back the whole table reads
    // every historical write as part of the current world.
    latestChangeStates: () => {
      const latest = new Map<string, (typeof rows)[number]>()
      for (const r of rows) latest.set(`${r.entity}/${r.entityId}`, r)
      return [...latest.values()]
    },
  }

  // Ada may see `mine`; Grace holds nothing. No privileged principal exists.
  const grants = new Map<string, Set<string>>([['ada', new Set(['session:mine'])]])
  const state = {
    classOf: (entity: string) => (entity === 'session' ? ('personal' as const) : null),
    mayRead: (user: string, ref: { entity: string; entityId: string }) =>
      grants.get(user)?.has(`${ref.entity}:${ref.entityId}`) === true,
    keyedUserOf: () => null,
    visibilityEdge: () => null,
    currentValueOf: () => undefined,
  }
  const authority = new Authority({
    store: store as never,
    now: () => 1,
    transact: <T,>(fn: () => T) => fn(),
    visibility: new GrantEdgeVisibilityPolicy(state as never),
    anchors: state as never,
  })

  const ADA = { kind: 'user', userId: 'ada' } as const
  const GRACE = { kind: 'user', userId: 'grace' } as const

  const adaSaw: { ids: string[]; through: number }[] = []
  const graceSaw: { ids: string[]; through: number }[] = []
  authority.subscribe(ADA, (d) => {
    if (d.kind === 'batch') adaSaw.push({ ids: d.changes.map((c) => c.entityId), through: d.throughSeq })
  })
  authority.subscribe(GRACE, (d) => {
    if (d.kind === 'batch')
      graceSaw.push({ ids: d.changes.map((c) => c.entityId), through: d.throughSeq })
  })

  authority.capture([{ entity: 'session', entityId: 'mine', op: 'upsert', value: { n: 1 } }])

  if (adaSaw.flatMap((d) => d.ids).join() !== 'mine') {
    fail('runtime-filter', 'the grantee did NOT receive a row she may see — the feed delivers nothing')
  }
  if (graceSaw.flatMap((d) => d.ids).length > 0) {
    fail('runtime-filter', 'a principal with no grant received the row — the filter does not filter')
  }
  // THE watermark property. Without it the previous check is satisfied by a feed
  // that silently drops suppressed rows, which is the protocol break rather than
  // the fix (ADR 2 Am1 D13, POD-351).
  if (graceSaw.length === 0 || graceSaw[0]?.through !== 1) {
    fail(
      'runtime-watermark',
      'the suppressed range was NOT certified to the principal who could not see it. Every suppressed ' +
        'row without a watermark is a permanent invisible gap that heal-loops forever.',
    )
  }

  // The heal path must agree with the live path over the same range.
  const healed = authority.changesSince(0, GRACE)
  if (healed === null || healed.kind !== 'batch' || healed.throughSeq !== 1) {
    fail('runtime-watermark', 'the scoped catch-up reply does not certify to the log head')
  }
  if (healed !== null && healed.kind === 'batch' && healed.changes.length > 0) {
    fail('runtime-filter', 'the scoped catch-up reply served rows the principal may not see')
  }

  // The publisher: a watermark must advance the connection and must not demote it.
  let minted = 0
  const identity = new FeedIdentityRegistry(
    {
      readIdentity: () => held,
      writeIdentity: (v: unknown) => {
        held = v as never
      },
    } as never,
    () => `01JQ0PAUDIT${(minted++).toString().padStart(15, '0')}`,
  )
  let held: unknown = null
  const publisher = new FeedPublisher({
    identity,
    retention: { minAvailableSeq: () => 0 },
    sendQueue: { maxBytes: 1, sizeOf: () => 1 },
  })
  const connection = publisher.connect('c1', 0, GRACE)
  for (let seq = 1; seq <= 50; seq += 1) {
    publisher.publish(GRACE, { kind: 'batch', throughSeq: seq, changes: [] })
  }
  if (connection.isDemoted()) {
    fail(
      'runtime-watermark',
      'watermark-only traffic DEMOTED the connection (D13.4): a replica was forced to re-bootstrap ' +
        'because of activity it is not allowed to observe',
    )
  }
  const frames = connection.drain()
  const delta = frames.find((f) => f.kind === 'delta')
  if (delta === undefined || delta.kind !== 'delta' || delta.fromSeq !== 0 || delta.seq !== 50) {
    fail(
      'runtime-watermark',
      'a run of watermarks did not coalesce into ONE frame covering (0, 50] — the receiver is left ' +
        `behind the head (got ${JSON.stringify(frames)})`,
    )
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>()
  const glob = new Bun.Glob('**/*.ts')
  for (const dir of SCANNED_DIRS) {
    for (const rel of glob.scanSync({ cwd: join(ROOT, dir), onlyFiles: true })) {
      if (rel.includes('node_modules') || rel.endsWith('.d.ts')) continue
      const path = `${dir}/${rel}`
      files.set(path, read(path))
    }
  }
  return files
}

/**
 * The SOURCE-TEXT gate. Resolves no modules, so it runs in a fresh checkout.
 *
 * The running-object half is `scripts/audit-scoped-feed.test.ts`, which calls
 * {@link runtimeChecks} under vitest, where the workspace resolves. Split for an
 * environmental reason and stated so it is not read as a gap: these worktrees
 * carry a `node_modules` with no `@podium` scope, so a script that imported the
 * kernel would fail to RESOLVE rather than fail to pass — and an audit that dies
 * on import is an audit nobody runs.
 */
export function auditScopedFeedText(): Finding[] {
  const files = sourceFiles()
  const findings: Finding[] = [...unscopedPolicySites(files)]

  const ports = 'packages/sync/src/authority/ports.ts'
  const authority = 'packages/sync/src/authority/authority.ts'
  findings.push(...unscopedReadSeams(read(ports), ports))
  findings.push(...unscopedReadSeams(read(authority), authority))

  for (const [file, source] of files) {
    if (file.includes('.test.')) continue
    findings.push(...removeUsedForRevocation(source, file))
  }

  findings.push(...deliveryShape(read('packages/sync/src/authority/scoping.ts')))
  return findings
}

/**
 * Each check, shown finding a planted fixture AND not firing on a clean one.
 *
 * The second half is not decoration: a check that fires on everything reports a
 * finding on every run and gets suppressed by the next person to read it, which
 * is a slower version of a check that never fires.
 */
function probe(): Finding[] {
  const broken: Finding[] = []
  const expectFinds = (check: string, found: Finding[], what: string): void => {
    if (found.length === 0) {
      broken.push({
        check,
        where: 'scripts/audit-scoped-feed.ts',
        detail: `the check did not find its planted ${what} — it cannot say YES`,
      })
    }
  }
  const expectClean = (check: string, found: Finding[]): void => {
    if (found.length > 0) {
      broken.push({
        check,
        where: 'scripts/audit-scoped-feed.ts',
        detail: `the check fired on a CLEAN fixture (${found[0]?.detail}) — it cannot say NO`,
      })
    }
  }

  expectFinds(
    'unscoped-policy-sites',
    unscopedPolicySites(
      new Map([['apps/server/src/gateway/planted.ts', 'const p = new DeviceGradeUnscopedPolicy()\n']]),
    ),
    'second permissive-policy site',
  )
  expectClean(
    'unscoped-policy-sites',
    unscopedPolicySites(
      new Map([['packages/sync/src/ledger.ts', 'const p = new DeviceGradeUnscopedPolicy()\n']]),
    ),
  )

  expectFinds(
    'unscoped-read-seam',
    unscopedReadSeams('  subscribe(subscriber: ChangeSubscriber): () => void\n', '<probe>'),
    'unscoped subscribe',
  )
  expectFinds(
    'unscoped-read-seam',
    unscopedReadSeams('  changesSince(cursor: number | null): Rows | null\n', '<probe>'),
    'unscoped changesSince',
  )
  expectFinds(
    'unscoped-read-seam',
    unscopedReadSeams('  changesSince(cursor: number, principal?: FeedPrincipal): X\n', '<probe>'),
    'optional principal',
  )
  expectClean(
    'unscoped-read-seam',
    unscopedReadSeams(
      '  subscribe(principal: FeedPrincipal, subscriber: ChangeSubscriber): () => void\n' +
        '  changesSince(cursor: number | null, principal: FeedPrincipal): ScopedDelivery | null\n',
      '<probe>',
    ),
  )

  expectFinds(
    'remove-for-revocation',
    removeUsedForRevocation(
      ['function onRevoke(ref) {', "  return { ...ref, op: 'remove' }", '}'].join('\n'),
      '<probe>',
    ),
    'remove on a revocation path',
  )
  expectClean(
    'remove-for-revocation',
    removeUsedForRevocation(
      ['function onRevoke(ref) {', "  return { ...ref, op: 'evict' }", '}'].join('\n'),
      '<probe>',
    ),
  )
  expectClean(
    'remove-for-revocation',
    removeUsedForRevocation(
      ['function onDelete(ref) {', "  return { ...ref, op: 'remove' }", '}'].join('\n'),
      '<probe>',
    ),
  )

  expectFinds(
    'delivery-shape',
    deliveryShape("export type D = { kind: 'batch'; readonly changes: Row[] }"),
    'batch arm with no certified range',
  )
  expectFinds('delivery-shape', deliveryShape('export type D = { kind: "nothing" }'), 'missing batch arm')
  expectClean(
    'delivery-shape',
    deliveryShape(
      "export type D = { kind: 'batch'; readonly throughSeq: number; readonly changes: Row[] }",
    ),
  )
  return broken
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Scoped-feed audit: THE INSTRUMENT IS BROKEN — a check cannot say YES or NO.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('scoped-feed audit: all source-text probes found their fixtures and spared the clean ones')
    return
  }

  const findings = auditScopedFeedText()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Scoped-feed audit: ${findings.length} finding(s). POD-1077's claims are:\n` +
        '  · the device-grade "everyone" policy has exactly ONE declared composition root\n' +
        '  · neither Authority read path can be reached without a principal\n' +
        "  · `remove` is never how a revocation is expressed (D14.5)\n" +
        '  · a filtered list cannot travel without its certified range (D13)\n' +
        '  (the RUNNING feed — does it filter, watermark and survive a suppressed firehose — is\n' +
        '   scripts/audit-scoped-feed.test.ts, which resolves the kernel under vitest)\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'scoped-feed audit OK — one permissive site, no unscoped read seam, no remove-for-revocation, ' +
      'the range travels with the rows (the running-object half is audit-scoped-feed.test.ts)',
  )
}

if (import.meta.main) main()
