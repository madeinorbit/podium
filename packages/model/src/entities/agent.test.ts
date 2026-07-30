import { describe, expect, it } from 'vitest'
import {
  AgentKind,
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  HarnessAgent,
  HarnessId,
  isAgentKind,
  isBuiltinHarnessKind,
} from './agent'

/**
 * POD-303's open/closed split, tested at the DEFINITION site. `@podium/harness`'s
 * registry.test.ts covers the same split at the registry — that one proves an
 * unknown id yields no manifest; this one proves the vocabulary itself admits the
 * id in the first place, which is the half that has to work for the frame to parse
 * at all.
 */
describe('HarnessId — open on the wire (POD-303)', () => {
  it('parses a harness name this build has never heard of', () => {
    // OPEN: a newer peer may name a harness this build does not ship. Rejecting the
    // value would fail the whole frame — taking a live session offline over a name.
    const unknown = HarnessId.safeParse('some-harness-from-2027')
    expect(unknown.success).toBe(true)
    expect(unknown.success && unknown.data).toBe('some-harness-from-2027')
    // Every builtin kind is also a valid HarnessId — the closed set is a SUBSET of
    // the open type, not a parallel vocabulary.
    for (const kind of BUILTIN_HARNESS_KINDS) expect(HarnessId.safeParse(kind).success).toBe(true)
  })

  it('rejects only the empty string, which names nothing', () => {
    // The one thing "open" must still refuse: '' is not a degraded identity, it is
    // the absence of one, and it would silently match a missing field.
    expect(HarnessId.safeParse('').success).toBe(false)
  })

  it('degrades an unknown id to "not builtin" rather than throwing or guessing', () => {
    // The narrowing gate is a PREDICATE, not a parser that throws and not a lookup
    // with a fallback. Both of those turn "unknown harness" into either a crash or
    // "behaves like claude-code"; this returns false and the caller degrades.
    expect(isBuiltinHarnessKind('some-harness-from-2027')).toBe(false)
    expect(isBuiltinHarnessKind('')).toBe(false)
    for (const kind of BUILTIN_HARNESS_KINDS) expect(isBuiltinHarnessKind(kind)).toBe(true)
  })
})

describe('BuiltinHarnessKind — closed in-repo (POD-303)', () => {
  it('holds exactly the harness enum, so the registry key cannot drift from the wire', () => {
    expect([...BUILTIN_HARNESS_KINDS]).toEqual([...HarnessAgent.options])
  })

  it("excludes 'shell', which is a spawnable kind and not a harness", () => {
    // The asymmetry is deliberate and the trap is "tidying" it with an
    // all-unsupported shell manifest: that admits a non-harness to every registry
    // totality check. The counterfactual is right here — 'shell' IS an AgentKind.
    expect(isAgentKind('shell')).toBe(true)
    expect(AgentKind.options).toContain('shell')
    expect(isBuiltinHarnessKind('shell')).toBe(false)
    expect(BUILTIN_HARNESS_KINDS).not.toContain('shell' as BuiltinHarnessKind)
    // …and it is still a perfectly good open HarnessId, since the wire type says
    // nothing about whether a manifest exists.
    expect(HarnessId.safeParse('shell').success).toBe(true)
  })

  it('carries no owner, delegation or authorization concept', () => {
    // The naming obligation, made mechanical. HarnessId answers "what software is
    // this"; the ADR 9 D5 agent PRINCIPAL — (agentIdentity, onBehalfOf, scope) —
    // answers "who is acting and for whom", and the two must not fuse. A branded
    // string cannot grow a field, so this asserts the property that WOULD break
    // first: the parsed value is the bare name and nothing else.
    const parsed = HarnessId.parse('claude-code')
    // A PRIMITIVE string, not a wrapper object with room for an `owner` or an
    // `onBehalfOf`: strictly equal to the bare name, and serializing to it.
    expect(typeof parsed).toBe('string')
    expect(parsed).toBe('claude-code')
    expect(JSON.stringify({ harness: parsed })).toBe('{"harness":"claude-code"}')
  })
})
