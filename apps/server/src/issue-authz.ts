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
 * it on is wiring, not a rewrite — hence Capability carries an extensible `scope` that both
 * `authorize` and the router's issueCapabilityGuard already enforce.
 */

import { TRPCError } from '@trpc/server'

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

/** Which action each issues.* procedure requires. Unlisted ⇒ 'read' (queries). */
export const PROC_ACTION: Record<string, IssueAction> = {
  // write — do the work on an issue
  claim: 'write',
  update: 'write',
  addComment: 'write',
  defer: 'write',
  undefer: 'write',
  setNeedsHuman: 'write',
  clearNeedsHuman: 'write',
  close: 'write',
  start: 'write',
  addSession: 'write',
  addShell: 'write',
  action: 'write',
  // write, not manage: heavily guarded (closed + merged + clean only), so a
  // closing agent may clean up after itself.
  cleanup: 'write',
  // write, not manage: builds/reset a dedicated integration worktree+branch only —
  // never touches child branches, the root checkout, or the parent branch. Spawns
  // nothing, so no confirm gate beyond the write role gate.
  integrate: 'write',
  applySuggestion: 'write',
  dismissSuggestion: 'write',
  refreshAssistant: 'write',
  depAdd: 'write',
  // agent-published human panel (todos/artifacts/deferred) — part of doing the work
  panelApply: 'write',
  // agent-posted current state (activityNotes) — same nature as panelApply
  setState: 'write',
  // hits the external Linear API — keep read-only callers from driving it
  linearSearch: 'write',
  // write — filing/decomposing is additive; scope gates writes to EXISTING issues, not creation
  create: 'write',
  // write, DELIBERATELY NOT scope-gated (no SCOPED_TARGET entry): attaching is the
  // session RE-HOMING itself onto another issue — targeting outside the current
  // subtree is the whole point (issue-as-workspace), so no --outside-scope needed.
  attachSession: 'write',
  // agent mail (issue #103)
  // write, DELIBERATELY NOT scope-gated (no SCOPED_TARGET entry): mail is an
  // append-only mailbox and addressing ANOTHER issue is the whole point of it —
  // cross-issue sends must not require --outside-scope. Treated like `create`
  // (a write with no existing-target issue), so the role gate still applies.
  mailSend: 'write',
  // write, scoped to the caller's own subtree; the target issue lives behind the
  // message id, so the scope check is enforced in the router proc itself (the
  // SCOPED_TARGET extractor cannot resolve message→issue from the input alone —
  // its entry below documents that and returns undefined).
  mailClaim: 'write',
  // reads: inbox listing marks messages read, but that is mailbox bookkeeping on
  // behalf of the reader, not issue mutation — viewers may check mail.
  mailInbox: 'read',
  mailPending: 'read',
  // event subscriptions (Phase B): add/remove operate on the CALLER's own
  // subscriptions (subscriber = the caller), so like mailSend they are 'write'
  // with no existing-issue target — the source-within-subtree check lives in the
  // proc itself (no SCOPED_TARGET entry). list is a read of the caller's own rows.
  subscriptionAdd: 'write',
  subscriptionRemove: 'write',
  subscriptionList: 'read',
  // manage — structural / destructive / cross-cutting
  archive: 'manage',
  delete: 'manage',
  setLabels: 'manage',
  depRemove: 'manage',
  reparent: 'manage',
  supersede: 'manage',
  duplicate: 'manage',
}

/** proc name → how to read the target EXISTING issue id from its input. Shared by the
 *  router's scope gate AND the viaHub forwarding detection (node-hub-issues §2.2) — every
 *  write/manage proc that mutates an existing issue must appear (create/linearSearch are
 *  additive / not-an-issue). router.issues.test.ts ties this set to PROC_ACTION so a new
 *  write/manage proc can't silently escape either check. Lives here (a leaf module) so
 *  relay.ts can consume it without importing the router. */
