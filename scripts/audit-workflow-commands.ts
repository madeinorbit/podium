/**
 * THE WORKFLOW-SURFACE AUDIT (POD-732, the 3.10 cutover gate; POD-424's
 * criterion for this router).
 *
 * Run:
 *   bun run audit:workflows           # the gate — exit 1 on any finding
 *   bun run audit:workflows --json
 *   bun run audit:workflows --probe   # prove every check can say YES
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE THE TESTS THAT CHECK THE SAME FAMILY
 * ---------------------------------------------------------------------------
 *
 * `modules/workflows/characterization.test.ts` reads the RUNNING system — real
 * services, real contract objects, real refusals. It is the only thing that can
 * prove a gate actually refuses.
 *
 * This script resolves no modules and reads source TEXT. It runs in a fresh
 * checkout, in a worktree with no local install of the `@podium` scope, and
 * before anything is built. It catches the textual regressions a runtime check
 * cannot see: a hand-written `.mutation(` reappearing inside the `workflows:`
 * router literal, `workflowInputs` or `WorkflowService.dispatch` growing back, a
 * transport assembling the handler context itself and so gaining the ability to
 * supply a second idempotency ledger.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK CAN SAY YES — `--probe`
 * ---------------------------------------------------------------------------
 *
 * Every check below is an ABSENCE claim, and an absence is exactly what a broken
 * instrument reports. `--probe` runs each check against a planted fixture
 * containing the thing it hunts and FAILS if the check does not find it. A green
 * gate whose zero could only mean "the scan broke" is the audit's own worst
 * failure mode (docs/rearch-deletion-audit.md), so the probe runs FIRST, always,
 * even without the flag.
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
// 1 — no hand-written mutation in the workflows router
// ---------------------------------------------------------------------------

/**
 * Extract the `workflows: t.router({ … })` literal by BRACE MATCHING.
 *
 * Not a line scan: the literal used to contain nested objects, template strings
 * and comments, and a line-based reader stops at the first `})` — which would
 * report a serene zero for a mutation written anywhere after it. `--probe`
 * plants its mutation at the END of the block for exactly that reason.
 *
 * Returns `undefined` when the router is absent, which the caller treats as a
 * FINDING and not as a pass: a router that vanished is not a router with no
 * hand-written mutations.
 */
