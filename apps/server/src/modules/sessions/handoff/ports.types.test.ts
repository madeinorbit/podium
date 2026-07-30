/**
 * THE PORTS' DERIVED TYPES, DEFENDED — POD-642, adopting POD-381's form.
 *
 * `handoff/ports.ts` does not restate the exportable-harness list or the resume
 * ref: it DERIVES them from the schemas that own them
 * (`HandoffManifestV1['agentKind']`, `ResumeRef`). A fork with identical members
 * would parse, encode and pass every golden case identically — POD-381 hit that
 * in its own contracts, where 32 tests in the same file passed with the fork in
 * place — and at the TYPE level there is no runtime value to assert `toBe` on. So
 * the derivation itself is the protection, and an undefended derivation is
 * SILENT: one that quietly resolved to `string` or `any` would still compile,
 * still typecheck clean, and guard nothing.
 *
 * WHY `@ts-expect-error` RATHER THAN A ONE-OFF PROBE (POD-381's improvement on
 * what I first did, and the reason it is worth a file): a directive with nothing
 * to suppress is itself a compile error, TS2578. So if the derivation ever goes
 * vacuous, this does not fall silent — the compiler reports ON IT, by name, at
 * that line. A probe run by hand once and described in a commit message rots into
 * a comment; this cannot.
 *
 * ---------------------------------------------------------------------------
 * AND ONE OF THE TWO PROBES I FIRST WROTE HERE WAS A LIE, so the honest version
 * is below and the reason is worth more than the probe was.
 * ---------------------------------------------------------------------------
 *
 * I wrote a second directive claiming to prove that `resume` is the MODEL'S
 * `ResumeRef` and not a hand-shaped `{kind, value}`. It suppressed an error, so it
 * compiled, so it looked like a guard. It is not one: it only refused a bare
 * STRING, which any object type refuses. Verified by mutation — replacing the
 * derivation with the hand-shaped inline type left that directive perfectly happy
 * while the `agentKind` one reported TS2578.
 *
 * It cannot be fixed, and the reason is structural: the model defines
 * `ResumeRef = z.object({ kind: z.string(), value: z.string() })`, so a
 * hand-written `{kind: string; value: string}` is THE SAME TYPE. Type identity is
 * necessary but not sufficient, and here it is total — there is no assignment a
 * compiler could refuse that would distinguish the two. Importing `ResumeRef`
 * still buys the thing that matters (the port FOLLOWS the model if `kind` is ever
 * narrowed to an enum, instead of silently accepting a kind no importer honours),
 * but that is drift-following, not a defended invariant, and saying otherwise
 * would be exactly the "name outruns the assertion" failure this fan-out keeps
 * finding in other people's tests.
 *
 * So instead there is a TRIPWIRE on the premise: the day `ResumeRef.shape.kind`
 * stops being an open string, this file reds, and the probe that is impossible
 * today becomes possible and should be added here.
 */

import { HandoffManifestV1, ResumeRef } from '@podium/model'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import type { HandoffPorts, HandoffRpcPort } from './ports'

type ExportLegInput = Parameters<HandoffRpcPort['handoffExport']>[0]
type ResumeLegInput = Parameters<HandoffPorts['resumeSession']>[0]

/** A kind the bundle format cannot carry must not typecheck as one it can. If the
 *  derivation went vacuous this directive would have nothing to suppress, and the
 *  compiler would say so here (verified by mutating the derivation to `string`). */
// @ts-expect-error 'grok' is not an exportable harness kind
const _rejectsUnexportableKind: ExportLegInput['agentKind'] = 'grok'

/** The accepted side, so the refusal above cannot be read as a type that simply
 *  refuses everything — which would satisfy the directive and mean nothing. */
const _acceptsExportableKind: ExportLegInput['agentKind'] = 'codex'
const _acceptsResumeRef: ResumeLegInput['resume'] = { kind: 'claude-session', value: 'native-id' }

describe('handoff ports: derived vocabulary', () => {
  it('the exportable set is the one the manifest owns, and a widening must be looked at here', () => {
    // A deliberate tripwire, not a duplicate of the manifest's own test: if the
    // exportable set widens, the ports' derived type follows SILENTLY and
    // correctly, but the export leg and the resume leg both have to be able to
    // carry the new kind end to end. This reds at that moment and points here.
    expect(HandoffManifestV1.shape.agentKind.options).toEqual(['claude-code', 'codex'])
    expect(_acceptsExportableKind).toBe('codex')
    // Referenced so the refusal probe is not an unused binding — its VALUE is
    // meaningless (it exists only to be type-checked), its presence is not.
    expect(_rejectsUnexportableKind).toBe('grok')
  })

  it("ResumeRef's `kind` is still an open string, which is WHY the resume fork is undefendable here", () => {
    // The premise of the paragraph in this file's header. While `kind` is a plain
    // string, the model's ResumeRef and a hand-written {kind: string; value:
    // string} are the same type and no compile-time probe can separate them. When
    // this reds — because someone narrowed `kind` to the enum it morally is — the
    // fix is not to loosen this assertion: it is to add the @ts-expect-error probe
    // that has become possible, and then narrow this one to the new shape.
    expect(ResumeRef.shape.kind).toBeInstanceOf(z.ZodString)
    expect(_acceptsResumeRef.kind).toBe('claude-session')
  })
})
