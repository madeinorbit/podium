import { describe, expect, it } from 'vitest'
import { findCapabilitySnapshotKeys } from '../annotations/capability-snapshot'
import { Attribution } from '../fields/attribution'
import { IssueIdentity, IssueWorkspace } from '../fields/issue'
import { Ownership } from '../fields/ownership'
import {
  SessionIdentity,
  SessionNaming,
  SessionPlacement,
  SessionResume,
} from '../fields/session'
import {
  HandoffManifest,
  HandoffManifestV1,
  HandoffManifestV2,
  HandoffRefusalReason,
} from './handoff'

/** The minting agent, as ADR 9 D5 A4 has it: the AGENT is the actor and the
 *  human it acted for is `onBehalfOf` — and the owner. */
const AGENT_ACTOR = { kind: 'agent' as const, id: 'agent-1' }

/** A v2 manifest with everything required and no optionals, minus the
 *  attribution pair itself, so a test can add exactly the half it is about. */
const V2_REQUIRED = {
  format: 2 as const,
  sessionId: 's1',
  agentKind: 'codex' as const,
  resume: { kind: 'codex-thread' as const, value: 'thread-1' },
  transcriptFilename: 'rollout.jsonl',
  repoId: 'repo-1',
  branch: 'issue/1153-attribution',
  headSha: 'a'.repeat(40),
  snapshotSha: null,
  snapshotFlattened: true as const,
  worktreeName: 'issue-1153',
  bundleBase: ['a'.repeat(40)],
  issueId: '1153',
  sourceMachineId: 'm1',
  owner: 'u1',
  visibility: 'personal' as const,
}