export function routerBlock(source: string): { text: string; startLine: number } | undefined {
  const marker = /^\s{2}workflows: t\.router\(/m
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

export function handWrittenWorkflowMutations(source: string, where: string): Finding[] {
  const block = routerBlock(source)
  if (!block) {
    return [
      {
        check: 'derived-surface',
        where,
        detail: 'no `workflows: t.router(` literal found — the scan has nothing to check',
      },
    ]
  }
  const findings: Finding[] = []
  for (const match of block.text.matchAll(/\.mutation\(/g)) {
    findings.push({
      check: 'derived-surface',
      where: `${where}:${block.startLine + lineOf(block.text, match.index) - 1}`,
      detail:
        'hand-written `.mutation(` inside the workflows router — every workflow write is derived ' +
        'from its contract by modules/workflows/trpc.ts',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 2 — the deleted second declarations must not grow back
// ---------------------------------------------------------------------------

/**
 * `workflowInputs` was a schema table beside the router; `dispatch` was a
 * reflective, name-keyed second dispatcher over it. Both are deleted, and both
 * are the kind of thing that regrows because they are locally convenient.
 *
 * Keyed on the DECLARATION, not on any mention — the comments that explain the
 * deletion name both, and a check that fired on those would be a check nobody
 * could keep green.
 */
export function resurrectedSecondSurface(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  const patterns: Array<[RegExp, string]> = [
    [
      /^(export )?const workflowInputs\b/m,
      '`workflowInputs` is back — a schema table beside the router is a second declaration of ' +
        'the surface the contracts already declare',
    ],
    [
      /^\s{2}dispatch\(caller: WorkflowCaller/m,
      '`WorkflowService.dispatch` is back — a name-keyed reflective dispatcher serves a proc ' +
        'because a table entry exists, not because a declaration names the transport (ADR 3 D3)',
    ],
  ]
  for (const [pattern, detail] of patterns) {
    const match = pattern.exec(source)
    if (match) {
      findings.push({
        check: 'no-second-surface',
        where: `${where}:${lineOf(source, match.index)}`,
        detail,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 3 — one ledger, reached through one door
// ---------------------------------------------------------------------------

/**
 * A transport that builds `WorkflowHandlerContext` itself can call
 * `dispatchWorkflowCommand` directly — and its `opts.ledger` is how a SECOND
 * idempotency ledger enters the product. There is one ledger (POD-382 collapsed
 * three into `@podium/sync`'s `MutationLedger`, POD-351 rerouted its own onto
 * it), and the rule is structural: the only caller of `dispatchWorkflowCommand`
 * is `WorkflowService.execute`, which holds the ledger privately.
 *
 * So this check fires on any call to `dispatchWorkflowCommand(` outside the
 * module's own `service.ts` and `registry.ts`.
 */
export function extraDispatchCallers(files: Array<[string, string]>): Finding[] {
  const allowed = new Set([
    'apps/server/src/modules/workflows/service.ts',
    'apps/server/src/modules/workflows/registry.ts',
  ])
  const findings: Finding[] = []
  for (const [where, source] of files) {
    if (allowed.has(where)) continue
    for (const match of source.matchAll(/\bdispatchWorkflowCommand\(/g)) {
      findings.push({
        check: 'one-ledger',
        where: `${where}:${lineOf(source, match.index)}`,
        detail:
          'calls `dispatchWorkflowCommand` directly — its `opts.ledger` is how a second ' +
          'idempotency ledger enters. Enter through `WorkflowService.execute`, which owns the one ledger',
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
 *
 * Keyed on the contract literal's opening line, so a contract added without the
 * line is found regardless of where in the object it would have gone.
 */
export function undeclaredVisibility(source: string, where: string): Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(/^export const (workflow\w+Contract) = \{$/gm)) {
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

const SCANNED = [
  'apps/server/src/router.ts',
  'apps/server/src/relay.ts',
  'apps/server/src/modules/workflows/trpc.ts',
  'apps/server/src/modules/workflows/rpc.ts',
  'apps/server/src/modules/workflows/queries.ts',
  'apps/server/src/modules/workflows/service.ts',
  'apps/server/src/modules/workflows/registry.ts',
] as const

export function auditWorkflowCommands(): Finding[] {
  const router = read('apps/server/src/router.ts')
  const service = read('apps/server/src/modules/workflows/service.ts')
  const contracts = read('packages/commands/src/workflows/contracts.ts')
  return [
    ...handWrittenWorkflowMutations(router, 'apps/server/src/router.ts'),
    ...resurrectedSecondSurface(service, 'apps/server/src/modules/workflows/service.ts'),
    ...extraDispatchCallers(SCANNED.map((rel) => [rel, read(rel)] as [string, string])),
    ...undeclaredVisibility(contracts, 'packages/commands/src/workflows/contracts.ts'),
  ]
}

/** Each check, run against a fixture containing exactly what it hunts. */
function probe(): Finding[] {
  const failures: Finding[] = []
  const expect = (name: string, found: Finding[]): void => {
    if (found.length === 0) {
      failures.push({
        check: 'instrument',
        where: 'scripts/audit-workflow-commands.ts',
        detail: `the ${name} check did NOT find its planted fixture — its zero is meaningless`,
      })
    }
  }

  expect(
    'derived-surface',
    handWrittenWorkflowMutations(
      [
        '  workflows: t.router({',
        '    ...workflowFamilyProcedures(),',
        '    list: t.procedure.query(({ ctx }) => ctx.list()),',
        '    nested: t.procedure.input(z.object({ a: z.string() })).query(() => ({ ok: true })),',
        // Planted at the END, past a nested literal, so a line-scan implementation fails here.
        '    smuggled: t.procedure.mutation(() => undefined),',
        '  }),',
      ].join('\n'),
      '<probe>',
    ),
  )
  // The router-is-missing arm is itself a finding, and it is the arm that turns
  // "I renamed the router" into a red rather than a serene zero.
  expect('derived-surface/absent', handWrittenWorkflowMutations('const nothing = 1\n', '<probe>'))
  expect(
    'no-second-surface',
    resurrectedSecondSurface(
      [
        'export const workflowInputs = {',
        '  list: z.object({}),',
        '}',
        '',
        'class WorkflowService {',
        '  dispatch(caller: WorkflowCaller, proc: string, raw: unknown) {',
        '    return undefined',
        '  }',
        '}',
      ].join('\n'),
      '<probe>',
    ),
  )
  expect(
    'one-ledger',
    extraDispatchCallers([
      [
        'apps/server/src/some-transport.ts',
        'return dispatchWorkflowCommand(proc, ctx, input, { ledger: myOwnLedger })\n',
      ],
    ]),
  )
  // …and the allowlist must still allow: a fixture at an allowed path must NOT fire,
  // or the check would be firing on the path rather than on the call.
  if (
    extraDispatchCallers([
      [
        'apps/server/src/modules/workflows/service.ts',
        'return dispatchWorkflowCommand(proc, ctx, input, {})\n',
      ],
    ]).length > 0
  ) {
    failures.push({
      check: 'instrument',
      where: 'scripts/audit-workflow-commands.ts',
      detail: 'the one-ledger check fires on its OWN allowed door — it cannot say NO',
    })
  }
  expect(
    'visibility-totality',
    undeclaredVisibility(
      [
        'export const workflowClassifiedContract = {',
        "  name: 'workflows.classified',",
        "  visibility: 'personal',",
        '} as const satisfies WorkflowCommandContract',
        '',
        'export const workflowForgottenContract = {',
        "  name: 'workflows.forgotten',",
        '  version: 1,',
        '} as const satisfies WorkflowCommandContract',
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
    console.error('Workflow-surface audit: THE INSTRUMENT IS BROKEN — a check cannot say YES.\n')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe')) {
    console.log('workflow-surface audit: all 6 probes found their planted fixtures')
    return
  }

  const findings = auditWorkflowCommands()
  if (wants('--json')) {
    console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2))
    if (findings.length > 0) process.exit(1)
    return
  }
  if (findings.length > 0) {
    console.error(
      `Workflow-surface audit: ${findings.length} finding(s). The 3.10 cutover's claims are:\n` +
        '  · every workflow mutation is DERIVED from its contract (no hand-written procedure)\n' +
        '  · `workflowInputs` and `WorkflowService.dispatch` stay deleted\n' +
        '  · there is ONE idempotency ledger, reached through ONE door\n' +
        '  · every workflow contract DECLARES its visibility class\n',
    )
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(1)
  }
  console.log(
    'workflow-surface audit OK — the derived surface is total, the deleted tables stayed deleted, ' +
      'the ledger has one door, every contract is classified',
  )
}

if (import.meta.main) main()
