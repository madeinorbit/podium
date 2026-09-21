import { describe, expect, it } from 'vitest'
import {
  AGENT_CHOICE_HARNESS_KINDS,
  AgentKind,
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  COST_FULL_ATTRIBUTION_HARNESS,
  COST_HARNESS_KINDS,
  HANDOFF_HARNESS_KINDS,
  HarnessAgent,
  HarnessId,
  isAgentKind,
  isBuiltinHarnessKind,
  OBSERVATION_PROVIDER_KINDS,
  PORTABLE_CREDENTIAL_HARNESS_KINDS,
  USAGE_HARNESS_KINDS,
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

/**
 * Derived closed subsets (POD-4414 §5, issue 4.2). Each slice below is the ONE
 * home for one schema's membership; the schemas derive via `z.enum(SLICE)`.
 * These tests pin the contract both ways: every slice stays inside the closed
 * set (a bogus member fails here, not at a distant gate), and the wire members
 * stay exactly what they were (a silent widening or narrowing fails here).
 */
describe('derived harness subsets (4.2)', () => {
  const SLICES: readonly (readonly string[])[] = [
    COST_HARNESS_KINDS,
    HANDOFF_HARNESS_KINDS,
    USAGE_HARNESS_KINDS,
    OBSERVATION_PROVIDER_KINDS,
    PORTABLE_CREDENTIAL_HARNESS_KINDS,
    AGENT_CHOICE_HARNESS_KINDS,
  ]

  it('keeps every slice inside the closed set', () => {
    const closed = new Set<string>(HarnessAgent.options)
    for (const slice of SLICES) for (const kind of slice) expect(closed.has(kind)).toBe(true)
    expect(isBuiltinHarnessKind(COST_FULL_ATTRIBUTION_HARNESS)).toBe(true)
  })

  it('pins the cost/usage/observation wire members', () => {
    expect([...COST_HARNESS_KINDS]).toEqual(['claude-code', 'codex', 'grok'])
    expect([...USAGE_HARNESS_KINDS]).toEqual(['claude-code', 'codex', 'grok'])
    expect([...OBSERVATION_PROVIDER_KINDS]).toEqual(['claude-code', 'codex', 'grok'])
    expect([...PORTABLE_CREDENTIAL_HARNESS_KINDS]).toEqual(['claude-code', 'codex', 'grok'])
    expect(COST_FULL_ATTRIBUTION_HARNESS).toBe('claude-code')
  })

  it('pins the handoff members and the spawn-choice offer (pi stays unoffered)', () => {
    expect([...HANDOFF_HARNESS_KINDS]).toEqual(['claude-code', 'codex'])
    expect([...AGENT_CHOICE_HARNESS_KINDS]).toEqual([
      'claude-code',
      'codex',
      'grok',
      'opencode',
      'cursor',
    ])
  })
})