describe('HandoffManifest', () => {
  it('round-trips the canonical v1 manifest', () => {
    const value = {
      format: 1 as const,
      sessionId: 's1',
      agentKind: 'codex' as const,
      resume: { kind: 'codex-thread' as const, value: 'thread-1' },
      transcriptFilename: 'rollout-keep-me.jsonl',
      transcriptRelativeDir: '2026/07/14',
      repoId: 'repo-1',
      branch: 'issue/498-handoff',
      headSha: 'a'.repeat(40),
      snapshotSha: 'b'.repeat(40),
      snapshotFlattened: true as const,
      worktreeName: 'issue-498',
      worktreeRelativePath: '.claude/worktrees/issue-498',
      bundleBase: ['c'.repeat(40)],
      title: 'Session handoff',
      issueId: '498',
      sourceMachineId: 'm1',
      exportedAt: '2026-07-14T12:00:00.000Z',
    }
    expect(HandoffManifest.parse(JSON.parse(JSON.stringify(value)))).toEqual(value)
    // Routed to the V1 ARM, with the v2 arm present in the union and able to
    // have taken it: without this the assertion above would hold just as well
    // if there were only ever one arm.
    expect(HandoffManifest.options).toHaveLength(2)
    expect(HandoffManifest.parse(value).format).toBe(1)
  })

  it('rejects worktree locations that escape the repository', () => {
    const base = {
      format: 1 as const,
      sessionId: 's1',
      agentKind: 'codex' as const,
      resume: { kind: 'codex-thread' as const, value: 'thread-1' },
      transcriptFilename: 'rollout.jsonl',
      repoId: 'repo-1',
      branch: 'issue/498-handoff',
      headSha: 'a'.repeat(40),
      snapshotSha: null,
      snapshotFlattened: true as const,
      worktreeName: 'issue-498',
      bundleBase: ['a'.repeat(40)],
      sourceMachineId: 'm1',
      exportedAt: '2026-07-14T12:00:00.000Z',
    }
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: '../elsewhere' })).toThrow()
    expect(() =>
      HandoffManifest.parse({ ...base, worktreeRelativePath: '/tmp/elsewhere' }),
    ).toThrow()
  })

  // ADR 9 D5 A1 / POD-643 acceptance: the load-bearing constraint on a PORTABLE
  // representation. A bundle leaves the live system, so a serialized authority
  // field in it would authorize on the far side from payload — exactly what
  // ADR 3 D7 forbids. The audit fires on any spelling; see
  // `annotations/capability-snapshot.test.ts` for proof it fires at all.
  //
  // POD-1153: the audit is now run over the UNION and over EACH ARM by name. Two
  // reasons, both learned rather than assumed. (1) The union walk did not exist
  // until POD-1153 fixed it — `findCapabilitySnapshotKeys` handled `ZodUnion`
  // and not `ZodDiscriminatedUnion`, so running it over the union alone would
  // have answered `[]` for any planted field in any arm. (2) Naming the arms
  // means a THIRD format cannot be added and go unaudited by inheriting a green
  // line that only ever looked at two.
  it('carries no serialized capability, effective-rights or scope snapshot', () => {
    expect(findCapabilitySnapshotKeys(HandoffManifest)).toEqual([])
    expect(findCapabilitySnapshotKeys(HandoffManifestV1)).toEqual([])
    expect(findCapabilitySnapshotKeys(HandoffManifestV2)).toEqual([])
    // Every arm is covered by name above — so if a format 3 arrives, this fails
    // until someone audits it too.
    expect(HandoffManifest.options).toEqual([HandoffManifestV1, HandoffManifestV2])
  })

  // The audit matches KEY NAMES, which is a real blind spot and worth stating at
  // the site that depends on it: an authority-shaped VALUE under a bland key
  // (`meta`, `ctx`, `extra`) is invisible to it. The key-set locks below are the
  // instrument for that class — they are of a DIFFERENT class from the name
  // matcher (an enumeration, not a pattern), which is why the two genuinely
  // complement rather than corroborate. Both must be extended for a new format,
  // and the assertion above is what forces that.
  it('locks the nesting depth a bland key could hide authority in', () => {
    // `exported.by` is the ONLY nested object v2 adds, and its key set is
    // exactly the attribution pair — no room for an unnamed passenger.
    expect(Object.keys(HandoffManifestV2.shape.exported.shape)).toEqual(['at', 'by'])
    expect(Object.keys(HandoffManifestV2.shape.exported.shape.by.shape)).toEqual([
      'actor',
      'onBehalfOf',
    ])
  })

  // POD-643's first acceptance criterion, asserted by IDENTITY rather than by
  // shape. A fresh `z.string()` restatement is structurally equal on the wire and
  // passes every golden fixture — mutation testing confirmed that replacing a
  // composed field with one reds THIS test and nothing else, out of 185. So
  // reference equality is the only instrument that sees the POD-302 drift class.
  //
  // WHAT THIS TEST DOES NOT CLAIM, because a mutant proved it does not: writing
  // `sessionId: SessionIdField` — importing the underlying brand directly instead
  // of reaching through the group — is observationally IDENTICAL and passes,
  // since the group holds that same instance. That mutant is an equivalent
  // composition rather than a defect: it still follows the shared brand. It is
  // nonetheless weaker, because it would NOT follow if POD-365 re-typed the
  // group's field, which is why the schema reaches through the group. The test
  // name says "IS the shared instance" and not "was written as a group
  // reference", because the former is what it can actually distinguish.
  it('takes every session and issue field as the shared schema instance, never a restatement', () => {
    expect(HandoffManifestV1.shape.sessionId).toBe(SessionIdentity.shape.sessionId)
    // Tightened by `.unwrap()`: the shared field is optional/nullable because a
    // LIVE session may lack it. A bundle may not — see the schema's docs.
    expect(HandoffManifestV1.shape.resume).toBe(SessionResume.shape.resume.unwrap())
    expect(HandoffManifestV1.shape.repoId).toBe(IssueIdentity.shape.repoId.unwrap())
    expect(HandoffManifestV1.shape.branch).toBe(IssueWorkspace.shape.branch.unwrap())
    // Loosened: the manifest's own optionality wraps the shared inner schema.
    expect(HandoffManifestV1.shape.title.unwrap()).toBe(SessionNaming.shape.title)
    expect(HandoffManifestV1.shape.issueId.unwrap()).toBe(
      SessionPlacement.shape.issueId.unwrap(),
    )
  })

  // POD-1153. The SECOND arm is where a restatement would actually land: writing
  // v2 out by hand is the obvious way to add a format, it is byte-plausible, and
  // NO golden fixture can see it (rule 9 — branding is compile-time). So every
  // key the two formats share must be the SAME INSTANCE, not an equal one, which
  // also means the `worktreeRelativePath` containment refinement cannot be
  // present on v1 and quietly missing on v2.
  it('shares every common key with v1 as one instance, so v2 cannot drift from it', () => {
    const shared = Object.keys(HandoffManifestV1.shape).filter(
      (k) => k !== 'format' && k !== 'exportedAt',
    )
    // The membership is pinned, not just iterated: a suite whose parameter list
    // is the thing under test cannot notice its own coverage shrinking, and a
    // silently-emptied `shared` would leave this test passing vacuously.
    expect(shared).toHaveLength(17)
    for (const key of shared) {
      expect(
        HandoffManifestV2.shape[key as keyof typeof HandoffManifestV2.shape],
        `v2.${key} must BE v1.${key}, not an equal restatement`,
      ).toBe(HandoffManifestV1.shape[key as keyof typeof HandoffManifestV1.shape])
    }
  })

  // The attribution half, asserted the only way that sees a restatement.
  it('composes the attribution pair and the owner from the shared field schemas', () => {
    expect(HandoffManifestV2.shape.exported.shape.by).toBe(Attribution)
    expect(HandoffManifestV2.shape.owner).toBe(Ownership.shape.owner)
    expect(HandoffManifestV2.shape.visibility).toBe(Ownership.shape.visibility)
    // The actor half is the shared four-kind union, not a string: a bundle minted
    // by an agent records the AGENT as actor and the human as `onBehalfOf`
    // (ADR 9 D5 A4), and a flattened actor is what loses that distinction.
    expect(HandoffManifestV2.shape.exported.shape.by.shape.actor.options.map((o) => o.shape.kind.value)).toEqual([
      'user',
      'agent',
      'machine',
      'system',
    ])
  })

  // The unsplittability this format bump exists for, asserted as a REFUSAL and
  // with the counterfactual: the same manifest with the pair complete parses, so
  // the failures below are attributable to the missing half and not to some
  // other defect in the fixture.
  it('refuses a v2 manifest that records WHEN without WHO, or WHO without WHEN', () => {
    const complete = {
      ...V2_REQUIRED,
      exported: { at: '2026-07-30T12:00:00.000Z', by: { actor: AGENT_ACTOR, onBehalfOf: 'u1' } },
    }
    expect(HandoffManifest.parse(complete).format).toBe(2)
    // WHEN without WHO.
    expect(() =>
      HandoffManifest.parse({ ...V2_REQUIRED, exported: { at: '2026-07-30T12:00:00.000Z' } }),
    ).toThrow()
    // WHO without WHEN.
    expect(() =>
      HandoffManifest.parse({
        ...V2_REQUIRED,
        exported: { by: { actor: AGENT_ACTOR, onBehalfOf: 'u1' } },
      }),
    ).toThrow()
    // And the pair cannot come back FLAT: a v2 bundle spelling the timestamp the
    // v1 way is the two-spellings drift POD-302 exists to kill, so it must not
    // parse as a v2 manifest at all.
    const { exported: _dropped, ...withoutPair } = complete
    expect(
      HandoffManifest.safeParse({ ...withoutPair, exportedAt: '2026-07-30T12:00:00.000Z' }).success,
    ).toBe(false)
  })

  // `agentKind` is the ONE deliberate exception, so it needs the counterfactual
  // in the fixture: asserting "the manifest has two arms" proves nothing unless
  // the shared union it departs from is shown to have more.
  it('narrows agentKind below the shared AgentKind, deliberately', () => {
    expect(HandoffManifestV1.shape.agentKind.options).toEqual(['claude-code', 'codex'])
    expect(SessionIdentity.shape.agentKind.options.length).toBeGreaterThan(2)
    expect(SessionIdentity.shape.agentKind.options).toContain('shell')
  })

  // The key set is LOCKED, in wire order. The golden fixtures pin the encoding
  // of a value, which an added OPTIONAL field slips past unchanged; this pins
  // the vocabulary itself, so growing the manifest is a deliberate, reviewed
  // act rather than a silent one.
  it('has exactly the locked v1 key set, in wire order', () => {
    expect(Object.keys(HandoffManifestV1.shape)).toEqual([
      'format',
      'sessionId',
      'agentKind',
      'resume',
      'transcriptFilename',
      'transcriptRelativeDir',
      'repoId',
      'branch',
      'headSha',
      'snapshotSha',
      'snapshotFlattened',
      'worktreeName',
      'worktreeRelativePath',
      'cwdSubpath',
      'bundleBase',
      'title',
      'issueId',
      'sourceMachineId',
      'exportedAt',
    ])
  })

  // The v2 lock, which does the SAME job for the arm that will actually grow:
  // the golden fixtures pin the encoding of values someone chose to write, so an
  // added optional key slips past them unchanged. This is also the instrument
  // that covers `findCapabilitySnapshotKeys`'s blind spot — a bland key (`meta`,
  // `ctx`, `extra`) hiding an authority-shaped value is invisible to a name
  // matcher and impossible here.
  it('has exactly the locked v2 key set, in wire order', () => {
    expect(Object.keys(HandoffManifestV2.shape)).toEqual([
      'format',
      'sessionId',
      'agentKind',
      'resume',
      'transcriptFilename',
      'transcriptRelativeDir',
      'repoId',
      'branch',
      'headSha',
      'snapshotSha',
      'snapshotFlattened',
      'worktreeName',
      'worktreeRelativePath',
      'cwdSubpath',
      'bundleBase',
      'title',
      'issueId',
      'sourceMachineId',
      // v1's flat `exportedAt` is REPLACED here, not joined: the export
      // timestamp has exactly one spelling per format.
      'exported',
      'owner',
      'visibility',
    ])
    expect(Object.keys(HandoffManifestV2.shape)).not.toContain('exportedAt')
  })
})

