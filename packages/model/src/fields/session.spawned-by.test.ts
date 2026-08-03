/**
 * `spawnedBy` HAS ONE WRITER AND ONE READER (POD-1133, inventory D-17).
 *
 * POD-360 measured the cost of the freeform tag: six produced arms, exactly ONE
 * consumer that parsed it, SEVEN that rebuilt the template literal to compare —
 * five of them gating parent-session authorization. The failure mode is not a
 * crash, it is a SILENT "no": change the tag format and five authz checks answer
 * "not the parent" instead of failing loudly.
 *
 * These tests pin the three properties that make that failure mode unreachable:
 *
 *   1. ROUND TRIP — every arm the union can hold survives `spawnedByTag` →
 *      `parseSpawnedBy`. If it did not, a producer and a comparison site would
 *      disagree about the same session, which IS the bug.
 *   2. FAIL CLOSED — an unrecognised or malformed tag parses to `null`, never to
 *      a partially-filled arm. A parser that invented a `kind` would be worse
 *      than the seven hand-built comparisons, because it would be trusted.
 *   3. THE LEGACY CORPUS still parses. The tags already on disk were written by
 *      the hand-built literals, so the shared reader has to accept exactly what
 *      those wrote — otherwise this refactor silently reparents live sessions.
 */

import { describe, expect, it } from 'vitest'
import { asAutomationId, asIssueId, asSessionId, asThreadId } from '../ids'
import {
  isSpawnedBy,
  parseSpawnedBy,
  SpawnedByRef,
  spawnedByParentSessionId,
  spawnedByTag,
} from './session'

const S = asSessionId('ses_parent')
const I = asIssueId('iss_1133')
const T = asThreadId('thr_9')
const A = asAutomationId('aut_nightly')

/** Every arm, with both shapes of the two that carry an optional member. This
 *  list is the union's inhabitants — a new arm that is not added here is a
 *  compile error at `SpawnedByRef`, not a quietly untested case. */
const ARMS: readonly (readonly [SpawnedByRef, string])[] = [
  [{ kind: 'user' }, 'user'],
  [{ kind: 'system' }, 'system'],
  [{ kind: 'system', job: 'steward' }, 'system:steward'],
  [{ kind: 'agent' }, 'agent'],
  [{ kind: 'session', id: S }, 'session:ses_parent'],
  [{ kind: 'issue', id: I }, 'issue:iss_1133'],
  [{ kind: 'superagent' }, 'superagent'],
  [{ kind: 'superagent', threadId: T }, 'superagent:thr_9'],
  [{ kind: 'automation', id: A }, 'automation:aut_nightly'],
]

describe('spawnedByTag / parseSpawnedBy round-trip', () => {
  for (const [ref, tag] of ARMS) {
    it(`${tag} is the only spelling of ${JSON.stringify(ref)}`, () => {
      expect(spawnedByTag(ref)).toBe(tag)
      expect(parseSpawnedBy(tag)).toEqual(ref)
    })
  }

  it('the fixtures are real inhabitants of the union, not lookalike objects', () => {
    for (const [ref] of ARMS) {
      expect(SpawnedByRef.parse(ref)).toEqual(ref)
    }
  })
})

describe('parseSpawnedBy fails closed', () => {
  const REFUSED = [
    undefined,
    null,
    '',
    'steward', // documented for years, never produced — not an arm
    'operator',
    'session', // tagged arm with no value
    'session:', // tagged arm with an empty value
    ':ses_1', // no tag
    'sess:ses_1', // near-miss on a real tag
    'SESSION:ses_1', // case is not normalised — an unknown tag is unknown
    'unknown:x', // a tag shape nothing produces
  ]
  for (const tag of REFUSED) {
    it(`${JSON.stringify(tag)} parses to null, not a partial arm`, () => {
      expect(parseSpawnedBy(tag)).toBeNull()
    })
  }

  it('keeps a colon inside the VALUE rather than truncating it', () => {
    // Only the FIRST colon separates; an id containing one is not silently cut.
    expect(parseSpawnedBy('issue:iss:1')).toEqual({ kind: 'issue', id: asIssueId('iss:1') })
  })
})

describe('spawnedByParentSessionId', () => {
  it('extracts the parent from a session tag', () => {
    expect(spawnedByParentSessionId('session:ses_parent')).toBe(S)
  })

  it('is undefined for every arm that is not a parent session', () => {
    for (const [ref, tag] of ARMS) {
      if (ref.kind === 'session') continue
      expect(spawnedByParentSessionId(tag)).toBeUndefined()
    }
  })

  it('is undefined — not a throw and not a bare cast — for an unknown tag', () => {
    expect(spawnedByParentSessionId('steward')).toBeUndefined()
    expect(spawnedByParentSessionId(undefined)).toBeUndefined()
  })
})

describe('isSpawnedBy compares STRUCTURE, not two hand-built strings', () => {
  it('matches the arm it was written from', () => {
    expect(isSpawnedBy(spawnedByTag({ kind: 'session', id: S }), { kind: 'session', id: S })).toBe(
      true,
    )
    expect(isSpawnedBy(spawnedByTag({ kind: 'issue', id: I }), { kind: 'issue', id: I })).toBe(true)
  })

  it('refuses a different id under the same arm', () => {
    expect(
      isSpawnedBy('session:ses_parent', { kind: 'session', id: asSessionId('ses_other') }),
    ).toBe(false)
  })

  it('refuses a different arm carrying the same id', () => {
    expect(isSpawnedBy('issue:iss_1133', { kind: 'session', id: asSessionId('iss_1133') })).toBe(
      false,
    )
  })

  it('refuses an absent or unparseable tag rather than throwing', () => {
    expect(isSpawnedBy(undefined, { kind: 'session', id: S })).toBe(false)
    expect(isSpawnedBy('steward', { kind: 'session', id: S })).toBe(false)
  })

  it('matches the valueless arms exactly', () => {
    expect(isSpawnedBy('user', { kind: 'user' })).toBe(true)
    expect(isSpawnedBy('agent', { kind: 'user' })).toBe(false)
    // The optional member is part of the identity: a bare `superagent` is NOT
    // the same provenance as one carrying a thread.
    expect(isSpawnedBy('superagent', { kind: 'superagent' })).toBe(true)
    expect(isSpawnedBy('superagent', { kind: 'superagent', threadId: T })).toBe(false)
    expect(isSpawnedBy('superagent:thr_9', { kind: 'superagent' })).toBe(false)
  })
})

describe('the legacy corpus the hand-built literals wrote', () => {
  // Exactly the strings POD-360 found in production sites. Every one has to
  // survive, or this refactor reparents live sessions instead of retagging them.
  const PRODUCED = [
    'user',
    'agent',
    'system',
    'superagent',
    'superagent:thr_9',
    'session:ses_parent',
    'issue:iss_1133',
    'automation:aut_nightly',
  ]
  for (const tag of PRODUCED) {
    it(`${tag} still parses, and re-tags to itself`, () => {
      const ref = parseSpawnedBy(tag)
      expect(ref).not.toBeNull()
      expect(spawnedByTag(ref as SpawnedByRef)).toBe(tag)
    })
  }
})
