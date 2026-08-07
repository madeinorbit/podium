/**
 * The workflow-surface audit, in a LANE (POD-521; the audit itself is POD-732).
 *
 * `scripts/audit-workflow-commands.ts` is a gate somebody has to type. This puts
 * it in the unit lane so it is a standing regression tripwire, and it asserts the
 * two things a gate needs to be believed:
 *
 *  1. it is CLEAN against the live tree — the claim;
 *  2. each check FIRES on a fixture containing what it hunts — the instrument.
 *
 * (2) is not decoration. Every check is an absence claim, and an absence is
 * exactly what a broken scanner reports; a suite asserting only (1) would stay
 * green against a scanner that matched nothing at all.
 *
 * WHY IT LIVES HERE AND NOT IN `apps/server`. It used to run from
 * `workflow-cutover.audit.test.ts` as a `spawnSync` of the real binary — twice,
 * once for `--probe` and once for `--json`. That put a scanner whose source and
 * whose repository-wide inputs both belong to `scripts` inside the server's cache
 * key, so every server edit replayed it, and it paid two Bun process starts on a
 * busy shared host to learn what an import can tell it. `audit-superagent-commands.test.ts`
 * had already written down the same conclusion and named this file as the
 * counterexample. The RUNTIME half — the derived router really exists, with the
 * right verbs, validating with the contracts' own schema instances — stays in
 * `apps/server`, where the running objects are. Neither half can replace the
 * other: a scanner that saw an empty router literal would report a serene zero
 * hand-written mutations, and a runtime check cannot see source text that has not
 * been built.
 */

import { describe, expect, it } from 'vitest'
import {
  auditWorkflowCommands,
  extraDispatchCallers,
  handWrittenWorkflowMutations,
  probe,
  resurrectedSecondSurface,
  routerBlock,
  undeclaredVisibility,
} from './audit-workflow-commands'

describe('the workflow-surface audit, against the live tree', () => {
  it('is clean', () => {
    expect(auditWorkflowCommands()).toEqual([])
  })

  it('and its instrument is not broken — EVERY check finds its planted fixture', () => {
    // The script's own probe, which the `--probe` subprocess used to run. Asserted
    // as a whole rather than restated case by case, so a check added to the script
    // is covered here from the moment it exists.
    expect(probe()).toEqual([])
  })
})

describe('every check can say YES', () => {
  it('finds a hand-written mutation planted at the END of the router literal', () => {
    // Past a nested object literal, which is where a line-scanning implementation
    // stops and reports zero.
    const findings = handWrittenWorkflowMutations(
      [
        '  workflows: t.router({',
        '    ...workflowFamilyProcedures(),',
        '    list: t.procedure.query(({ ctx }) => ctx.list()),',
        '    nested: t.procedure.input(z.object({ a: z.string() })).query(() => ({ ok: true })),',
        '    smuggled: t.procedure.mutation(() => undefined),',
        '  }),',
      ].join('\n'),
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['derived-surface'])
  })

  it('treats a MISSING router as a finding, not as a pass', () => {
    // The arm that turns "I renamed the router" into a red rather than a serene
    // zero — the phantom-zero failure the deletion audit exists to prevent.
    expect(routerBlock('const nothing = 1\n')).toBeUndefined()
    expect(handWrittenWorkflowMutations('const nothing = 1\n', '<fixture>')).toHaveLength(1)
  })

  it('finds both deleted second surfaces regrowing', () => {
    const findings = resurrectedSecondSurface(
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
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['no-second-surface', 'no-second-surface'])
  })

  it('finds a transport reaching the ledger door directly', () => {
    expect(
      extraDispatchCallers([
        [
          'apps/server/src/some-transport.ts',
          'return dispatchWorkflowCommand(proc, ctx, input, { ledger: myOwnLedger })\n',
        ],
      ]),
    ).toHaveLength(1)
  })

  it('and can still say NO: the check does not fire on its own allowed door', () => {
    // Otherwise it would be firing on the presence of the call rather than on the
    // caller, and `WorkflowService.execute` itself would be a permanent finding.
    expect(
      extraDispatchCallers([
        [
          'apps/server/src/modules/workflows/service.ts',
          'return dispatchWorkflowCommand(proc, ctx, input, {})\n',
        ],
      ]),
    ).toEqual([])
  })

  it('finds a contract added without its visibility class, and passes the one that declares it', () => {
    const findings = undeclaredVisibility(
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
      '<fixture>',
    )
    // Exactly one — the classified contract is not a false positive.
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('workflowForgottenContract')
  })
})
