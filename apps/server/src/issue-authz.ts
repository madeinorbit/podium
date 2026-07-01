/**
 * Issue-tracker AUTHORIZATION — what a caller may do with issues.
 *
 * Distinct from AUTHENTICATION (auth-store / auth-route gate *who* may reach /trpc at all,
 * and the daemon secret gates the machine↔server channel). This layer answers *what* a
 * caller who got in may do. Two principals:
 *   - the **operator** — the cookie-authed human on /trpc, plus the trusted in-process MCP —
 *     is unconstrained (OPERATOR);
 *   - **agents** — relayed to the server via their daemon — carry a constrained capability.
 *
 * Only the operator is wired today; the agent path (daemon relay + per-agent capability,
 * including per-issue SCOPE) lands with agent integration. The model is built so that turning
 * it on is wiring, not a rewrite — hence Capability carries an extensible `scope`, and `can`
 * already has the scoped-enforcement branch.
 */

export type IssueRole = 'viewer' | 'worker' | 'admin'

/** What an issue op requires. viewer=read · worker=+write · admin=+manage (structural/destructive). */
export type IssueAction = 'read' | 'write' | 'manage'

const ROLE_ACTIONS: Record<IssueRole, IssueAction[]> = {
  viewer: ['read'],
  worker: ['read', 'write'],
  admin: ['read', 'write', 'manage'],
}

/**
 * The slice of issues a capability applies to. `all` today; `subtree` is the reserved
 * per-issue extension (an agent bound to one issue tree). The enforcement branch for it is
 * already in `can`, so enabling per-issue scope later is wiring (mint a scoped cap + hand the
 * guard the target issue), not a model change.
 */
export type IssueScope = { kind: 'all' } | { kind: 'none' } | { kind: 'subtree'; rootId: string }

/** Full authz outcome: a hard role denial vs. a scope violation the caller may knowingly override. */
export type AuthDecision = 'allow' | 'forbidden' | 'confirm-required'

export interface Capability {
  role: IssueRole
  scope: IssueScope
}

/** The human operator (and, for now, the trusted in-process MCP): unconstrained. */
export const OPERATOR: Capability = { role: 'admin', scope: { kind: 'all' } }

/** Which action each issues.* procedure requires. Unlisted ⇒ 'read' (queries). */
export const PROC_ACTION: Record<string, IssueAction> = {
  // write — do the work on an issue
  claim: 'write',
  update: 'write',
  addComment: 'write',
  defer: 'write',
  close: 'write',
  start: 'write',
  addSession: 'write',
  addShell: 'write',
  action: 'write',
  applySuggestion: 'write',
  dismissSuggestion: 'write',
  refreshAssistant: 'write',
  depAdd: 'write',
  // hits the external Linear API — keep read-only callers from driving it
  linearSearch: 'write',
  // write — filing/decomposing is additive; scope gates writes to EXISTING issues, not creation
  create: 'write',
  // manage — structural / destructive / cross-cutting
  archive: 'manage',
  delete: 'manage',
  setLabels: 'manage',
  depRemove: 'manage',
  reparent: 'manage',
  supersede: 'manage',
  duplicate: 'manage',
}

/**
 * May `cap` perform `action` (optionally on `issue`)? `issue` — with the ids of its
 * ancestors — is consulted only for a `subtree` scope; an `all` scope ignores it. A scoped
 * capability with no target issue is denied (it can't prove the op is in-scope). Pure.
 */
export function can(
  cap: Capability,
  action: IssueAction,
  issue?: { id: string; ancestorIds?: string[] },
): boolean {
  if (!ROLE_ACTIONS[cap.role].includes(action)) return false
  if (cap.scope.kind === 'subtree') {
    if (!issue) return false
    return issue.id === cap.scope.rootId || (issue.ancestorIds ?? []).includes(cap.scope.rootId)
  }
  return true
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