// The ACCEPTANCE boundary, which the golden corpora structurally cannot cover:
// they assert the bytes emitted for values someone chose to write, and are silent
// about inputs the schema used to accept and now refuses. So a narrowing — an
// `.unwrap()` that tightens, a `.min(1)` added while tidying — passes every byte
// pin unchanged. These cases test the other direction: a bundle already on disk
// must still open. Deliberately includes the falsy-but-defined values, since those
// are the ones a "tidy up the optionals" change would reject first.
describe('HandoffManifest acceptance boundary (v1 bundles must keep parsing)', () => {
  const required = {
    format: 1 as const,
    sessionId: 's1',
    agentKind: 'codex' as const,
    resume: { kind: 'codex-thread', value: 'thread-1' },
    transcriptFilename: 'rollout.jsonl',
    repoId: 'repo-1',
    branch: 'issue/498-handoff',
    headSha: 'a'.repeat(40),
    snapshotSha: null,
    snapshotFlattened: true as const,
    worktreeName: 'issue-498',
    bundleBase: ['a'.repeat(40)],
    sourceMachineId: 'm1',
    exportedAt: '2026-07-14T12:00:00.000Z',
  }

  it('accepts a manifest with every optional absent', () => {
    expect(HandoffManifest.parse(required)).toEqual(required)
  })

  // EVERY optional that permits `''` must be listed here, and the list is the
  // point rather than the assertion. `title` is composed, so the reference-identity
  // test above happens to catch a narrowing of it too — but `transcriptRelativeDir`
  // and `cwdSubpath` are BUNDLE-LOCAL, so identity cannot guard them and this is
  // their only guard. Mutation-verified: `.min(1)` on `transcriptRelativeDir`
  // survived all 188 tests until this case named it.
  //
  // `worktreeRelativePath` is deliberately ABSENT from the list: its `.min(1)` is
  // intentional, its reader does not normalise, and the negative test above pins
  // that it rejects. Adding it here would assert the opposite of a real invariant.
  it('accepts empty-string values in every optional that permits them', () => {
    const parsed = HandoffManifest.parse({
      ...required,
      title: '',
      cwdSubpath: '',
      transcriptRelativeDir: '',
    })
    expect(parsed.title).toBe('')
    expect(parsed.cwdSubpath).toBe('')
    expect(parsed.transcriptRelativeDir).toBe('')
  })

  it('accepts a snapshotSha, and a bundleBase carrying several refs', () => {
    const parsed = HandoffManifest.parse({
      ...required,
      snapshotSha: 'b'.repeat(40),
      bundleBase: ['a'.repeat(40), 'c'.repeat(40)],
    })
    expect(parsed.snapshotSha).toBe('b'.repeat(40))
    expect(parsed.bundleBase).toHaveLength(2)
  })
})

