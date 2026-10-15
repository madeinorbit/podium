import { expect, it } from 'vitest'
import { issueStallComposition, topStallStatements } from './issue-stall-composition'
it('counts truncated issue SELECTs and separates builds and denominators', () => {
  const issue = 'select "id", "owner_user_id", "visibility", "created_by_actor", "created_by_on_behalf_of", "repo_path", "repo_id", "seq…'
  const records = ['before', 'after'].map(v => JSON.stringify({v, ts: 't', msg: 'server event-loop stall', sql: `2x/1ms/2rows ${issue} | 3x/0ms/0rows select resource_kind, resource_id, grantee, verb, owner, visibility… | 4x/0ms/0rows select count(*) from "messages" | 1x/0ms/0rows select value from meta`}))
  expect(issueStallComposition(['noise', ...records].join('\n'))).toEqual(Object.fromEntries(['before', 'after'].map(v => [v, { first: 't', last: 't', stalls: 1, total: 10, issues: 2, grants: 3, messages: 4, issuePercent: 20, issuePercentExcludingGrantsAndMessages: 200 / 3 }])))
})
it('ranks the statements named in stall records by count, per build', () => {
  const stall = (v: string, sql: string) => JSON.stringify({ v, ts: 't', msg: 'server event-loop stall', sql })
  const input = ['noise', stall('b', '5x/10ms/5rows select a | 1x/2ms/0rows select b'), stall('b', '2x/1.5ms/2rows select b | 2x/3ms/0rows select c'), stall('other', '9x/1ms/0rows select a')].join('\n')
  expect(topStallStatements(input, 2)).toEqual({
    b: [{ sql: 'select a', count: 5, wallMs: 10, stalls: 1 }, { sql: 'select b', count: 3, wallMs: 3.5, stalls: 2 }],
    other: [{ sql: 'select a', count: 9, wallMs: 1, stalls: 1 }],
  })
})