export const SCOPED_TARGET: Record<string, (i: Record<string, unknown>) => string | undefined> = {
  // write — target = the issue being worked on
  claim: (i) => i.id as string,
  update: (i) => i.id as string,
  close: (i) => i.id as string,
  defer: (i) => i.id as string,
  undefer: (i) => i.id as string,
  setNeedsHuman: (i) => i.id as string,
  clearNeedsHuman: (i) => i.id as string,
  addComment: (i) => i.id as string,
  panelApply: (i) => i.id as string,
  setState: (i) => i.id as string,
  action: (i) => i.id as string,
  // cleanup is scope-gated like its siblings but is NOT hub-forwarded: its router
  // proc bypasses issueWrite and refuses upstream issues (local git state only).
  cleanup: (i) => i.id as string,
  // integrate is scope-gated like its siblings but is NOT hub-forwarded either:
  // it rebuilds a local integration worktree (local git state only).
  integrate: (i) => i.id as string,
  applySuggestion: (i) => i.id as string,
  dismissSuggestion: (i) => i.id as string,
  refreshAssistant: (i) => i.id as string,
  start: (i) => i.id as string,
  addSession: (i) => i.id as string,
  addShell: (i) => i.id as string,
  depAdd: (i) => i.fromId as string,
  // mailClaim's target issue lives behind the MESSAGE id, which a pure input
  // extractor cannot resolve — the router proc resolves message→issue and runs
  // the same scope check itself. Listed here (returning undefined) so the
  // PROC_ACTION↔SCOPED_TARGET coverage tests stay complete; the guard skips an
  // undefined target and the proc-level check is the enforcement. NOT hub-
  // forwarded (message ids are node-local).
  mailClaim: () => undefined,
  // manage — target = the mutated subject issue (verified against each resolver's input)
  archive: (i) => i.id as string,
  delete: (i) => i.id as string,
  setLabels: (i) => i.id as string,
  reparent: (i) => i.id as string,
  depRemove: (i) => i.fromId as string,
  supersede: (i) => i.oldId as string,
  duplicate: (i) => i.id as string,
}

/** The slice of IssueService the access check needs (target existence + subtree walk). */
export interface IssueAccessIndex {
  get(id: string): unknown
  ancestorIds(id: string): string[]
}

/**
 * THE issue-access gate (issue #25): one decision + one throw-shape for every
 * entry point. Used by the router's issueCapabilityGuard middleware AND by
 * in-proc gates whose target can't be extracted from the raw input (mailClaim
 * resolves message→issue first) — previously those duplicated this check
 * verbatim, and the copies could drift.
 *
 * Semantics (all pinned by characterization contract 6):
 *   - role gate: a role that can't perform `action` at all ⇒ FORBIDDEN;
 *   - scope gate: a constrained (non-'all') capability writing an EXISTING
 *     target issue outside its subtree ⇒ PRECONDITION_FAILED (overridable via
 *     `overrideScope` / --outside-scope), a scope kind that never allows it ⇒
 *     FORBIDDEN;
 *   - no target / unknown target (e.g. hub-mirrored issues, additive procs) ⇒
 *     role gate only.
 */
export function checkIssueAccess(
  caller: { capability: Capability; overrideScope?: boolean },
  issues: IssueAccessIndex,
  proc: string,
  action: IssueAction,
  targetId?: string,
): void {
  // Role gate (no input needed): authorize with no issue = role decision.
  if (authorize(caller.capability, action) === 'forbidden') {
    throw new TRPCError({ code: 'FORBIDDEN', message: `not allowed to '${proc}' issues` })
  }
  // Scope gate: only for constrained caps writing an existing target issue.
  if (caller.capability.scope.kind === 'all') return
  if (!targetId || !issues.get(targetId)) return
  const decision = authorize(
    caller.capability,
    action,
    { id: targetId, ancestorIds: issues.ancestorIds(targetId) },
    { override: caller.overrideScope },
  )
  if (decision === 'confirm-required') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `issue ${targetId} is outside your subtree; re-run with --outside-scope to confirm`,
    })
  }
  if (decision === 'forbidden') {
    throw new TRPCError({ code: 'FORBIDDEN', message: `not allowed to '${proc}' issues` })
  }
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