// POD-1153's compatibility acceptance, and the half that is easy to skip: it is
// not enough that a v1 bundle still PARSES — it must still parse AS v1. An
// "upgrade" that read a v1 file as v2 by defaulting the missing pair would pass
// every positive test in this file while inventing provenance for a bundle that
// never carried any, which is the one thing a durable attribution record must
// never do.
describe('HandoffManifest format discrimination', () => {
  const V1_BUNDLE = {
    format: 1 as const,
    sessionId: 's1',
    agentKind: 'codex' as const,
    resume: { kind: 'codex-thread' as const, value: 'thread-1' },
    transcriptFilename: 'rollout.jsonl',
    repoId: 'repo-1',
    branch: 'issue/498-handoff',
    headSha: 'a'.repeat(40),
    snapshotSha: null,
    snapshotFlattened: true as const,
    worktreeName: 'issue-498',
    bundleBase: ['a'.repeat(40)],
    sourceMachineId: 'm1',
    exportedAt: '2026-07-14T12:00:00.000Z',
  }

  it('reads a v1 bundle as v1, and the v2 arm refuses it outright', () => {
    const parsed = HandoffManifest.parse(V1_BUNDLE)
    expect(parsed.format).toBe(1)
    expect(HandoffManifestV2.safeParse(V1_BUNDLE).success).toBe(false)
    // `Object.keys`, not `toEqual`: an undefined-valued key reads as ABSENT to
    // `toEqual`, so it is the wrong instrument for the key-PRESENCE class — and
    // "v1 grew an empty `exported`/`owner`" is exactly that class.
    expect(Object.keys(parsed)).not.toContain('exported')
    expect(Object.keys(parsed)).not.toContain('owner')
    expect(Object.keys(parsed)).not.toContain('visibility')
  })

  it('refuses a v1 payload wearing format 2 rather than falling back to the v1 arm', () => {
    const mislabelled = { ...V1_BUNDLE, format: 2 as const }
    expect(HandoffManifest.safeParse(mislabelled).success).toBe(false)
  })

  it('refuses a format this reader has never heard of', () => {
    // Unchanged behaviour, pinned rather than assumed: `format: z.literal(1)`
    // refused a future format too. A versioned FILE must fail closed on a
    // version it cannot interpret — best-effort reading is how a reader silently
    // drops a key it did not know was load-bearing.
    expect(HandoffManifest.safeParse({ ...V1_BUNDLE, format: 3 }).success).toBe(false)
    expect(HandoffManifest.safeParse({ ...V1_BUNDLE, format: '1' }).success).toBe(false)
  })

  // The containment refinement, verified in the direction that can regress: the
  // NEGATIVE case, on the arm that did not exist when it was written.
  it('applies the worktree containment refinement on the v2 arm too', () => {
    const base = {
      ...V2_REQUIRED,
      exported: { at: '2026-07-30T12:00:00.000Z', by: { actor: AGENT_ACTOR, onBehalfOf: 'u1' } },
    }
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: '../elsewhere' })).toThrow()
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: '/tmp/elsewhere' })).toThrow()
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: 'a\\b' })).toThrow()
    expect(() => HandoffManifest.parse({ ...base, worktreeRelativePath: 'a/./b' })).toThrow()
    // Not a second name-matcher for the same thing: this pins that there is ONE
    // refinement instance, so v1 and v2 cannot diverge on it in the first place.
    expect(HandoffManifestV2.shape.worktreeRelativePath).toBe(
      HandoffManifestV1.shape.worktreeRelativePath,
    )
    // Counterfactual for all four refusals above: a contained path parses.
    expect(
      HandoffManifest.parse({ ...base, worktreeRelativePath: '.worktrees/issue-1153' }).format,
    ).toBe(2)
  })
})

describe('HandoffRefusalReason', () => {
  // ADR 9 D6 M5 / ADR 1 Am1 D13.7: a denied handoff must not collapse into a
  // generic failure, because "denied" and "offline" otherwise produce the same
  // empty list. Enforcement is POD-1079 / POD-323's; the VOCABULARY is this
  // issue's, and a closed union is what stops the enforcement from inventing
  // free-text reasons per call site.
  it('distinguishes unauthorized from unreachable, and nothing else', () => {
    expect(HandoffRefusalReason.options).toEqual(['unauthorized', 'unreachable', 'unknown-target'])
  })

  it('rejects a reason outside the closed set', () => {
    expect(() => HandoffRefusalReason.parse('denied')).toThrow()
  })
})
