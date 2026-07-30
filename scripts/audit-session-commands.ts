/**
 * THE SESSION-SURFACE AUDIT, source half (POD-382, the 3.2 cutover gate).
 *
 * Run:
 *   bun run audit:sessions           # the gate — exit 1 on any finding
 *   bun run audit:sessions --json
 *   bun run audit:sessions --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE A TEST THAT CHECKS THE SAME FAMILY
 * ---------------------------------------------------------------------------
 *
 * `apps/server/src/session-cutover.audit.test.ts` is the other half, and the two are
 * instruments of DIFFERENT KINDS rather than two of the same kind agreeing with each
 * other (two of a kind corroborate; they do not complement):
 *
 *  - THE TEST reads the running system — the real `appRouter`, the real contract
 *    objects, the real services. It is the only thing that can prove a gate actually
 *    refuses or that two error shapes are actually equal.
 *  - THIS SCRIPT reads source text and resolves no modules. It runs in a fresh
 *    checkout, in a worktree with no local install of the `@podium` scope (where
 *    importing a workspace package fails outright), and before anything is built.
 *    It catches the textual regressions a runtime check cannot see: a contract added
 *    without a `visibility:` line (the field is OPTIONAL on `CommandDef`, so the
 *    typechecker will not ask), a hand-written `.mutation(` reappearing inside a
 *    session router literal, `withMutation` growing back as a service method.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Each check below is an ABSENCE claim, and an absence is what a broken instrument
 * reports. `--probe` runs every check against a planted fixture containing exactly
 * the thing it hunts and fails if the check does not find it. A green gate whose
 * zero could only mean "the scan broke" is the audit's own worst failure mode
 * (docs/rearch-deletion-audit.md), so the probe is part of the gate and not a
 * convenience: CI runs `--probe` first.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface Finding {
  /** Which obligation failed — the acceptance criterion, in one token. */
  check: string
  /** Where, as `file:line` when a line is known. */
  where: string
  detail: string
}

// ---------------------------------------------------------------------------
// 1 — no hand-written session mutation in the router
// ---------------------------------------------------------------------------

/** The tRPC routers that make up the session family. */
export const FAMILY_ROUTERS = ['sessions', 'pins', 'snoozes', 'tabs'] as const

/**
 * Extract one `<name>: t.router({ … })` literal by brace matching.
 *
 * Brace matching rather than a regex over lines: the literal contains nested
 * objects, template strings and comments, and a line-based scan would stop at the
 * first `})` — which for `sessions` is ~15 lines in, i.e. it would report a serene
 * zero for a mutation written anywhere after it. `--probe` plants a mutation at the
 * END of the block for exactly this reason.
 */
export function routerBlock(
  source: string,
  router: string,
): { text: string; startLine: number } | undefined {
  const marker = new RegExp(`^\\s{2}${router}: t\\.router\\(\\{`, 'm')
  const match = marker.exec(source)
  if (!match) return undefined
  const open = source.indexOf('{', match.index + match[0].length - 1)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        return {
          text: source.slice(open, i + 1),
          startLine: source.slice(0, open).split('\n').length,
        }
      }
    }
  }
  return undefined
}

/**
 * A session-family router may not contain a hand-written mutation.
 *
 * The reads are still written out by hand and that is deliberate (they have no
 * contracts yet — POD-311's remaining work), so this looks for `.mutation(` and not
 * for procedures in general. A write that hid among the reads by being declared
 * `.query(` would be caught by the runtime half, which reads procedure TYPE off the
 * built router rather than off the source.
 */
