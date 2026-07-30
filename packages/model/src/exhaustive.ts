/**
 * Totality guard for the model's closed unions.
 *
 * `packages/model` is the one authoritative definition site, which only holds if
 * a union gaining a member BREAKS THE BUILD at every place that matches on it
 * rather than falling into a silent default. Every `switch` over a closed union
 * in this package ends in `default: return assertUnreachable(x)`.
 *
 * This matters most for the authorization scope set (authz/issue-authz.ts):
 * POD-1075 and Phase 3 extend `IssueScope` with owner- and grant-scoped members,
 * and a silent default there would fail OPEN — the opposite of the
 * default-closed rule in docs/multi-user-readiness.md §3.1.1.
 */

/**
 * Reached only if a union gained a member that some `switch` above does not
 * handle — which is a compile error at the call site, because the argument no
 * longer narrows to `never`. Throws if it is somehow reached at runtime (an
 * unvalidated value crossing a boundary), so unknown input fails closed.
 */
export function assertUnreachable(value: never): never {
  throw new Error(`unhandled union member: ${JSON.stringify(value)}`)
}
