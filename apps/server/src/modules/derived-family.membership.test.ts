/**
 * THE MEMBERSHIP CHECK CAN ACTUALLY REFUSE — the witness PDM-361 was filed for.
 *
 * `assertSurfaceMatchesDeclarations` was cited by two file headers as the reason
 * a contract/procedure mismatch is caught, and it could not fire. Both sides
 * derived presence from the SAME DECLARATION: the build loop assigned
 * `built[name]` when the contract declared tRPC, and the check then asked the
 * contract again and compared the answer to `built[name] !== undefined`.
 * `declared === present` held by construction for every name, so both `throw`
 * arms were unreachable and the whole function was a tautology dressed as a
 * gate. Nothing in the suite noticed, because nothing in the suite ever called
 * it with a surface that disagreed with its tables.
 *
 * WHAT FIXED IT is the comparison, not any tidying around it. Asking the built
 * object for its OWN KEYS and comparing that set to the declared set is a
 * different question from the one the loop already answered; naming the
 * predicate in one place (`servesOverTrpc`) is drift protection and would not,
 * on its own, have made either arm reachable.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CALLS THE FUNCTION DIRECTLY
 * ---------------------------------------------------------------------------
 *
 * Because that is the only way to hand it a disagreeing surface. Go through
 * `derivedFamilyProcedures` and the two build loops are `built`'s only writers,
 * so the tables and the keys agree no matter what you plant — which is precisely
 * the property that made the old check untestable AND unable to fail. Calling
 * the assertion with a hand-built `built` is not a shortcut around the real
 * path; it IS the negative half, and it is the half the old spelling could not
 * express at all.
 *
 * Two of the four refusals below are NEW COVERAGE in the strict sense — they
 * fail against the pre-PDM-361 body and pass against this one:
 *
 *   "serves a name neither table declares"  — the old loops iterated the TABLES,
 *       so a key in `built` with no table entry was never looked at.
 *   "would serve nothing at all"            — an empty `built` passed the old
 *       loops whenever no table declared trpc, which is the exact case the old
 *       header claimed it caught ("an empty object FAILS it rather than passing
 *       it").
 *
 * The other two arms the old body could reach IF CALLED, and they are asserted
 * here anyway: unreachable-in-situ and never-called are different defects, and
 * the repair is only worth having if both arms keep working.
 *
 * ---------------------------------------------------------------------------
 * AND A REFUSING-EVERYTHING GATE MUST NOT PASS THIS FILE
 * ---------------------------------------------------------------------------
 *
 * False-green catalogue entry 1 is the matcher wrong in both directions at once.
 * An assertion that threw unconditionally would satisfy every `toThrow` below,
 * so the agreeing surface is asserted to pass FIRST and is built from the same
 * helpers as the refusals — same contracts, same query entries, one name moved.
 * Each pair therefore differs in exactly the thing under test.
 */

import type { AnyCommandContract, TransportTag } from '@podium/commands'
import { readPositionAdvanceContract } from '@podium/commands'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { assertSurfaceMatchesDeclarations } from './derived-family'

/** A real shipped contract with ONE field moved, so the fixture cannot drift
 *  away from the shape the builder actually reads. */
const contractExposedOn = (exposure: readonly TransportTag[]): AnyCommandContract =>
  ({ ...readPositionAdvanceContract, exposure }) as unknown as AnyCommandContract

const commandEntry = (exposure: readonly TransportTag[]) => ({
  contract: contractExposedOn(exposure),
  handler: () => undefined,
})

const queryEntry = (exposure: readonly TransportTag[]) => ({
  input: z.void(),
  exposure,
  run: () => undefined,
})

/** Stands in for a built procedure. The assertion only asks whether the KEY is
 *  there, so the value's identity is deliberately uninteresting. */
const PROCEDURE = { _def: { type: 'mutation' } }

