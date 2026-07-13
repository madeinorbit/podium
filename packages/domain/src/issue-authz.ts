/**
 * Issue-tracker AUTHORIZATION POLICY — what a caller may do with issues.
 *
 * Distinct from AUTHENTICATION (auth-store / auth-route gate *who* may reach /trpc at all,
 * and the daemon secret gates the machine↔server channel). This layer answers *what* a
 * caller who got in may do. Two principals:
 *   - the **operator** — the cookie-authed human on /trpc, plus the trusted in-process MCP —
 *     is unconstrained (OPERATOR);
 *   - **agents** — relayed to the server via their daemon — carry a constrained capability.
 *
 * PURE policy only: role/scope tables and the `authorize` decision. The transport-shaped
 * enforcement (`checkIssueAccess`, which throws TRPCError) stays in apps/server.
 */

export type IssueRole = 'viewer' | 'worker' | 'admin'

/** What an issue op requires. viewer=read · worker=+write · admin=+manage (operator-only destructive/administrative). */
export type IssueAction = 'read' | 'write' | 'manage'

const ROLE_ACTIONS: Record<IssueRole, IssueAction[]> = {
  viewer: ['read'],
  worker: ['read', 'write'],
  admin: ['read', 'write', 'manage'],
}

/**
 * The slice of issues a capability applies to. `all` today; `subtree` is the reserved
 * per-issue extension (an agent bound to one issue tree). `authorize` and the router guard
 * already enforce it, so enabling per-issue scope later is wiring (mint a scoped cap for the
 * agent), not a model change.
 */
export type IssueScope = { kind: 'all' } | { kind: 'none' } | { kind: 'subtree'; rootId: string }

/** Full authz outcome: a hard role denial vs. a scope violation the caller may knowingly override. */
export type AuthDecision = 'allow' | 'forbidden' | 'confirm-required'

export interface Capability {
  role: IssueRole
  scope: IssueScope
  /** The session behind this call, when the caller is an agent (relay path).
   *  Undefined for the operator/web. Threaded onto close/unblock events so the
   *  steward can skip nudging the very session that caused them (#116). */
  actorSessionId?: string
}

/** The human operator (and, for now, the trusted in-process MCP): unconstrained. */
export const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }

// The per-procedure action/target tables (PROC_ACTION / SCOPED_TARGET) are GONE
// (#248 [spec:SP-3fe2]): a command's required action and its target extractor
// are declared ON its definition in the server's command registry
// (apps/server/src/modules/issues/registry.ts), pinned to the canonical name
// list in @podium/protocol — renaming a command moves its authz with it instead
// of silently resetting to 'read' via a string-map miss.

/** The slice of IssueService the access check needs (target existence + subtree walk). */
export interface IssueAccessIndex {
  get(id: string): unknown
  ancestorIds(id: string): string[]
}

/** Full authz decision for a caller. Distinguishes a hard role denial ('forbidden')
 *  from a scope violation that the caller may knowingly override ('confirm-required').
 *  Reads are scope-free (read-all). A write/manage with no `issue` is additive (e.g. create)
 *  and allowed once the role permits it — scope only gates mutations of an EXISTING issue. */
export function authorize(
  cap: Capability,
  action: IssueAction,
  issue?: { id: string; ancestorIds?: string[] },
  opts?: { override?: boolean },
): AuthDecision {
  if (!ROLE_ACTIONS[cap.role].includes(action)) return 'forbidden'
  if (action === 'read') return 'allow'
  if (cap.scope.kind === 'all') return 'allow'
  if (!issue) return 'allow'
  if (cap.scope.kind === 'subtree') {
    const inSubtree =
      issue.id === cap.scope.rootId || (issue.ancestorIds ?? []).includes(cap.scope.rootId)
    if (inSubtree) return 'allow'
  }
  return opts?.override ? 'allow' : 'confirm-required'
}
