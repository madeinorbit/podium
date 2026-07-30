/**
 * The spec-surface audit, in a LANE (POD-386).
 *
 * `scripts/audit-spec-commands.ts` is a gate somebody has to type. This puts it
 * in the unit lane so it is a standing regression tripwire, and it asserts the
 * two things a gate needs to be believed:
 *
 *  1. it is CLEAN against the live tree — the claim;
 *  2. each check FIRES on a fixture containing what it hunts — the instrument.
 *
 * (2) is not decoration. Three of the four checks are absence claims, and an
 * absence is exactly what a broken scanner reports; a suite asserting only (1)
 * would stay green against a scanner that matched nothing at all.
 */

import { describe, expect, it } from 'vitest'
import {
  auditSpecCommands,
  handWrittenSpecMutations,
  missingDerivedSpread,
  restatedWriteSchemas,
  undeclaredContractFields,
} from './audit-spec-commands'

describe('the spec-surface audit, against the live tree', () => {
  it('is clean', () => {
    expect(auditSpecCommands()).toEqual([])
  })
})

describe('every check can say YES', () => {
  it('finds a hand-written mutation planted at the END of the specs router', () => {
    const findings = handWrittenSpecMutations(
      [
        '  specs: t.router({',
        '    list: t.procedure.input(specsInputs.list).query(() => []),',
        '    ...specFamily,',
        '    smuggled: t.procedure.mutation(() => undefined),',
        '  }),',
      ].join('\n'),
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['derived-surface'])
    expect(findings[0]?.detail).toContain('specs.smuggled')
  })

  it('treats a MISSING specs router as a finding, not as a pass', () => {
    expect(handWrittenSpecMutations('const unrelated = 1\n', '<fixture>')).toHaveLength(1)
  })

  it('finds a specs router that serves nothing derived', () => {
    const findings = missingDerivedSpread(
      '  specs: t.router({\n    list: t.procedure.query(() => []),\n  }),',
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['derived-surface-present'])
  })

  it('finds a contract with no visibility class and one with no exposure', () => {
    const findings = undeclaredContractFields(
      [
        'export const noClassContract = {',
        "  name: 'specs.a',",
        '  exposure: SERVED_ON,',
        '} as const satisfies CommandContract<typeof a>',
        '',
        'export const noExposureContract = {',
        "  name: 'specs.b',",
        "  visibility: 'owned-compute',",
        '} as const satisfies CommandContract<typeof b>',
      ].join('\n'),
      '<fixture>',
    )
    expect(findings.map((f) => f.detail.match(/no `(\w+)`/)?.[1])).toEqual([
      'visibility',
      'exposure',
    ])
  })

  it('finds a write schema RESTATED instead of shared — the fork no wire fixture sees', () => {
    const findings = restatedWriteSchemas(
      [
        'export const specsInputs = {',
        '  create: z.object({ ...byRepo, title: z.string().min(1), parent: z.string() }),',
        '  save: specsSaveInput,',
        '  remove: specsRemoveInput,',
        '} as const',
      ].join('\n'),
      '<fixture>',
    )
    expect(findings.map((f) => f.check)).toEqual(['one-schema-instance'])
    expect(findings[0]?.detail).toContain('specsCreateInput')
  })

  it('treats an ABSENT specsInputs table as a finding, not as a pass', () => {
    expect(restatedWriteSchemas('const unrelated = 1\n', '<fixture>')).toHaveLength(1)
  })
})

describe('every check can say NO', () => {
  const CLEAN_ROUTER = [
    '  specs: t.router({',
    '    list: t.procedure.input(specsInputs.list).query(() => []),',
    '    get: t.procedure.input(specsInputs.get).query(() => null),',
    '    ...specFamily,',
    '    search: t.procedure.input(specsInputs.search).query(() => []),',
    '  }),',
  ].join('\n')

  it('does not fire on a clean specs router', () => {
    expect(handWrittenSpecMutations(CLEAN_ROUTER, '<fixture>')).toEqual([])
    expect(missingDerivedSpread(CLEAN_ROUTER, '<fixture>')).toEqual([])
  })

  it('does not fire on a table that mounts the contract schemas by name', () => {
    expect(
      restatedWriteSchemas(
        [
          'export const specsInputs = {',
          '  list: z.object({ ...byRepo }),',
          '  create: specsCreateInput,',
          '  save: specsSaveInput,',
          '  remove: specsRemoveInput,',
          '  search: z.object({ ...byRepo, query: z.string() }),',
          '} as const',
        ].join('\n'),
        '<fixture>',
      ),
    ).toEqual([])
  })
})
