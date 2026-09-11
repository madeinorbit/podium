import { expect, it } from 'vitest'
import { issueStallComposition } from './issue-stall-composition'
it('counts truncated issue SELECTs and separates builds and denominators', () => {
  const issue = 'select "id", "owner_user_id", "visibility", "created_by_actor", "created_by_on_behalf_of", "repo_path", "repo_id", "seq…'
  const records = ['before', 'after'].map(v => JSON.stringify({v, ts: 't', msg: 'server event-loop stall', sql: `2x/1ms/2rows ${issue} | 3x/0ms/0rows select resource_kind, resource_id, grantee, verb, owner, visibility… | 4x/0ms/0rows select count(*) from "messages" | 1x/0ms/0rows select value from meta`}))
  expect(issueStallComposition(['noise', ...records].join('\n'))).toEqual(Object.fromEntries(['before', 'after'].map(v => [v, { first: 't', last: 't', stalls: 1, total: 10, issues: 2, grants: 3, messages: 4, issuePercent: 20, issuePercentExcludingGrantsAndMessages: 200 / 3 }])))
})
