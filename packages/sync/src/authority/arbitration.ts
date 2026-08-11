/**
 * THE ARBITRATION RULES — the Authority's, and NOBODY ELSE'S.
 *
 * ADR 1 D1: durable truth is committed only by the Authority; the Replica applies
 * Authority-ordered revisions and never merges concurrent truths, never invents
 * LWW, and never overrides an Authority revision. This module is where "which of
 * these two writes wins" is decided, and `packages/sync/src/replica/` is
 * direction-locked by `check-boundaries` rule 9 precisely so it can never reach it.
 *
 * ---------------------------------------------------------------------------
 * ARBITRATION IS NOT AUTHORIZATION, AND THE TWO ARE NOT INTERCHANGEABLE
 * ---------------------------------------------------------------------------
 *
 * Nothing in this file takes a principal, a grant, an owner or a capability, and
 * that is structural rather than incidental:
 *
 *   AUTHORIZATION asks "may this principal write this at all?" It is resolved
 *   LIVE over the delegation chain at every apply (ADR 3 D8/D16), it runs FIRST,
 *   and a failure is a DENIAL that may carry no reason (readiness §3.1.5 — an
 *   invisible target must be indistinguishable from a nonexistent one).
 *
 *   ARBITRATION asks "given that they may, does this write win?" It is resolved
 *   from the row's declared conflict rule and the entity's current state, and a
 *   failure is a REJECTION that MAY carry a reason — because it is a policy
 *   outcome about an entity the principal was already authorized to write.
 *
 * Collapsing them leaks exactly what the consistent-error rule protects. The
 * asymmetry is the same one POD-351 pinned on `sessions.rename`.
 *
 * ---------------------------------------------------------------------------
 * EVERY RULE FAILS CLOSED, AND THE UNBUILT ONE FAILS LOUD
 * ---------------------------------------------------------------------------
 *
 * `conflictRuleFor` already throws on a row with no declared rule (ADR 1 D4
 * totality): unlike visibility, where a missing declaration has a safe answer
 * (private), there is no safe default merge policy, and picking one silently is
 * how a class ends up with whole-aggregate LWW that nobody chose. This module
 * extends that posture to the rules themselves — an `op-stream` row throws rather
 * than quietly degrading to LWW, because a degraded merge on collaborative text
 * silently loses characters and nothing downstream can tell.
 */

import {
  conflictRuleFor,
  type ConflictRule,
  type MatrixRow,
  type WriterRole,
} from '@podium/model'

/**
 * Why a write lost. Every member is a POLICY outcome about a write the principal
 * was already authorized to make, so each may be surfaced to its author — that is
 * what makes reject-and-rebase (POD-316) possible at all.
 */
export type ArbitrationRejection =
  /** `exp-rev`: the caller's expected revision is not the entity's current one. */
  | 'revision-mismatch'
  /** `exp-rev`: a mutating command arrived without one. Default-closed. */
  | 'expected-revision-required'
  /** `single-writer`: this writer is not the row's home source. */
  | 'not-the-single-writer'
  /** `append`: the entity exists, and this class admits creates only. */
  | 'append-only'
  /** `field-LWW`: the attempt's Authority event time is not later than the row's. */
  | 'stale-write'
  /** `cmd`: the command's own documented rule refused it. */
  | 'command-rule-refused'

export type ArbitrationVerdict =
  | { readonly kind: 'accept'; readonly rule: ConflictRule }
  | {
      readonly kind: 'reject'
      readonly rule: ConflictRule
      readonly reason: ArbitrationRejection
      /** Free-form, from a `cmd` rule only. Never carries identity. */
      readonly detail?: string
    }

/**
 * The entity's CURRENT authoritative state, as the Authority reads it at commit.
 *
 * `undefined` means the entity does not exist yet — which is a different fact
 * from "exists with no revision", and the two arbitrate differently under
 * `append`. Read live at the attempt and never cached: a cached revision is a
 * stale-write window with the size of the cache's TTL.
 */
export interface ArbitrationCurrent {
  /** ADR 2 D3's monotonic, Authority-assigned token. */
  readonly revision?: number
  /** The Authority event time this row was last committed at (ADR 1 D3's clock). */
  readonly eventTime?: number
  /** Which role last wrote it, for `single-writer` rows. */
  readonly writer?: WriterRole
}

