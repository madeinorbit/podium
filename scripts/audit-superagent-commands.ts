/**
 * THE SUPERAGENT-SURFACE AUDIT (POD-383, 3.3a; POD-424's criterion for this
 * router).
 *
 * Run:
 *   bun run audit:superagent           # the gate — exit 1 on any finding
 *   bun run audit:superagent --json
 *   bun run audit:superagent --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * TWO INSTRUMENTS, AND NEITHER IS SUFFICIENT ALONE
 * ---------------------------------------------------------------------------
 *
 * `apps/server/src/modules/superagent/derived-surface.test.ts` reads the RUNNING
 * system: the real `appRouter` object, its real procedure map, its real
 * mutation/query flags. That is the only instrument that can prove the wire
 * actually serves `sendTurn` and actually does NOT serve `send` — a source scan
 * cannot see what a router assembled at import time contains.
 *
 * THIS script resolves no modules and reads source TEXT. It runs in a fresh
 * checkout, in a worktree with no local install of the `@podium` scope, and
 * before anything is built. It catches the textual regressions the runtime check
 * cannot see: a hand-written `.mutation(` reappearing inside the `superagent:`
 * router literal, the `send` alias growing back as a second table key, a second
 * declaration of the user-focus schema.
 *
 * POD-732's line is the standard — "an empty router satisfies every absence
 * claim perfectly" — so the pair is deliberate: the source arm can be fooled by
 * a file that is never imported, and the runtime arm can be fooled by a router
 * that was never assembled. Together they cannot both be fooled the same way.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Every check below is an ABSENCE claim, and an absence is exactly what a broken
 * instrument reports. `--probe` runs each check against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it. The
 * probe runs FIRST, always, even without the flag — a green gate whose zero
 * could only mean "the scan broke" is this audit's own worst failure mode.
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

const ROUTER = 'apps/server/src/router.ts'
const REGISTRY = 'apps/server/src/modules/superagent/registry.ts'
const CONTRACTS = 'packages/commands/src/superagent/contracts.ts'

// ---------------------------------------------------------------------------
// 1 — no hand-written mutation in the superagent router
// ---------------------------------------------------------------------------

/**
 * Extract the `superagent: t.router({ … })` literal by BRACE MATCHING.
 *
 * Not a line scan: the literal contains nested objects, comments and a spread,
 * and a line-based reader stops at the first `})` — which would report a serene
 * zero for a mutation written anywhere after it. `--probe` plants its mutation
 * at the END of the block for exactly that reason.
 *
 * Returns `undefined` when the router is absent, which the caller treats as a
 * FINDING and not as a pass: a router that vanished is not a router with no
 * hand-written mutations.
 */
export function routerBlock(source: string): { text: string; startLine: number } | undefined {
  const marker = /^\s{2}superagent: t\.router\(/m
  const match = marker.exec(source)
  if (!match) return undefined
  const open = source.indexOf('(', match.index + match[0].length - 1)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) {
        return { text: source.slice(open, i + 1), startLine: lineOf(source, match.index) }
      }
    }
  }
  return undefined
}