describe('assertSurfaceMatchesDeclarations', () => {
  it('accepts a surface whose keys are exactly what the tables declare', () => {
    expect(() =>
      assertSurfaceMatchesDeclarations(
        'readPosition',
        { advance: commandEntry(['trpc']) },
        { get: queryEntry(['trpc']) },
        { advance: PROCEDURE, get: PROCEDURE },
      ),
    ).not.toThrow()
  })

  /**
   * NEW COVERAGE. A key in `built` that NO table entry accounts for — a
   * hand-written procedure spread back in beside the derived ones, a wrapper
   * that added a key, a merge that brought one along. The old body iterated the
   * tables and therefore never looked at this key at all.
   */
  it('refuses a name the derived router serves that neither table declares', () => {
    expect(() =>
      assertSurfaceMatchesDeclarations(
        'readPosition',
        { advance: commandEntry(['trpc']) },
        { get: queryEntry(['trpc']) },
        { advance: PROCEDURE, get: PROCEDURE, smuggled: PROCEDURE },
      ),
    ).toThrow(
      /readPosition\.smuggled: the derived router serves it, but neither the contract table nor the query table declares it at all/,
    )
  })

  /**
   * NEW COVERAGE. The empty surface — POD-732's "an empty router satisfies every
   * absence claim perfectly". The old header claimed the first membership loop
   * delivered this; it did not, because with no table declaring trpc the loop's
   * `declared` was false everywhere and an empty `built` sailed through.
   */
  it('refuses a family that would serve nothing at all', () => {
    expect(() =>
      assertSurfaceMatchesDeclarations(
        'readPosition',
        { advance: commandEntry(['mcp']) },
        { get: queryEntry(['mcp']) },
        {},
      ),
    ).toThrow(/readPosition: the derived router would serve NOTHING/)
  })

  /**
   * BOTH MEMBERSHIP DIRECTIONS, asserted softly so one failing arm cannot hide
   * the other. A test that only proved the "declared but missing" direction
   * would pass against a check that had lost its "served but undeclared" arm
   * entirely — which is the direction that catches a procedure nobody declared.
   */
  it('refuses a mismatch in either direction, for a command and for a query', () => {
    // Declared, not served — the contract promises trpc and the key is absent.
    expect
      .soft(() =>
        assertSurfaceMatchesDeclarations(
          'readPosition',
          { advance: commandEntry(['trpc']) },
          { get: queryEntry(['trpc']) },
          { get: PROCEDURE },
        ),
      )
      .toThrow(
        /readPosition\.advance: the contract declares trpc exposure but the derived router would not serve it/,
      )

    // Declared, not served — the QUERY TABLE half of the same direction.
    expect
      .soft(() =>
        assertSurfaceMatchesDeclarations(
          'readPosition',
          { advance: commandEntry(['trpc']) },
          { get: queryEntry(['trpc']) },
          { advance: PROCEDURE },
        ),
      )
      .toThrow(
        /readPosition\.get: the query table declares trpc exposure but the derived router would not serve it/,
      )

    // Served, not declared — the contract names another transport and the router
    // carries the key anyway.
    expect
      .soft(() =>
        assertSurfaceMatchesDeclarations(
          'readPosition',
          { advance: commandEntry(['mcp']) },
          { get: queryEntry(['trpc']) },
          { advance: PROCEDURE, get: PROCEDURE },
        ),
      )
      .toThrow(
        /readPosition\.advance: the derived router serves it, but its contract does not declare trpc exposure/,
      )

    // Served, not declared — the QUERY TABLE half.
    expect
      .soft(() =>
        assertSurfaceMatchesDeclarations(
          'readPosition',
          { advance: commandEntry(['trpc']) },
          { get: queryEntry(['outbox']) },
          { advance: PROCEDURE, get: PROCEDURE },
        ),
      )
      .toThrow(
        /readPosition\.get: the derived router serves it, but its query table entry does not declare trpc exposure/,
      )
  })

  /**
   * ONE NAME CANNOT BE TWO PROCEDURES, and it is checked BEFORE the membership
   * arms — a collision makes every later question about that name ambiguous,
   * since `built[name]` can only hold whichever spread landed last.
   */
  it('refuses a name declared as both a command and a query', () => {
    expect(() =>
      assertSurfaceMatchesDeclarations(
        'readPosition',
        { advance: commandEntry(['trpc']) },
        { advance: queryEntry(['trpc']) },
        { advance: PROCEDURE },
      ),
    ).toThrow(/readPosition\.advance is declared as BOTH a command and a query/)
  })
})
