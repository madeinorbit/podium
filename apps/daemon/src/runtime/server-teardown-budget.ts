/**
 * HOW LONG A SERVER-FAMILY TEARDOWN IS ALLOWED TO TAKE, IN ONE PLACE (POD-2775).
 *
 * Two numbers used to live apart, and they disagreed. Each server host declares
 * its own stdin-EOF window — 2s, spelled once in `codex-app-server.ts` and again
 * in `grok-acp-server.ts` — and `server-reap.ts` bounded the handle verb that
 * SPENDS that window at 1s. The reap's own comment stated the relationship it
 * needed ("the graceful endings the drivers define … have already run inside the
 * handle verb by the time these polls start") while its constant made that
 * relationship impossible.
 *
 * The result was measured on a live instance: EVERY ordinary hibernate of a
 * codex app-server session logged `could not complete the server-driver verb`
 * at exactly 1000ms, and then `the server-driver process needs measured
 * escalation` against a child that was one second away from exiting cleanly on
 * its own. Nothing was wedged. The bound was simply shorter than the thing it
 * was bounding.
 *
 * So the graceful window and the bound that must outlast it are declared here,
 * together, where the inequality between them is one expression rather than a
 * coincidence between two files. Two constants that merely happen to agree today
 * is exactly how this defect happened.
 */

/**
 * How long a SIGTERM stop waits for a server child to take its stdin EOF before
 * signalling.
 *
 * Short on purpose: the exit is a process teardown, not model work, and the only
 * thing being waited for is the last flush of the file the NEXT RESUME reads —
 * codex's rollout JSONL. That is also why the window exists at all rather than
 * the stop going straight to a signal.
 */
export const SERVER_GRACEFUL_EXIT_MS = 2_000

/**
 * The bound each server host puts on ONE `systemctl` call in its scope reclaim.
 *
 * Declared here rather than spelled `8000` in `codex-app-server.ts`,
 * `grok-acp-server.ts` and `opencode-server.ts` separately — which is what it
 * was, and is the same shape as the defect at the top of this file: numbers that
 * bound each other, living where nothing can see the relationship.
 */
export const SERVER_SYSTEMCTL_CALL_TIMEOUT_MS = 8_000

/**
 * What the reclaim can spend at WORST: `scopeReclaimArgvs` is two calls —
 * `systemctl --user stop` then `reset-failed` — run back to back, each bounded
 * by {@link SERVER_SYSTEMCTL_CALL_TIMEOUT_MS}.
 *
 * Written down because it is the number the honest version of the bound below
 * has to be stated against. (A first `canScopeMaster()` probe carries the same
 * per-call bound again, but it is memoized per process and long resolved by the
 * time any teardown runs.)
 */
export const SERVER_SCOPE_RECLAIM_WORST_MS = 2 * SERVER_SYSTEMCTL_CALL_TIMEOUT_MS

/**
 * What a stop verb may spend AFTER its graceful window before the reap stops
 * waiting for it: the best-effort `systemctl --user stop` / `reset-failed` pair
 * that reclaims the session's transient scope.
 *
 * An ALLOWANCE, NOT A GUARANTEE, and deliberately far below
 * {@link SERVER_SCOPE_RECLAIM_WORST_MS}. Those calls resolve rather than reject
 * and the reclaim is best-effort, so a loaded box overruns this — by design,
 * because waiting out systemd's worst case would put 16 further seconds on the
 * receipt an operator is watching for. That is survivable precisely because
 * overrunning is no longer mistaken for a wedged process: the reap measures the
 * process separately and believes the measurement.
 */
export const SERVER_SCOPE_RECLAIM_ALLOWANCE_MS = 2_000

/**
 * The bound the reap puts on a driver's own `stop()` / `kill()`.
 *
 * WHAT THIS IS STRICTLY GREATER THAN, stated exactly, because the previous
 * version of this comment claimed more than it could back (POD-2775, review
 * round 2, finding 5): it said "everything those verbs are DEFINED to spend",
 * and codex's `stop()` is defined to spend up to
 * `SERVER_GRACEFUL_EXIT_MS + SERVER_SCOPE_RECLAIM_WORST_MS` — 18s against this
 * 4s. The same shape as the defect at the top of this file, in the opposite
 * direction: an assertion about two numbers that the numbers do not support.
 *
 * What it IS greater than is {@link SERVER_GRACEFUL_EXIT_MS}, the one part of
 * the verb whose duration is a CONTRACT — the window the driver promises to wait
 * for its child's stdin EOF, and the window whose last act writes the file the
 * next resume reads. That inequality is the load-bearing one, and cutting it is
 * what made every healthy park log a failure.
 *
 * The rest is the reclaim, whose duration belongs to systemd rather than to any
 * declaration of ours. So expiring this bound means "the reclaim outran its
 * allowance", NOT "this driver is misbehaving" — and nothing downstream reads it
 * as the latter any more: `server-reap.ts` escalates on the measured state of
 * the process, never on an expired bound.
 */
export const SERVER_HANDLE_VERB_TIMEOUT_MS =
  SERVER_GRACEFUL_EXIT_MS + SERVER_SCOPE_RECLAIM_ALLOWANCE_MS
