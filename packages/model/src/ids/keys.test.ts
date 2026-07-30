import { describe, expect, it } from 'vitest'
import { asIssueId, asMachineId, asSessionId, asUserId } from './brands'
import {
  ENTITY_KINDS,
  type EntityRef,
  joinKeyParts,
  machineScopedKey,
  parseMachineScopedKey,
  parseResumeKey,
  parseSubjectResourceKey,
  parseUserEntityKey,
  resumeKey,
  splitKeyParts,
  subjectResourceKey,
  userEntityKey,
} from './keys'

const user = asUserId('alice')
const session = (id: string): EntityRef => ({ kind: 'session', id: asSessionId(id) })
const issue = (id: string): EntityRef => ({ kind: 'issue', id: asIssueId(id) })

// Parts chosen to attack the escaping: each contains a separator used by one of
// the key shapes, plus the escape character itself, plus a part that would look
// like a valid two-part key on its own.
const HOSTILE = ['a:b', 'a\\b', 'a\nb', '\\', ':', '\n', 'a\\:b', '', 'x:y:z']

describe('joinKeyParts / splitKeyParts', () => {
  it('round-trips every hostile part combination on every separator', () => {
    for (const sep of [':', '\n', '/']) {
      for (const a of HOSTILE) {
        for (const b of HOSTILE) {
          expect(splitKeyParts(sep, joinKeyParts(sep, [a, b]), 2)).toEqual([a, b])
        }
      }
    }
  })

  it('is injective: no two distinct part tuples collide on one key', () => {
    const seen = new Map<string, string[]>()
    for (const a of HOSTILE) {
      for (const b of HOSTILE) {
        const key = joinKeyParts(':', [a, b])
        const prior = seen.get(key)
        expect(prior, `collision on ${JSON.stringify(key)}`).toBeUndefined()
        seen.set(key, [a, b])
      }
    }
  })

  it('keeps the legacy byte shape when no part contains the separator or a backslash', () => {
    // The adoption property: mirror.ts / session-identity.ts can switch to these
    // helpers without invalidating a single existing in-memory key.
    expect(joinKeyParts('\n', ['m1', 'native-1'])).toBe('m1\nnative-1')
    expect(joinKeyParts(':', ['claude-session', 'abc'])).toBe('claude-session:abc')
  })

  it('refuses a key of the wrong arity rather than silently dropping a part', () => {
    expect(() => splitKeyParts(':', 'a:b:c', 2)).toThrow(/expected 2 parts, got 3/)
    expect(() => splitKeyParts(':', 'a', 2)).toThrow(/expected 2 parts, got 1/)
  })

  it('refuses a malformed escape rather than accepting an alias of a valid key', () => {
    expect(() => splitKeyParts(':', 'a\\', 2)).toThrow(/malformed escape/)
    expect(() => splitKeyParts(':', 'a\\zb:c', 2)).toThrow(/malformed escape/)
  })
})

describe('userEntityKey — the per-user state key (POD-1076)', () => {
  it('round-trips, including hostile ids', () => {
    for (const id of HOSTILE.filter((p) => p !== '')) {
      const key = userEntityKey(user, session(id))
      expect(parseUserEntityKey(key)).toEqual({ user, kind: 'session', id })
    }
  })

  it('round-trips a hostile USER part too, not only the entity part', () => {
    // Both halves are branded, so both must be escaped — POD-360 flagged that
    // every earlier helper was (brand, raw) and only escaped one side.
    for (const u of HOSTILE.filter((p) => p !== '')) {
      const key = userEntityKey(asUserId(u), issue('i1'))
      expect(parseUserEntityKey(key)).toEqual({ user: u, kind: 'issue', id: 'i1' })
    }
  })

  it('separates two entity KINDS that share one id string', () => {
    // The counterfactual this test exists for: with the kind absent from the key,
    // these two would be the same row, and one user's readAt on a session would
    // overwrite their readAt on an issue.
    expect(userEntityKey(user, session('x'))).not.toBe(userEntityKey(user, issue('x')))
    expect(parseUserEntityKey(userEntityKey(user, session('x'))).kind).toBe('session')
    expect(parseUserEntityKey(userEntityKey(user, issue('x'))).kind).toBe('issue')
  })

  it('separates two USERS with the same entity', () => {
    expect(userEntityKey(asUserId('alice'), issue('i1'))).not.toBe(
      userEntityKey(asUserId('bob'), issue('i1')),
    )
  })

  it('refuses an unknown entity kind on parse — fails closed', () => {
    // A kind this build cannot construct must not come back as if it could:
    // the caller narrows on `kind` to pick a brand.
    expect(() => parseUserEntityKey(joinKeyParts(':', ['alice', 'quokka', 'q1']))).toThrow(
      /unknown entity kind/,
    )
  })

  it('refuses an empty part on BOTH sides, so parse ∘ join is total', () => {
    expect(() => userEntityKey(asUserId(''), issue('i1'))).toThrow(/must not be empty/)
    expect(() => userEntityKey(user, issue(''))).toThrow(/must not be empty/)
    expect(() => parseUserEntityKey(joinKeyParts(':', ['', 'issue', 'i1']))).toThrow(/empty user/)
    expect(() => parseUserEntityKey(joinKeyParts(':', ['alice', 'issue', '']))).toThrow(/empty id/)
  })

  it('covers every declared entity kind', () => {
    // Not a smoke test: it pins that ENTITY_KINDS and the key constructor agree
    // at RUNTIME, where the compile-time equality assertion cannot reach.
    for (const kind of ENTITY_KINDS) {
      const key = userEntityKey(user, { kind, id: 'z' } as EntityRef)
      expect(parseUserEntityKey(key)).toEqual({ user, kind, id: 'z' })
    }
  })
})