/** The write being attempted. */
export interface ArbitrationAttempt {
  /** What the caller believes the current revision is. Required on `exp-rev`. */
  readonly expectedRevision?: number
  /**
   * The AUTHORITY-assigned event time for this commit (ADR 1 D3 condition 1).
   *
   * The caller passes it because the Authority stamps it a few lines earlier in
   * the same commit; it is emphatically not read off the wire. A client wall
   * clock may be attribution metadata and may never arbitrate — `FIELD_LWW_CLOCK`
   * names the one legal answer, and there is nowhere in this type to put another.
   */
  readonly eventTime: number
  /** Which role is writing, for `single-writer` rows. */
  readonly writer?: WriterRole
}

/**
 * A command's own documented rule, for rows declared `cmd`.
 *
 * REQUIRED for those rows and absent for all others: ADR 1 D2 says a
 * command-specific rule must be "documented on that command", so a `cmd` row
 * whose command supplies no rule has no arbitration at all, and this module
 * throws rather than waving it through. That throw is the whole value of the
 * `cmd` class — otherwise it is a synonym for "unchecked".
 */
export type CommandArbitrationRule = (
  attempt: ArbitrationAttempt,
  current: ArbitrationCurrent | undefined,
) => { readonly ok: true } | { readonly ok: false; readonly detail?: string }

export interface ArbitrationRequest {
  /** The ownership-matrix row this write belongs to. */
  readonly rowId: string
  readonly attempt: ArbitrationAttempt
  /** Absent means the entity does not exist yet. */
  readonly current?: ArbitrationCurrent
  /**
   * Compatibility policy for an `exp-rev` update whose caller omitted the
   * precondition. The kernel remains fail-closed by default; a production
   * surface with legacy callers must opt into the temporary permissive arm at
   * the Authority decision rather than bypassing arbitration in another layer.
   */
  readonly omittedExpectedRevision?: 'accept' | 'reject'
  /** Required iff the row's declared rule is `cmd`. */
  readonly commandRule?: CommandArbitrationRule
  /** Which role owns writes to a `single-writer` row (the row's home source). */
  readonly singleWriter?: WriterRole
  /**
   * The matrix to resolve `rowId` against. Defaults to the shipped one, and
   * production never passes it.
   *
   * It exists because `op-stream` is RESERVED and no shipped row declares it
   * (ADR 1 Am1 D12 keeps its three members on `field-LWW` today), so the arm
   * that must throw is unreachable from real data. Without this seam that arm
   * would be untested — and an untested throw is indistinguishable from a
   * missing one until the day somebody moves a row and gets a silent LWW merge
   * on collaborative text. `conflictRuleFor` already takes the same parameter;
   * this forwards it rather than inventing a second way to ask.
   */
  readonly index?: ReadonlyMap<string, MatrixRow>
}

const accept = (rule: ConflictRule): ArbitrationVerdict => ({ kind: 'accept', rule })
const reject = (
  rule: ConflictRule,
  reason: ArbitrationRejection,
  detail?: string,
): ArbitrationVerdict =>
  detail === undefined ? { kind: 'reject', rule, reason } : { kind: 'reject', rule, reason, detail }

/**
 * Arbitrate one write against its row's DECLARED conflict rule.
 *
 * The rule is read from the ownership matrix, never passed in: a caller that
 * could name its own rule could name the permissive one, and the matrix's
 * totality test would have nothing to be total about.
 */
