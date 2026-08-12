/**
 * "That issue does not exist" as a TYPE rather than a message (POD-1926).
 *
 * The service layer is transport-free — the same methods serve tRPC, the daemon
 * relay gate and the in-process MCP — so it cannot throw a `TRPCError` without
 * dragging one transport's vocabulary into all three. It threw a bare `Error`
 * instead, and that is what this class replaces.
 *
 * ---------------------------------------------------------------------------
 * WHY A BARE `Error` WAS A BUG, NOT A STYLE PROBLEM
 * ---------------------------------------------------------------------------
 *
 * tRPC has no mapping for an unrecognised `Error`, so it surfaced as
 * `INTERNAL_SERVER_ERROR` / HTTP 500. The client outbox sorts every drain
 * failure through `classifyRefusal` (packages/client-core/src/outbox.ts), and
 * that function is deliberately total in the other direction: a code it does not
 * recognise is TRANSIENT, because "an unknown refusal must keep the user's work
 * queued and retryable rather than park it on a guess". ADR 3 D10 then gives a
 * transient failure unlimited attempts, spaced by a backoff capped at 60s, until
 * the 14-day age limit ends it.
 *
 * So a 500 on a vanished issue did not fail — it LOOPED. A read receipt queued
 * for a draft the reaper had purged retried once a minute for two weeks, and the
 * only place it was visible was the browser console. A `NOT_FOUND` classifies as
 * `target-not-found`, which is DEFINITIVE: zero automatic retries, straight to
 * the dead-letter surface where the user can discard it.
 *
 * The mapping to `NOT_FOUND` happens once, at the tRPC boundary
 * (`modules/issues/trpc.ts`), so every issue command gets it and no handler has
 * to remember. The relay gate and the CLI keep reading `err.message`, which this
 * class leaves exactly as it was.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OPERATOR NEEDS IT AT ALL
 * ---------------------------------------------------------------------------
 *
 * `guardIssueCommand` already answers a nonexistent target with `NOT_FOUND` —
 * but only for a CONSTRAINED capability: it extracts `def.target` when
 * `scope.kind !== 'all'`, so an operator (every browser session) skips the check
 * entirely and reaches the service. The per-user commands — `markRead`,
 * `markUnread`, `setTucked` — declare no target extractor at all, so they skip it
 * for every caller. Both holes end here.
 */

/** The service's "no such issue", carrying the ref the caller actually passed. */
export class IssueNotFound extends Error {
  constructor(readonly ref: string) {
    super(`unknown issue ${ref}`)
    this.name = 'IssueNotFound'
  }
}

/** Structural, not `instanceof`: the server loads `@podium/*` through workspace
 *  links and a duplicated module copy would make `instanceof` quietly false —
 *  the same reason `isPoisonError` on the client matches by shape. */
export const isIssueNotFound = (err: unknown): err is IssueNotFound =>
  err instanceof Error && err.name === 'IssueNotFound'
