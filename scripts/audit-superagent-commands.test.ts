/**
 * The superagent-surface audit, in a LANE (POD-383).
 *
 * `scripts/audit-superagent-commands.ts` is a gate somebody has to type. This
 * puts it in the unit lane so it is a standing regression tripwire, and it
 * asserts the two things a gate needs to be believed:
 *
 *  1. it is CLEAN against the live tree — the claim;
 *  2. each check FIRES on a fixture containing what it hunts — the instrument.
 *
 * (2) is not decoration. Every check is an absence claim, and an absence is
 * exactly what a broken scanner reports; a suite asserting only (1) would stay
 * green against a scanner that matched nothing at all. This imports the check
 * functions rather than spawning the binary — the real-binary path is covered
 * by `bun run audit:superagent`, which runs `--probe` before the gate, and
 * spawning is what makes the equivalent workflow test slow on a busy host.
 */

import { describe, expect, it } from 'vitest'
import {
  auditSuperagentCommands,
  duplicateFocusSchema,
  handWrittenSuperagentMutations,
  resurrectedSendAlias,
  routerBlock,
  undeclaredVisibility,
} from './audit-superagent-commands'

describe('the superagent-surface audit, against the live tree', () => {
  it('is clean', () => {
    expect(auditSuperagentCommands()).toEqual([])
  })
})

describe('every check can say YES', () => {
  it('finds a hand-written mutation planted at the END of the router literal', () => {
    const findings = handWrittenSuperagentMutations(
      [
        '  superagent: t.router({',
        '    ...superagentFamily,',
        '    history: t.procedure.input(z.object({ threadId: z.string() })).query(() => []),',
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
    expect(handWrittenSuperagentMutations('const nothing = 1\n', '<fixture>')).toHaveLength(1)
  })

  it('finds the send alias in either home, and NOT the one real entry', () => {
    expect(
      resurrectedSendAlias([['<fixture>', '  send: t.procedure.mutation(() => undefined),\n']]),
    ).toHaveLength(1)
    expect(
      resurrectedSendAlias([
        [
          '<fixture>',
          [
            '  sendTurn: { contract: C.sendTurn, handler: (s: S, i: I) => s.sendTurn(i) },',
            '  dispatch: { contract: C.dispatch, handler: (s: S, i: I) => s.sendTurn(i) },',
          ].join('\n'),
        ],
      ]),
    ).toHaveLength(1)
    // The counterfactual that keeps the gate closable: ONE forwarder is the real
    // entry and must not fire, or the check counts the entry rather than the alias.
    expect(
      resurrectedSendAlias([
        ['<fixture>', '  sendTurn: { contract: C.sendTurn, handler: (s: S, i: I) => s.sendTurn(i) },\n'],
      ]),
    ).toEqual([])
  })

  it('finds a second focus schema, and NOT the contract that owns it', () => {
    const restated = '  focusedSessionId: z.string().max(128).pipe(SessionIdField).optional(),\n'
    expect(duplicateFocusSchema([['apps/server/src/elsewhere.ts', restated]])).toHaveLength(1)
    expect(
      duplicateFocusSchema([['packages/commands/src/superagent/contracts.ts', restated]]),
    ).toEqual([])
  })

  it('finds a contract with no visibility class, and NOT one that has it', () => {
    const findings = undeclaredVisibility(
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
      '<fixture>',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.detail).toContain('superagentForgottenContract')
  })
})
