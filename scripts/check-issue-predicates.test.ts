import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFile } from './check-boundaries'
import { checkIssuePredicates } from './check-issue-predicates'

const file = 'packages/client-graph/src/worklist/rollup.ts'
describe('shared issue lifecycle predicates', () => {
  it.each([
    "issue.stage === 'done'", "'done' !== issue.stage", "issue['stage'] == 'done'",
    "issue?.stage !== 'done'", "stage === 'done'", 'Boolean(issue.closedReason)',
    '!!issue.closedReason', 'issue.closedReason != null', "issue['closedReason'] === undefined",
    'issue.closedReason || fallback', 'issue.closedReason && fallback',
    'issue.closedReason ? yes : no', "typeof issue.closedReason === 'string'",
    'closedReason != null',
  ])('refuses %s', expression => {
    expect(checkIssuePredicates(file, `const answer = ${expression}`)).not.toEqual([])
  })
  it.each([
    'if (issue.closedReason) run()', 'while (issue.closedReason) run()',
    'do run(); while (issue.closedReason)', 'for (; issue.closedReason;) run()',
    'const why = issue.closedReason; if (why) run()',
    "const { closedReason: why } = issue; Boolean(why)",
    "const status = issue.stage; status === 'done'",
  ])('refuses boolean reads and scalar aliases: %s', source => {
    expect(checkIssuePredicates(file, source)).not.toEqual([])
  })
  it('allows shared predicates, payloads, reason copy, other stages and comments', () => {
    const source = `
      const finished = isFinished(issue)
      const closed = isClosed(issue)
      const excluded = isExcluded(issue)
      const payload = { closedReason: issue.closedReason, stage: issue.stage }
      const text = issue.closedReason ?? 'Done'
      const outcome = canonicalIssueCloseReason(issue.closedReason)
      const review = issue.stage === 'review'
      // issue.stage === 'done' || Boolean(issue.closedReason)
    `
    expect(checkIssuePredicates(file, source)).toEqual([])
  })
  it('checks generic TypeScript functions and JSX consumers with their native parsers', () => {
    expect(checkIssuePredicates(file, "const read = <T extends { stage: string }>(issue: T) => issue.stage === 'done'")).not.toEqual([])
    expect(checkIssuePredicates('apps/web/src/Row.tsx', 'const row = <span>{issue.closedReason ? yes : no}</span>')).not.toEqual([])
  })
  it('runs in the normal boundary lint and exempts only owners, tests and other domains', () => {
    const source = "const answer = issue.stage === 'done'"
    expect(checkFile(file, source).some(v => v.rule === 'issue-lifecycle-predicates')).toBe(true)
    for (const path of ['packages/client-graph/src/shared/predicates.ts',
      'packages/client-graph/src/worklist/rollup.test.ts', 'packages/model/src/predicates/issue-lifecycle.ts',
      'apps/server/src/modules/issues/service/crud.ts'])
      expect(checkIssuePredicates(path, source)).toEqual([])
  })
  it('has no duplicated closure checks in the real frontend source', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const findings = []
    for (const directory of ['packages/client-graph/src', 'tests/worklist/diagnostics',
      'packages/client-core/src/values', 'apps/web/src', 'apps/mobile/src']) {
      for (const entry of readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' })) {
        if (!/\.tsx?$/.test(entry)) continue
        const path = `${directory}/${entry}`
        findings.push(...checkIssuePredicates(path, readFileSync(join(root, path), 'utf8')))
      }
    }
    expect(findings).toEqual([])
  })
})
