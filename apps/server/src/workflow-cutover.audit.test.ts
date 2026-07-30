/**
 * THE RUNTIME HALF of the 3.10 workflow cutover gate (POD-732; POD-424's
 * criterion for this router).
 *
 * `scripts/audit-workflow-commands.ts` is the other half, and the two are
 * instruments of DIFFERENT KINDS rather than two of the same kind agreeing:
 *
 *  - THE SCRIPT reads source TEXT and resolves no modules. It runs in a fresh
 *    checkout before anything is built, and it catches the textual regressions a
 *    runtime check cannot see — a `.mutation(` written back into the router
 *    literal, `workflowInputs` regrowing, a transport reaching
 *    `dispatchWorkflowCommand` directly and so gaining a second ledger.
 *  - THIS FILE reads the RUNNING router. It is the only thing that can prove the
 *    derived surface actually EXISTS with the right verbs — a script that saw an
 *    empty router literal would report a serene zero hand-written mutations.
 *
 * Running the script's checks here too is deliberate, and it is what puts the
 * gate in `bun run test` rather than in a command someone has to remember.
 */

import { WORKFLOW_CONTRACTS } from '@podium/commands'
import { describe, expect, it } from 'vitest'
import { auditWorkflowCommands } from '../../../scripts/audit-workflow-commands'
import { WORKFLOW_QUERIES } from './modules/workflows/queries'
import { WORKFLOW_COMMANDS } from './modules/workflows/registry'
import { appRouter } from './router'

/** The tRPC internals the router exposes for introspection. */
function procedures(): Record<string, { _def: { type: string; inputs: unknown[] } }> {
  const record = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures
  const out: Record<string, { _def: { type: string; inputs: unknown[] } }> = {}
  for (const [path, proc] of Object.entries(record)) {
    if (path.startsWith('workflows.')) {
      out[path.slice('workflows.'.length)] = proc as {
        _def: { type: string; inputs: unknown[] }
      }
    }
  }
  return out
}

describe('POD-732 workflow cutover gate', () => {
  it('the source audit is clean — no hand-written mutation, no resurrected table, one ledger door', () => {
    expect(auditWorkflowCommands()).toEqual([])
  })

  /**
   * MECHANISM PRESENCE IS NOT COVERAGE. The audit above is an ABSENCE claim, and
   * an empty router satisfies it perfectly. This asserts the surface is TOTAL:
   * every declared command and every declared query is actually served, and
   * nothing else is.
   */
  it('every declared command and query is served, and nothing else is', () => {
    const served = procedures()
    expect(Object.keys(served).sort()).toEqual(
      [...Object.keys(WORKFLOW_COMMANDS), ...Object.keys(WORKFLOW_QUERIES)].sort(),
    )
  })

  /**
   * The VERB is read off the declaration, so a write cannot hide among the reads
   * by being served as a query — which is the one way a derived surface can pass
   * a `.mutation(` audit while still having a hand-shaped hole in it.
   */
  it('the wire verb matches the declaration: eleven mutations, seven queries', () => {
    const served = procedures()
    const verbs = Object.fromEntries(
      Object.entries(served).map(([name, proc]) => [name, proc._def.type]),
    )
    for (const name of Object.keys(WORKFLOW_COMMANDS)) {
      expect(verbs[name], `workflows.${name} is a declared command`).toBe('mutation')
    }
    for (const name of Object.keys(WORKFLOW_QUERIES)) {
      expect(verbs[name], `workflows.${name} is a declared query`).toBe('query')
    }
    expect(Object.values(verbs).filter((v) => v === 'mutation')).toHaveLength(11)
    expect(Object.values(verbs).filter((v) => v === 'query')).toHaveLength(7)
  })

  /**
   * DERIVED, not merely EQUIVALENT — asserted by object IDENTITY (`toBe`).
   *
   * A router that restated each schema beside the contract would satisfy every
   * check above and would pass a deep-equality assertion too, right up until
   * someone edited one copy. `toBe` can only pass if the procedure validates
   * with the CONTRACT'S OWN INSTANCE, which is the property that makes a
   * second declaration impossible rather than merely discouraged.
   *
   * This is also the whole of criterion "WorkflowsView writes dispatch
   * contracts": the web client is typed off `AppRouter`, so the input type at
   * every `trpc.workflows.*.mutate(…)` call site IS the contract's schema.
   */
  it("each mutation validates with its CONTRACT's own schema instance, not a copy", () => {
    const served = procedures()
    for (const [name, command] of Object.entries(WORKFLOW_CONTRACTS)) {
      expect(served[name]?._def.inputs, `workflows.${name} input schema`).toEqual([command.input])
      expect(served[name]?._def.inputs[0], `workflows.${name} input identity`).toBe(command.input)
    }
  })

  /**
   * The payloads `apps/web/src/features/workflows/WorkflowsView.tsx` actually
   * sends, run against the real derived procedures.
   *
   * A typecheck proves the CALL SITES compile; this proves the shapes they send
   * are accepted by the contract that now validates them. Without it, "the web
   * writes dispatch contracts" would rest entirely on inference nobody executed.
   */
  it('the payload shapes WorkflowsView sends are accepted by the contracts that now validate them', () => {
    const parse = (name: keyof typeof WORKFLOW_CONTRACTS, payload: unknown) =>
      WORKFLOW_CONTRACTS[name].input.safeParse(payload)
    expect(
      parse('create', {
        name: 'From the web',
        description: '',
        scope: 'global',
        instructions: '',
        steps: [],
      }).success,
    ).toBe(true)
    expect(parse('revise', { workflowId: 'wf_1', instructions: '', steps: [] }).success).toBe(true)
    expect(parse('publish', { revisionId: 'wfr_1' }).success).toBe(true)
    expect(
      parse('assign', { targetKind: 'global', targetId: '', revisionId: 'wfr_1' }).success,
    ).toBe(true)
    expect(
      parse('skip', { runId: 'wrun_1', stepId: 'build', reason: 'Skipped by operator' }).success,
    ).toBe(true)
    expect(parse('retry', { runId: 'wrun_1', stepId: 'build' }).success).toBe(true)
    expect(
      parse('profileSave', {
        name: 'Local claude',
        accountId: 'acct_1',
        harness: 'claude-code',
        model: 'opus',
        effort: 'high',
      }).success,
    ).toBe(true)
    // The counterfactual: these schemas do REFUSE, so the trues above are the
    // contract accepting rather than a schema that accepts anything.
    expect(parse('publish', {}).success).toBe(false)
    expect(parse('skip', { runId: 'wrun_1' }).success).toBe(false)
  })
})