describe('subjectResourceKey — the grants-edge key (ADR 9 D2)', () => {
  const alice = { kind: 'user', id: asUserId('alice') } as const

  it('round-trips, including hostile ids on either side', () => {
    for (const id of HOSTILE.filter((p) => p !== '')) {
      expect(parseSubjectResourceKey(subjectResourceKey(alice, session(id)))).toEqual({
        subject: { kind: 'user', id: 'alice' },
        resource: { kind: 'session', id },
      })
      expect(
        parseSubjectResourceKey(subjectResourceKey({ kind: 'user', id: asUserId(id) }, issue('i'))),
      ).toEqual({ subject: { kind: 'user', id }, resource: { kind: 'issue', id: 'i' } })
    }
  })

  it('separates the same subject over two resource kinds with one id', () => {
    expect(subjectResourceKey(alice, session('x'))).not.toBe(subjectResourceKey(alice, issue('x')))
  })

  it('can name a machine resource — §3.1.4 M1 grants verbs per machine', () => {
    const machine: EntityRef = { kind: 'machine', id: asMachineId('m1') }
    expect(parseSubjectResourceKey(subjectResourceKey(alice, machine)).resource).toEqual({
      kind: 'machine',
      id: 'm1',
    })
  })

  it('refuses an unknown subject kind and an unknown resource kind — fails closed', () => {
    expect(() =>
      parseSubjectResourceKey(joinKeyParts(':', ['group', 'devs', 'issue', 'i1'])),
    ).toThrow(/unknown grant subject kind/)
    expect(() =>
      parseSubjectResourceKey(joinKeyParts(':', ['user', 'alice', 'quokka', 'q1'])),
    ).toThrow(/unknown entity kind/)
  })

  it('is arity-4, so a verb cannot be appended onto its output and still parse', () => {
    // The single-home rule made testable: a per-verb key is a FOUR-part join with
    // the verb as a fifth part, never a concatenation on top of this key.
    const key = subjectResourceKey(alice, issue('i1'))
    expect(() => parseSubjectResourceKey(`${key}:use`)).toThrow(/expected 4 parts, got 5/)
  })
})

describe('the two legacy shapes (moved verbatim from @podium/protocol)', () => {
  it('machineScopedKey round-trips and rejects a malformed key', () => {
    const key = machineScopedKey(asMachineId('m\n1'), 'native\\id')
    expect(parseMachineScopedKey(key)).toEqual({ machineId: 'm\n1', nativeId: 'native\\id' })
    expect(() => parseMachineScopedKey('no-separator')).toThrow(/malformed machine-scoped key/)
    expect(() => parseMachineScopedKey('\nnative')).toThrow(/malformed machine-scoped key/)
  })

  it('resumeKey round-trips EVERY constructor output, including an empty kind', () => {
    // ResumeRef allows an empty kind, so `:value` is a legitimate constructor
    // output and the parser must accept it — unlike machineScopedKey, whose
    // machineId half may not be empty.
    expect(parseResumeKey(resumeKey('', 'v'))).toEqual({ kind: '', value: 'v' })
    expect(parseResumeKey(resumeKey('codex-thread', 'a:b'))).toEqual({
      kind: 'codex-thread',
      value: 'a:b',
    })
  })
})