export function handWrittenSuperagentMutations(source: string, where: string): Finding[] {
  const block = routerBlock(source)
  if (!block) {
    return [
      {
        check: 'derived-surface',
        where,
        detail: 'no `superagent: t.router(` literal found — the scan has nothing to check',
      },
    ]
  }
  const findings: Finding[] = []
  for (const match of block.text.matchAll(/\.mutation\(/g)) {
    findings.push({
      check: 'derived-surface',
      where: `${where}:${block.startLine + lineOf(block.text, match.index) - 1}`,
      detail:
        'hand-written `.mutation(` inside the superagent router — every superagent write is derived ' +
        'from its contract by modules/superagent/trpc.ts',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the deleted alias must not grow back
// ---------------------------------------------------------------------------

/**
 * `superagent.send` was `sendTurn`'s byte-identical alias. It is deleted, and it
 * is exactly the kind of thing that regrows because it is locally convenient —
 * someone adds a "friendlier" name beside the real one and both ship.
 *
 * TWO HOMES, because the surface moved: the router (where a hand-written alias
 * would go) and the joined contract table (where a second key would go). Keyed
 * on the DECLARATION — a `send:` key or a second handler forwarding to
 * `s.sendTurn` — and never on a mention, because the comments that explain the
 * deletion name it repeatedly and a check firing on those is a check nobody can
 * keep green.
 */
export function resurrectedSendAlias(files: Array<[string, string]>): Finding[] {
  const findings: Finding[] = []
  for (const [where, source] of files) {
    for (const match of source.matchAll(/^\s+send: (?:t\.procedure|\{)/gm)) {
      findings.push({
        check: 'no-alias',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          'a `send:` entry is back — two wire names for one operation is the fork POD-383 deleted. ' +
          'Eleven callers name `sendTurn` and none has ever named `send`',
      })
    }
    // The same duplicate spelled with a different key: any SECOND handler in the
    // table forwarding to the one service method. One is the real entry.
    const forwards = [...source.matchAll(/\bs\.sendTurn\(/g)]
    for (const match of forwards.slice(1)) {
      findings.push({
        check: 'no-alias',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          'a SECOND table entry forwards to `SuperagentService.sendTurn` — an alias under another ' +
          'name is the same duplicate the audit item counts',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — one user-focus schema, not two
// ---------------------------------------------------------------------------

/**
 * COMPOSITION DRIFT IS INVISIBLE TO THE GOLDEN WIRE FIXTURES (POD-305): a
 * restated `z.object({…})` with the same keys is byte-identical on the wire, so
 * a second declaration of the focus payload passes every fixture while giving
 * the product two schemas that will diverge on the next edit.
 *
 * `contracts.test.ts` pins identity with `toBe` for the arms it knows about; a
 * THIRD declaration in a file neither arm references is what this catches. Keyed
 * on `focusedSessionId:` inside an object literal, which is the field only this
 * payload has, and allowlisted to the one file that may declare it.
 */
export function duplicateFocusSchema(files: Array<[string, string]>): Finding[] {
  const findings: Finding[] = []
  for (const [where, source] of files) {
    if (where === CONTRACTS) continue
    for (const match of source.matchAll(/^\s+focusedSessionId: z\./gm)) {
      findings.push({
        check: 'one-focus-schema',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          'declares the user-focus payload a second time — a restatement is byte-identical on the ' +
          `wire and invisible to the golden fixtures (POD-305). Import it from ${CONTRACTS}`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4 — every contract declares its visibility class
// ---------------------------------------------------------------------------

/**
 * `visibility` is REQUIRED on `CommandContract` at the type level, so this check
 * looks redundant — and it is not, for the reason POD-731 hit: a widening cast
 * (`as unknown as`) over the contract table compiles happily with the field
 * missing from every entry, silently defeating the compile-time half of the
 * default-closed rule. A textual check cannot be cast away.
 */
export function undeclaredVisibility(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(/^export const (superagent\w+Contract) = \{$/gm)) {
    const start = match.index
    const end = source.indexOf('\n} as const', start)
    const body = source.slice(start, end === -1 ? source.length : end)
    if (!/^\s{2}visibility:/m.test(body)) {
      findings.push({
        check: 'visibility-totality',
        where: `${where}:${lineOf(source, start)}`,
        detail:
          `${match[1]} declares no \`visibility\` class — ADR 9 D3/D4 is default-closed and a ` +
          'contract with no class is a write nobody classified',
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function auditSuperagentCommands(): Finding[] {
  const router = read(ROUTER)
  const registry = read(REGISTRY)
  const contracts = read(CONTRACTS)
  return [
    ...handWrittenSuperagentMutations(router, ROUTER),
    ...resurrectedSendAlias([
      [ROUTER, router],
      [REGISTRY, registry],
    ]),
    ...duplicateFocusSchema([
      [ROUTER, router],
      ['apps/server/src/modules/superagent/global.ts', read('apps/server/src/modules/superagent/global.ts')],
      ['apps/server/src/modules/superagent/service.ts', read('apps/server/src/modules/superagent/service.ts')],
      [CONTRACTS, contracts],
    ]),
    ...undeclaredVisibility(contracts, CONTRACTS),
  ]
}

/** Each check, run against a fixture containing exactly what it hunts. */
function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (name: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-superagent-commands.ts',
        detail: `the ${name} check did NOT find its planted fixture — its zero is meaningless`,
      })
    }
  }

  expect(
    'derived-surface',
    handWrittenSuperagentMutations(
      [
        '  superagent: t.router({',
        '    ...superagentFamily,',
        '    listThreads: t.procedure.query(({ ctx }) => ctx.superagent.listThreads()),',
        '    history: t.procedure.input(z.object({ threadId: z.string() })).query(() => []),',
        // Planted at the END, past a nested literal, so a line-scan implementation fails here.
        '    smuggled: t.procedure.mutation(() => undefined),',
        '  }),',
      ].join('\n'),
      '<probe>',
    ),
  )
  // The router-is-missing arm is itself a finding, and it is the arm that turns
  // "I renamed the router" into a red rather than a serene zero.
  expect('derived-surface/absent', handWrittenSuperagentMutations('const nothing = 1\n', '<probe>'))
  expect(
    'no-alias/router',
    resurrectedSendAlias([
      ['<probe>', '  send: t.procedure.input(x).mutation(({ ctx, input }) => ctx.foo(input)),\n'],
    ]),
  )
  expect(
    'no-alias/table',
    resurrectedSendAlias([
      [
        '<probe>',
        [
          '  sendTurn: { contract: C.sendTurn, handler: (s: S, i: I) => s.sendTurn(i) },',
          '  dispatch: { contract: C.dispatch, handler: (s: S, i: I) => s.sendTurn(i) },',
        ].join('\n'),
      ],
    ]),
  )
  // …and ONE forwarder must NOT fire, or the check would be counting the real
  // entry rather than the duplicate — the difference between a ratchet and a
  // gate nobody can ever close.
  if (
    resurrectedSendAlias([
      ['<probe>', '  sendTurn: { contract: C.sendTurn, handler: (s: S, i: I) => s.sendTurn(i) },\n'],
    ]).length > 0
  ) {
    failures.push({
      check: 'instrument',
      where: 'scripts/audit-superagent-commands.ts',
      detail: 'the no-alias check fires on the ONE real entry — it cannot say NO',
    })
  }
  expect(
    'one-focus-schema',
    duplicateFocusSchema([
      [
        'apps/server/src/somewhere-else.ts',
        'const focus = z.object({\n  focusedSessionId: z.string().max(128).optional(),\n})\n',
      ],
    ]),
  )
  // …and the one file that MAY declare it must not fire, or the check is firing
  // on the field rather than on the second home.
  if (
    duplicateFocusSchema([[CONTRACTS, '  focusedSessionId: z.string().max(128).optional(),\n']])
      .length > 0
  ) {
    failures.push({
      check: 'instrument',
      where: 'scripts/audit-superagent-commands.ts',
      detail: 'the one-focus-schema check fires on the contract that owns the schema — it cannot say NO',
    })
  }
  expect(
    'visibility-totality',
    undeclaredVisibility(
      [
        'export const superagentClassifiedContract = {',
        "  name: 'superagent.classified',",
        "  visibility: 'personal',",
        '} as const satisfies CommandContract',
        '',
        'export const superagentForgottenContract = {',
        "  name: 'superagent.forgotten',",
        '  version: 1,',
        '} as const satisfies CommandContract',
      ].join('\n'),
      '<probe>',
    ),
  )
  return failures
}

function main(): void {
  const argv = process.argv.slice(2)
  const wants = (flag: string): boolean => argv.includes(flag)

  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('Superagent-surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('superagent-surface audit: all 8 probes found their planted fixtures')
    return
  }

  const findings = auditSuperagentCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Superagent-surface audit: ${findings.length} finding(s). The 3.3a claims are:\n` +
        '  · every superagent mutation is DERIVED from its contract (no hand-written procedure)\n' +
        '  · the `send` alias stays deleted — one wire name for one operation\n' +
        '  · the user-focus payload is declared ONCE (a restatement is invisible to the goldens)\n' +
        '  · every superagent contract DECLARES its visibility class\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'superagent-surface audit OK — the derived surface is total, the alias stayed deleted, ' +
      'the focus schema has one home, every contract is classified',
  )
}

if (import.meta.main) main()
