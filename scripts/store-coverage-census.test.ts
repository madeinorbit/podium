/** The Stage A measurement document is historical evidence, not today's
 * coverage claim. Exercise enumeration and drift against explicit fixtures. */

import { describe, expect, it } from 'vitest'
import { blockingDrift, censusDrift, memberKey, membersOfSource } from './store-coverage-census'

const members = membersOfSource(
  'fixture.ts',
  `export class Repo {
  first() {}
  second() {}
}`,
)
const markdown =
  '\n## Full table\n' +
  members
    .map(
      (member) =>
        `| \`${member.file}\` | ${member.className} | \`${member.member}\` | ${member.line} | yes | fixture-lane | — |`,
    )
    .join('\n')
const population = { members, named: new Map<string, string[]>() }

describe('census drift over an explicit measured population', () => {
  it('accepts a matching measurement', () => {
    expect(blockingDrift(censusDrift(markdown, population))).toBe(0)
  })
  it('names a member whose row was never written', () => {
    const drift = censusDrift(
      markdown
        .split('\n')
        .filter((line) => !line.includes('`first`'))
        .join('\n'),
      population,
    )
    expect(drift.added.map((member) => member.member)).toEqual(['first'])
    expect(blockingDrift(drift)).toBeGreaterThan(0)
  })
  it('names a measured row whose member is gone', () => {
    const drift = censusDrift(markdown, { ...population, members: members.slice(1) })
    expect(drift.removed.map((member) => member.member)).toEqual(['first'])
    expect(blockingDrift(drift)).toBeGreaterThan(0)
  })
  it('does not block on a declaration moving to another line', () => {
    const drift = censusDrift(markdown, {
      ...population,
      members: members.map((member) => ({ ...member, line: member.line + 1 })),
    })
    expect(drift.moved).toHaveLength(members.length)
    expect(blockingDrift(drift)).toBe(0)
  })
  it('reports lost naming evidence without inventing coverage measurements', () => {
    const named = markdown.replaceAll('| — |', '| fixture.test.ts |')
    expect(censusDrift(named, population).namingLost.map((member) => member.member)).toEqual([
      'first',
      'second',
    ])
    expect(
      censusDrift(named, {
        ...population,
        named: new Map(members.map((member) => [memberKey(member), ['fixture.test.ts']])),
      }).namingLost,
    ).toEqual([])
  })
})

describe('the enumeration follows the rules the census states', () => {
  const source = `
    export class Repo {
      constructor(readonly db: unknown) {}
      private hidden(): void {}
      protected alsoHidden(): void {}
      #reallyHidden(): void {}
      readonly notAFunction = 41
      method(): void {}
      get accessor(): number { return 1 }
      set accessor(value: number) {}
      arrow = (): void => {}
    }
    class NotExported {
      method(): void {}
    }
  `

  it('takes methods, accessors and arrow properties, and nothing else', () => {
    expect(membersOfSource('fixture.ts', source).map((m) => m.member)).toEqual([
      'method',
      'accessor',
      'accessor',
      'arrow',
    ])
  })

  it('ignores a class the module does not export', () => {
    expect(membersOfSource('fixture.ts', source).every((m) => m.className === 'Repo')).toBe(true)
  })
})
