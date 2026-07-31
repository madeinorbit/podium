/**
 * THE TYPE-LEVEL GUARD ON THE DERIVED FAMILIES (POD-314).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY VITEST CANNOT REPLACE IT
 * ---------------------------------------------------------------------------
 *
 * The failure this issue's builder can produce is INVISIBLE AT RUNTIME. If the
 * generic solve goes wrong, `derivedFamilyProcedures` still returns a working
 * router — every procedure dispatches, every test passes — and the only casualty
 * is the inferred `AppRouter`, which widens every output to `unknown` and takes
 * `apps/web` down at its call sites rather than here. POD-732 recorded exactly
 * that, and the first draft of `derived-family.ts` reproduced it: constraining the
 * command table as `Record<string, DerivedCommand<Svc>>` made TypeScript infer
 * `Svc = unknown`, and the runtime behaviour was identical.
 *
 * So the assertions below are type-level, and they are written so that a widening
 * to `unknown` FAILS them.
 *
 * ---------------------------------------------------------------------------
 * EVERY ASSERTION HERE CAN SAY NO — AND THE FILE PROVES IT RATHER THAN CLAIMING IT
 * ---------------------------------------------------------------------------
 *
 * This is the defect class the coordinator has now seen nine times: a suite whose
 * refusing arm cannot fire in the environment it runs in. A type assertion is
 * especially prone to it, because the two most natural spellings are both
 * VACUOUS:
 *
 *  - `expectTypeOf(x).toMatchTypeOf<unknown>()` passes for every possible `x`;
 *  - an `Extends<A, B>` helper passes whenever `B` is `unknown` or `any`, which
 *    is precisely the broken state being tested for.
 *
 * `Exact<A, B>` below is mutual assignability, so `unknown` fails it against a
 * concrete type in BOTH directions. And each positive assertion is PAIRED with a
 * `@ts-expect-error` negative one: TypeScript reports TS2578 ("Unused
 * '@ts-expect-error' directive") when the line it guards does NOT error, so the
 * negative probes fail the typecheck if the assertion has become unable to
 * refuse. That is the instrument proving it can say YES before its NO is believed.
 */

import { describe, expect, it } from 'vitest'
import type { ApprovalProcedures } from './approvals/trpc'

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

/**
 * MUTUAL assignability, not `extends`. `A extends B` is satisfied by `unknown` on
 * the B side and by `any` on either, which are the two states this file exists to
 * catch — a one-directional helper would pass in exactly the broken case.
 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** Consumes a `true` and nothing else. A `false` is a compile error, so a failed
 *  assertion is a RED TYPECHECK rather than a passing test with a wrong type. */
const assertExact = <_T extends true>(): void => {}

/** The tRPC procedure's declared output, as the client sees it. Reading it
 *  structurally rather than through tRPC's own helpers keeps this test honest if
 *  those helpers change shape. */
type OutputOf<P> = P extends { _def: { $types: { output: infer O } } } ? O : never
type InputOf<P> = P extends { _def: { $types: { input: infer I } } } ? I : never

// ---------------------------------------------------------------------------
// The approvals family — one derived MUTATION and one derived QUERY
// ---------------------------------------------------------------------------

type ApproveOutput = OutputOf<ApprovalProcedures['approve']>
type ApproveInput = InputOf<ApprovalProcedures['approve']>
type ListOutput = OutputOf<ApprovalProcedures['list']>

/**
 * THE POSITIVE ASSERTIONS.
 *
 * `approve` returns the service's `ApprovalWire`, so its output must carry that
 * row's fields. Asserted through a required property rather than by naming the
 * whole wire type: this file is guarding the DERIVATION, not restating the wire
 * shape, and a structural restatement here would be the second declaration this
 * phase exists to delete.
 */
assertExact<Exact<ApproveOutput extends { id: string } ? true : false, true>>()
assertExact<Exact<ApproveInput, { id: string }>>()
assertExact<Exact<ListOutput extends readonly unknown[] ? true : false, true>>()

/**
 * THE NON-VACUITY PROBES — the half that makes the three above mean something.
 *
 * Each asserts something FALSE about the derived types. If the derivation is
 * healthy, every line below is a type error and `@ts-expect-error` absorbs it. If
 * the derivation has widened to `unknown`, the assertions become satisfiable, the
 * directives go unused, and `tsgo` reports TS2578 on each — a RED typecheck.
 *
 * So the file fails in both directions: it fails when the types are wrong, and it
 * fails when it has lost the ability to tell.
 */
// @ts-expect-error `approve`'s output is the approval wire, never `unknown` — if
// this line stops erroring, the generic solve has widened and AppRouter is dead.
assertExact<Exact<ApproveOutput, unknown>>()
// @ts-expect-error nor is its input `unknown`: it is the contract's own schema.
assertExact<Exact<ApproveInput, unknown>>()
// @ts-expect-error the derived query's output is an array, not `unknown`.
assertExact<Exact<ListOutput, unknown>>()
// @ts-expect-error and `approve` is not typed with some OTHER family's input —
// a table wired to the wrong contract would still typecheck without this.
assertExact<Exact<ApproveInput, { sessionId: string }>>()

describe('derived family type derivation', () => {
  /**
   * Vitest cannot evaluate the assertions above — they are erased before it runs.
   * This case exists so the file reports a NON-ZERO test count in the lane: a
   * suite that silently contributes nothing is indistinguishable from one whose
   * path is wrong, and `vitest run` exits 0 when it finds no test files at all.
   * The real gate on this file is the typecheck.
   */
  it('is enforced by the typecheck, not by this assertion', () => {
    expect(true).toBe(true)
  })
})