export function handWrittenSessionMutations(routerSource: string, file: string): Finding[] {
  const findings: Finding[] = []
  for (const router of FAMILY_ROUTERS) {
    const block = routerBlock(routerSource, router)
    if (!block) {
      findings.push({
        check: 'derived-surface',
        where: file,
        detail: `no \`${router}: t.router({\` literal found — the scan cannot see the ${router} family, so its zero would be meaningless`,
      })
      continue
    }
    const lines = block.text.split('\n')
    for (const [idx, line] of lines.entries()) {
      if (!line.includes('.mutation(')) continue
      findings.push({
        check: 'derived-surface',
        where: `${file}:${block.startLine + idx}`,
        detail: `hand-written mutation in the \`${router}\` router: ${line.trim()}`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — every session-family contract declares its visibility class
// ---------------------------------------------------------------------------

/**
 * Every `const <name>: CommandDef = { … }` in a contract table must declare
 * `visibility`.
 *
 * This is the check the TYPE cannot make: `CommandDef.visibility` is optional so the
 * ~70 issue and lock defs that predate the facet still compile, and ADR 9 D4's
 * default-closed resolution means an omission is SILENT — it resolves to `personal`,
 * which is safe but undeclared. Readiness §3.1.1 rule 2 wants both: fail toward
 * privacy AND fail the build.
 */
export function undeclaredVisibility(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const decl = /^const (\w+): CommandDef = \{$/gm
  for (const match of source.matchAll(decl)) {
    const name = match[1] ?? '<anonymous>'
    const open = source.indexOf('{', match.index)
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
    if (!/^\s*visibility:/m.test(body)) {
      findings.push({
        check: 'visibility-totality',
        where: `${file}:${source.slice(0, match.index).split('\n').length}`,
        detail: `contract \`${name}\` declares no visibility class (ADR 9 D4 — an omission resolves to personal SILENTLY)`,
      })
    }
    if (!/^\s*policy:/m.test(body)) {
      findings.push({
        check: 'policy-totality',
        where: `${file}:${source.slice(0, match.index).split('\n').length}`,
        detail: `contract \`${name}\` declares no policy — there is no owner-or-grant answer to audit`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — the per-proc idempotency wrapper stays deleted
// ---------------------------------------------------------------------------

/**
 * `withMutation` may not come back as a method on the sessions service.
 *
 * Not a ban on the identifier: the issue registry's `IssueCommandCtx.withMutation`
 * is a NAMED BINDING to the framework ledger and is fine, and prose mentioning the
 * deleted method is fine. What must not exist is a per-proc wrapper on the service
 * that a new write could wrap itself in — the shape POD-312 set out to delete.
 */
export function serviceIdempotencyWrapper(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const lines = source.split('\n')
  for (const [idx, line] of lines.entries()) {
    // A method DECLARATION, not a call and not a comment: `withMutation<T>(…)` or
    // `withMutation(…)` at method indentation.
    if (/^\s{2}(?:public\s+|private\s+)?withMutation[<(]/.test(line)) {
      findings.push({
        check: 'framework-idempotency',
        where: `${file}:${idx + 1}`,
        detail: `the per-proc idempotency wrapper is back: ${line.trim()}`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — per-user state is keyed by user in the store's own signatures
// ---------------------------------------------------------------------------

/**
 * The per-user accessors must take a `userId`.
 *
 * The runtime half proves the KEYING behaviourally (two users, two rows). This
 * catches the regression a behavioural test cannot see coming: a signature that
 * drops the parameter, which would make every caller pass the instance's one
 * account and quietly re-create the singleton POD-1076 exists to remove.
 */
const PER_USER_ACCESSORS = [
  'setPin',
  'listPins',
  'setSnooze',
  'clearSnooze',
  'listSnoozes',
  'setTabOrder',
  'listTabOrders',
] as const

export function unkeyedPerUserAccessors(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  const lines = source.split('\n')
  const seen = new Set<string>()
  for (const [idx, line] of lines.entries()) {
    for (const accessor of PER_USER_ACCESSORS) {
      const decl = new RegExp(`^\\s{2}${accessor}\\(([^)]*)`)
      const match = decl.exec(line)
      if (!match) continue
      seen.add(accessor)
      if (!/^userId\s*:/.test(match[1] ?? '')) {
        findings.push({
          check: 'per-user-keying',
          where: `${file}:${idx + 1}`,
          detail: `${accessor} does not take \`userId\` first — per-user state would collapse to an instance-wide singleton`,
        })
      }
    }
  }
  // The scan must have FOUND the accessors; a rename would otherwise silence it.
  for (const accessor of PER_USER_ACCESSORS) {
    if (!seen.has(accessor)) {
      findings.push({
        check: 'per-user-keying',
        where: file,
        detail: `accessor \`${accessor}\` not found — the per-user scan cannot see it, so its silence means nothing`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ROUTER = 'apps/server/src/router.ts'
const CONTRACT_TABLES = [
  'packages/protocol/src/session-commands.ts',
  'packages/protocol/src/session-command-plane.ts',
]
const SERVICE = 'apps/server/src/modules/sessions/service.ts'
const STORE = 'apps/server/src/store/sessions.ts'

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

export function auditSessionCommands(): Finding[] {
  return [
    ...handWrittenSessionMutations(read(ROUTER), ROUTER),
    ...CONTRACT_TABLES.flatMap((file) => undeclaredVisibility(read(file), file)),
    ...serviceIdempotencyWrapper(read(SERVICE), SERVICE),
    ...unkeyedPerUserAccessors(read(STORE), STORE),
  ]
}

/**
 * Prove every check can say YES.
 *
 * Each fixture contains exactly what its check hunts, placed where a naive scan
 * would MISS it — the mutation goes at the end of a nested router literal, the
 * unclassified contract sits after a classified one, the wrapper is declared with a
 * generic. A probe that failed to fire means the gate above is reporting the absence
 * of a working scan, not the absence of the defect.
 */
export function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (name: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-session-commands.ts',
        detail: `the ${name} check did NOT find its planted fixture — its zero is meaningless`,
      })
    }
  }

  expect(
    'derived-surface',
    handWrittenSessionMutations(
      [
        '  sessions: t.router({',
        '    ...sessionFamily.sessions,',
        '    list: t.procedure.query(({ ctx }) => ctx.list()),',
        '    nested: t.procedure.input(z.object({ a: z.string() })).query(() => ({ ok: true })),',
        '    smuggled: t.procedure.mutation(() => undefined),',
        '  }),',
        '  pins: t.router({ ...sessionFamily.pins }),',
        '  snoozes: t.router({ ...sessionFamily.snoozes }),',
        '  tabs: t.router({ ...sessionFamily.tabs }),',
      ].join('\n'),
      '<probe>',
    ),
  )
  expect(
    'visibility-totality',
    undeclaredVisibility(
      [
        'const classified: CommandDef = {',
        '  input: z.object({}),',
        "  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write' },",
        "  visibility: 'personal',",
        '}',
        '',
        'const forgotten: CommandDef = {',
        '  input: z.object({}),',
        "  policy: { resource: 'session', scope: 'owner-or-grant', action: 'write' },",
        '}',
      ].join('\n'),
      '<probe>',
    ),
  )
  expect(
    'framework-idempotency',
    serviceIdempotencyWrapper(
      [
        'class SessionsService {',
        '  withMutation<T>(id: string | undefined): T {',
        '  }',
        '}',
      ].join('\n'),
      '<probe>',
    ),
  )
  expect(
    'per-user-keying',
    unkeyedPerUserAccessors(
      [
        '  setPin(kind: PinKind, id: string, pinned: boolean): void {',
        '  listPins(userId: string): PinState {',
        '  setSnooze(userId: string, sessionId: string, until: string | null): void {',
        '  clearSnooze(userId: string, sessionId: string): void {',
        '  listSnoozes(userId: string): SnoozeMap {',
        '  setTabOrder(userId: string, worktree: string, ids: string[]): void {',
        '  listTabOrders(userId: string): Record<string, string[]> {',
      ].join('\n'),
      '<probe>',
    ),
  )

  // And the negative control: the real sources must NOT trip the probe fixtures'
  // checks for a reason unrelated to what is planted. Nothing to assert here beyond
  // the gate itself, which main() runs next.
  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Session-surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('session-surface audit: all 4 checks found their planted fixtures')
    return
  }

  const findings = auditSessionCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Session-surface audit: ${findings.length} finding(s). The 3.2 cutover's claims are:\n` +
        '  · every session mutation is DERIVED from a contract (no hand-written procedure)\n' +
        '  · every session-family contract DECLARES its visibility class and its policy\n' +
        '  · idempotency is the framework ledger, not a per-proc wrapper\n' +
        '  · per-user state is keyed (userId, entityId), never an instance-wide singleton\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'session-surface audit OK — the derived surface is total, every contract is classified, ' +
      'idempotency is framework-owned, per-user state is keyed by user',
  )
}

if (import.meta.main) main()
