/**
 * The automation-surface audit, in a LANE (POD-521; the audit itself is POD-735).
 *
 * Same split, and the same reasoning, as `audit-workflow-commands.test.ts`:
 *
 *  1. the audit is CLEAN against the live tree — the claim;
 *  2. every check FIRES on a fixture containing what it hunts, and stays SILENT on
 *     a clean one — the instrument.
 *
 * (2) is the whole point. Every check here is an absence claim, and an absence is
 * exactly what a broken scanner reports, so a suite asserting only (1) would stay
 * green against a scanner that matched nothing at all.
 *
 * WHY IT LIVES HERE AND NOT IN `apps/server`. `automation-cutover.audit.test.ts`
 * used to `spawnSync` this script twice per run — once for `--probe`, once for
 * `--json`. The scanner's source and its repository-wide inputs both belong to
 * `scripts`, so that arrangement put them inside the server's cache key and
 * replayed two Bun process starts on every server edit. The RUNTIME half of that
 * gate — the derived router exists with the right verbs, the contracts' own schema
 * instances validate it, and the relay really refuses every automation write —
 * stays in `apps/server`, because only running objects can prove a gate refuses.
 */

import { describe, expect, it } from 'vitest'
import {
  auditAutomationCommands,
  duplicateCronParser,
  handWrittenMutations,
  missingDerivedSpread,
  missingSubjects,
  probe,
  resurrectedSchemas,
  routerBlock,
} from './audit-automation-commands'

describe('the automation-surface audit, against the live tree', () => {
  it('is clean', () => {
    expect(auditAutomationCommands()).toEqual([])
  })

  it('and its instrument is not broken — EVERY check finds its planted fixture', () => {
    // The script's own probe, which the `--probe` subprocess used to run. It
    // covers both directions for every check (fires on dirty, silent on clean).
    // Asserted as a whole so a check added to the script is covered from the
    // moment it exists, rather than when someone remembers to copy a fixture.
    expect(probe()).toEqual([])
  })
})

describe('the checks whose failure mode is a serene zero', () => {
  it('reports a MOVED subject as a finding about the cutover, not as silence', () => {
    // An audit that cannot find its subject has not passed. The port is injected
    // so this needs no filesystem sleight of hand.
    expect(missingSubjects(() => false).map((f) => f.check)).toEqual([
      'subject-present',
      'subject-present',
      'subject-present',
    ])
    expect(missingSubjects(() => true)).toEqual([])
  })

  it('treats a MISSING router as a finding, not as a pass', () => {
    expect(routerBlock('const nothing = 1\n')).toBeUndefined()
    expect(handWrittenMutations('const nothing = 1\n', '<fixture>')).toHaveLength(1)
  })

  it('finds a hand-written mutation planted at the END of the router literal', () => {
    // Past a nested literal, which is where a line-scanning reader stops.
    const findings = handWrittenMutations(
      [
        '  automations: t.router({',
        '    ...automationProcedures(),',
        '    list: t.procedure.query(({ ctx }) => mods(ctx).automations.list()),',
        '    runs: t.procedure',
        '      .input(z.object({ automationId: z.string().min(1) }))',
        '      .query(({ ctx, input }) => mods(ctx).automations.runs(input.automationId)),',
        '    smuggled: t.procedure.mutation(() => undefined),',
        '  }),',
      ].join('\n'),
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['derived-surface'])
  })

  it('finds a router that serves reads but never spreads the derived procedures', () => {
    // The inverse hole: no hand-written mutation to find, and no derived surface
    // either. The `.mutation(` check alone is serene about it.
    expect(
      missingDerivedSpread(
        '  automations: t.router({\n    list: t.procedure.query(() => []),\n  }),',
        '<fixture>',
      ),
    ).toHaveLength(1)
  })

  it('finds the deleted schema table regrowing, and ignores the comment that names it', () => {
    expect(
      resurrectedSchemas('const automationPatch = automationFields.partial()\n', '<fixture>'),
    ).toHaveLength(1)
    // Keyed on the DECLARATION, not on any mention — the comments explaining the
    // deletion name it, and a check firing on those is one nobody can keep green.
    expect(
      resurrectedSchemas('// automationPatch moved to @podium/commands\n', '<fixture>'),
    ).toEqual([])
  })

  it('finds a second cron parser in either direction', () => {
    // Both arms: a server-side parser existing, and the contract failing to import
    // the one shared parser.
    expect(
      duplicateCronParser(
        ["import { isValidCron } from './cron'"].join('\n'),
        () => true,
      ),
    ).toHaveLength(1)
    expect(duplicateCronParser('no import here', () => false)).toHaveLength(1)
    expect(
      duplicateCronParser(["import { isValidCron } from './cron'"].join('\n'), () => false),
    ).toEqual([])
  })
})
