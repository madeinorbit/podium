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
 * What a stop verb may spend AFTER its graceful window and still be behaving as
 * declared: the best-effort `systemctl --user stop` / `reset-failed` pair that
 * reclaims the session's transient scope, plus the `canScopeMaster()` probe in
 * front of it.
 *
 * An ALLOWANCE, NOT A GUARANTEE. Those `systemctl` calls carry their own
 * (much longer) internal bound and resolve rather than reject, so a loaded box
 * can overrun this. That is survivable now precisely because overrunning is no
 * longer mistaken for a wedged process: the reap measures the process
 * separately and believes the measurement.
 */
export const SERVER_SCOPE_RECLAIM_ALLOWANCE_MS = 2_000

/**
 * The bound the reap puts on a driver's own `stop()` / `kill()`.
 *
 * Strictly greater than everything those verbs are DEFINED to spend, so that
 * expiring it means "this driver is not behaving as it declares" — which is the
 * only thing a timeout was ever supposed to catch — rather than "this driver did
 * exactly what it says it does".
 */
export const SERVER_HANDLE_VERB_TIMEOUT_MS =
  SERVER_GRACEFUL_EXIT_MS + SERVER_SCOPE_RECLAIM_ALLOWANCE_MS