export function arbitrate(request: ArbitrationRequest): ArbitrationVerdict {
  // Throws on an undeclared row (ADR 1 D4 totality). Deliberately not caught:
  // committing under a class with no declared conflict rule is the failure.
  const rule = conflictRuleFor(request.rowId, request.index)
  const { attempt, current } = request

  switch (rule) {
    case 'exp-rev':
      return arbitrateExpectedRevision(
        attempt,
        current,
        request.omittedExpectedRevision ?? 'reject',
      )

    case 'single-writer': {
      // The home source is a property of the ROW, so a request that does not
      // name one cannot be arbitrated — waving it through would make
      // `single-writer` mean nothing on exactly the rows that chose it (daemon
      // observation streams: "clients cannot forge status", ADR 1's matrix).
      if (request.singleWriter === undefined) {
        throw new Error(
          `arbitration: row '${request.rowId}' is single-writer but the request names no home ` +
            'source. The writer that owns the row is a row fact and must be supplied (ADR 1 D2).',
        )
      }
      return attempt.writer === request.singleWriter
        ? accept(rule)
        : reject(rule, 'not-the-single-writer')
    }

    case 'append':
      // Append-only CREATE (ADR 1's matrix: issue comments, issue messages,
      // queued agent messages). Existence is the whole test; there is no
      // revision to compare, which is why an append row need not carry one.
      return current === undefined ? accept(rule) : reject(rule, 'append-only')

    case 'field-LWW':
      return arbitrateFieldLww(attempt, current)

    case 'cmd': {
      if (request.commandRule === undefined) {
        throw new Error(
          `arbitration: row '${request.rowId}' declares the command-specific rule but the request ` +
            'supplies none. ADR 1 D2 requires the rule to be documented on the command; a `cmd` ' +
            'row with no rule is an unarbitrated write, not a permissive one.',
        )
      }
      const verdict = request.commandRule(attempt, current)
      return verdict.ok ? accept(rule) : reject(rule, 'command-rule-refused', verdict.detail)
    }

    case 'op-stream':
      // ADR 1 Amendment 1 D12 RESERVES this class; nothing implements it. The
      // three members stay `field-LWW` on the matrix today, so reaching here
      // means a row was moved to `op-stream` without the sequencer landing.
      // Degrading to LWW would silently drop characters out of collaborative
      // text with nothing downstream able to tell, so this throws.
      throw new Error(
        `arbitration: row '${request.rowId}' declares 'op-stream', which is RESERVED and ` +
          'unbuilt (ADR 1 Amendment 1 D12). There is no safe fallback — a degraded merge on ' +
          'collaborative text loses content silently. Land the sequencer or keep the row on ' +
          'its declared interim rule.',
      )

    case 'live-ephemeral':
    case 'n/a':
      // ADR 1 D4's markers for state that is not a durable conflict at all.
      // Nothing to arbitrate, so nothing is arbitrated — and saying so
      // explicitly is what keeps them out of the default arm below.
      return accept(rule)

    default: {
      // Exhaustiveness with teeth: a new member of ConflictRule fails the build
      // here, and if one somehow reaches this at runtime it refuses rather than
      // defaulting to accept. A default that accepted would make every future
      // class permissive on the day it was added and silent about it.
      const unreachable: never = rule
      throw new Error(
        `arbitration: unhandled conflict rule ${JSON.stringify(unreachable)} on row ` +
          `'${request.rowId}'. A new class must declare how it arbitrates before it can commit.`,
      )
    }
  }
}

/**
 * ADR 1 D2 — the DEFAULT rule. Mutating commands carry an expected revision; on
 * mismatch the Authority rejects and the client rebases (POD-316).
 *
 * Two cases that look like edge cases and are the rule:
 *
 *  - A CREATE (no current row) needs no expected revision. Demanding one would
 *    make it impossible to create anything, since there is no revision to have
 *    expected. What it must NOT do is accept an expectation that is wrong about a
 *    row that does not exist — `expectedRevision` against `current === undefined`
 *    is a caller who believes it is updating, and it is rejected.
 *  - A missing expected revision on an UPDATE is a rejection, not a pass. That is
 *    D2's "silent whole-aggregate LWW is not the default" expressed at the one
 *    place it could leak in: a client that simply omits the field would otherwise
 *    get last-write-wins for free on the rows most protected against it.
 */
function arbitrateExpectedRevision(
  attempt: ArbitrationAttempt,
  current: ArbitrationCurrent | undefined,
  omittedExpectedRevision: 'accept' | 'reject',
): ArbitrationVerdict {
  if (current === undefined) {
    return attempt.expectedRevision === undefined
      ? accept('exp-rev')
      : reject('exp-rev', 'revision-mismatch')
  }
  if (attempt.expectedRevision === undefined) {
    return omittedExpectedRevision === 'accept'
      ? accept('exp-rev')
      : reject('exp-rev', 'expected-revision-required')
  }
  return attempt.expectedRevision === current.revision
    ? accept('exp-rev')
    : reject('exp-rev', 'revision-mismatch')
}

/**
 * ADR 1 D3 — field-level LWW, opt-in and clock-defined.
 *
 * The winner is the greater AUTHORITY-ASSIGNED EVENT TIME AT COMMIT. Two
 * consequences that are easy to get backwards:
 *
 *  - A TIE LOSES. Equal event times mean the incumbent stays, so arbitration is
 *    deterministic under a coarse clock instead of depending on which write the
 *    scheduler happened to run second. "Last" has to mean strictly later or the
 *    rule is a coin flip at millisecond resolution — and a coin flip is precisely
 *    what D3's "defined clock" condition exists to rule out.
 *  - A row with no recorded event time is not a licence. It arbitrates as "any
 *    write is later", which is the create case; the `current === undefined` arm
 *    above it covers the entity that does not exist.
 */
function arbitrateFieldLww(
  attempt: ArbitrationAttempt,
  current: ArbitrationCurrent | undefined,
): ArbitrationVerdict {
  if (current?.eventTime === undefined) return accept('field-LWW')
  return attempt.eventTime > current.eventTime
    ? accept('field-LWW')
    : reject('field-LWW', 'stale-write')
}
