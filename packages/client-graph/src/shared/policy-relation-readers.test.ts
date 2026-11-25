import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  POLICY_RELATION_READERS,
  type PolicyRelationReader,
  policyRelationReaderProblems,
} from './policy-relation-readers'
import { RAW_RELATION_READERS } from './raw-relation-readers'

const source = (file: string) =>
  readFileSync(new URL(file, new URL('../../../../', import.meta.url)), 'utf8')

const entry: PolicyRelationReader = {
  reader: 'SidebarRow.children',
  relation: 'issue.children',
  bound: ['issueProjection.sidebar', 'issueProjection > issueProjection.one'],
  covers: 'open issues, with every ancestor of a held issue',
  why: 'The sidebar nests the open children.',
  file: 'row.ts',
  declaration: 'get children()',
}
const check = (overrides: Partial<PolicyRelationReader>, text = 'get children() {}') =>
  policyRelationReaderProblems(() => text, [{ ...entry, ...overrides }])

it('accepts every declared policy reader as it stands', () => {
  expect(
    policyRelationReaderProblems(source, POLICY_RELATION_READERS, RAW_RELATION_READERS),
  ).toEqual([])
})

it('accepts a reader bounded by policy collections and what they come with', () => {
  expect(check({})).toEqual([])
  expect(
    check({
      relation: 'issue.pageSessions',
      bound: ['issueProjection.sidebar > session.ofIssue', 'session.recent'],
    }),
  ).toEqual([])
})

it('rejects a bound the policy does not hold, or one that does not bring the target', () => {
  expect(check({ bound: ['issueProjection.byStage'] })).toEqual([
    'SidebarRow.children -> issue.children: bound issueProjection.byStage is not a collection the policy holds',
    'SidebarRow.children -> issue.children: no bound brings issueProjection, the records issue.children reads',
  ])
  expect(check({ bound: ['session.live'] })).toEqual([
    'SidebarRow.children -> issue.children: no bound brings issueProjection, the records issue.children reads',
  ])
  expect(check({ bound: ['issueProjection.recent > session.ofIssue'] })).toEqual([
    'SidebarRow.children -> issue.children: issueProjection.recent does not come with session.ofIssue',
    'SidebarRow.children -> issue.children: no bound brings issueProjection, the records issue.children reads',
  ])
  expect(check({ bound: ['session > issueProjection.tree'] })).toEqual([
    'SidebarRow.children -> issue.children: a session record does not come with issueProjection.tree',
    'SidebarRow.children -> issue.children: no bound brings issueProjection, the records issue.children reads',
  ])
})

it('rejects a comes-with bound keyed by another field, and a declaration that does not say what its bounds hold', () => {
  // Born sessions name the issue by refIssueId; the sidebar comes with sessions by issueId.
  expect(
    check({
      relation: 'issue.bornSessions',
      bound: ['issueProjection.sidebar > session.ofIssue', 'session.recent'],
    }),
  ).toEqual([
    'SidebarRow.children -> issue.bornSessions: bound issueProjection.sidebar > session.ofIssue is keyed by issueId, not by refIssueId, the key issue.bornSessions reads',
  ])
  // A bound that holds only some of the members must say so: asking sessions are not all of them.
  expect(
    check({ relation: 'issue.missionSessions', bound: ['session.asking'], covers: '' }),
  ).toEqual([
    'SidebarRow.children -> issue.missionSessions: a policy reader must say which records its bounds hold (covers)',
  ])
})

it('rejects a relation that needs no declaration, a missing reason and a stale reader', () => {
  expect(check({ relation: 'issue.treeParent' })).toEqual([
    'SidebarRow.children -> issue.treeParent: issue.treeParent is present, so a raw read needs no declaration; remove it',
  ])
  expect(check({ why: ' ' })).toEqual([
    'SidebarRow.children -> issue.children: a policy reader needs its reason',
  ])
  expect(check({}, 'class Row {}')).toEqual([
    'SidebarRow.children -> issue.children: reader is gone from row.ts; remove its policy reader declaration',
  ])
  expect(policyRelationReaderProblems(() => 'get children()', [entry], [{ ...entry }])).toEqual([
    'SidebarRow.children -> issue.children: declared both as a policy reader and as a raw reader exception',
  ])
})
