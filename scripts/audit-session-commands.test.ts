/**
 * The session-surface audit, in a LANE (POD-521; the audit itself is POD-382).
 *
 * THE GAP THIS CLOSES. `audit-session-commands.ts` was the one audit in this
 * family reachable ONLY through `bun run audit:sessions` — a command someone has
 * to remember. `workflow-cutover.audit.test.ts` said so in as many words when it
 * chose to spawn its own scanner instead: keeping the two halves separate "gives
 * up" having the gate in `bun run test`. POD-521 moved the workflow and automation
 * scanners into this package rather than spawning them from `apps/server`, which
 * makes the missing session equivalent an ordinary omission rather than a design
 * choice. It is now a standing tripwire in the default lane, in the package that
 * owns the scanner's source and its repository-wide inputs.
 *
 * Two claims, and the second is the one that matters:
 *
 *  1. the audit is CLEAN against the live tree;
 *  2. every check FIRES on a fixture containing what it hunts.
 *
 * Every check here is an absence claim, and an absence is exactly what a broken
 * scanner reports. A suite asserting only (1) stays green against a scanner that
 * matched nothing at all.
 *
 * The RUNTIME half stays in `apps/server/src/session-cutover.audit.test.ts`, where
 * the running router, the real contracts and the real refusals are. Neither half
 * can replace the other.
 */

import { describe, expect, it } from 'vitest'
import {
  auditSessionCommands,
  handWrittenSessionMutations,
  probe,
  routerBlock,
  serviceIdempotencyWrapper,
  undeclaredVisibility,
} from './audit-session-commands'

describe('the session-surface audit, against the live tree', () => {
  it('is clean', () => {
    expect(auditSessionCommands()).toEqual([])
  })

  it('and its instrument is not broken — EVERY check finds its planted fixture', () => {
    // Exactly what `bun run audit:sessions` runs before the gate, asserted here as
    // a value rather than reached through a process exit code. Asserted whole, so
    // a check added to the scanner is covered from the moment it exists.
    expect(probe()).toEqual([])
  })
})

describe('the checks whose failure mode is a serene zero', () => {
  it('finds a hand-written mutation planted at the END of a family router literal', () => {
    // Past a nested object literal, which is where a line-scanning reader stops
    // and reports a confident zero.
    const findings = handWrittenSessionMutations(
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
      '<fixture>',
    )
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.map((f) => f.check)).toContain('derived-surface')
  })

  it('treats a MISSING router as a finding, not as a pass', () => {
    // The arm that turns "I renamed the router" into a red rather than into a
    // serene zero — a router that vanished is not a router with no hand-written
    // mutations.
    expect(routerBlock('const nothing = 1\n', 'sessions')).toBeUndefined()
    expect(handWrittenSessionMutations('const nothing = 1\n', '<fixture>').length).toBeGreaterThan(
      0,
    )
  })

  it('finds a service-level idempotency wrapper regrowing beside the framework ledger', () => {
    // The textual half of AC2. The runtime half in `session-cutover.audit.test.ts`
    // reads the live prototype; this one sees the source before anything is built,
    // and catches a wrapper on a service the runtime check does not construct.
    expect(
      serviceIdempotencyWrapper(
        ['class SessionLifecycle {', '  withMutation(id: string, fn: () => void) {}', '}'].join(
          '\n',
        ),
        '<fixture>',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('finds a contract declaring no visibility, exposure or policy — three separate findings', () => {
    const findings = undeclaredVisibility(
      ['const sessionsForgotten: CommandDef = {', "  name: 'sessions.forgotten',", '}'].join('\n'),
      '<fixture>',
    )
    expect(findings.map((f) => f.check).sort()).toEqual([
      'exposure-totality',
      'policy-totality',
      'visibility-totality',
    ])
  })

  it('and does not accept PROSE as a declaration', () => {
    // POD-310's prose-shadowing finding: a comment or a rationale string that
    // happens to contain `visibility:` is not a declaration, and a check keyed on
    // raw text would be held green by one.
    const findings = undeclaredVisibility(
      [
        'const sessionsShadowed: CommandDef = {',
        "  name: 'sessions.shadowed',",
        "  rationale: 'visibility: personal, exposure: trpc, policy: self',",
        '}',
      ].join('\n'),
      '<fixture>',
    )
    expect(findings.map((f) => f.check).sort()).toEqual([
      'exposure-totality',
      'policy-totality',
      'visibility-totality',
    ])
  })
})
