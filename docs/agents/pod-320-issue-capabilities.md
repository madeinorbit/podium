# POD-320 issue capability recomposition

## As-built topology

`IssueService` is now a composition root over one `IssueStore`. The store alone owns hydration,
the row cache, per-user overlays, wire serialization, persistence, ledger commits, projections and
publication. Six separately instantiated capability modules receive that store and expose narrow
interfaces: CRUD plus stage machine, hierarchy plus dependencies, comments plus tracker mail,
attention plus subscriptions, git workflow, and reports. Cross-capability behavior travels through
constructor-injected interfaces; no module reads another module's state. Specs remain the
`SpecsService` sibling in the tracker module set and never enter the issue store.

Issue command dependencies expose `IssueTrackerCapabilities`, not `IssueService`. Every registry
handler selects its owning capability, while the shared authorization adapter flattens only the
public report lookup and hierarchy ancestry interfaces needed by `checkIssueAccess`. A temporary
compatibility proxy forwards direct `IssueService` calls to the owning capability for non-command
integrations and existing tests; it copies no methods, owns no state, and command handlers cannot
type against it.

## Ownership and attribution declarations

- Issue create is personal/private. The owner is the authenticated principal's human
  `onBehalfOf`; the actor and on-behalf-of pair are transport-derived and payload identity is inert.
- A comment inherits the parent issue's owner, visibility and grants. Its actor and on-behalf-of
  pair are stamped from the transport principal and stored on the comment row.
- Tracker mail is personal through its addressed issue. Send remains unscoped with the write role
  gate, then the unified message gate applies the delegating human's live visibility ceiling;
  invisible and nonexistent recipients share the same unresolvable path. Inbox read state is
  per-user and claim remains subtree-gated.
- Needs-human state and subscriptions live in the attention capability. Per-user markers continue
  through `(userId, issueId)` storage; `askedBy` remains server-authoritative.
- Hierarchy and dependency writes carry issue targets through the existing scope override path.
  Reparent is explicitly permission-affecting because subtree scope is a moving set. Cross-owner
  confirmation remains open under POD-1070; this change preserves today's `--outside-scope`
  confirmation and invents no replacement policy.
- Worktree lifecycle, PR and merge operations remain issue-owned workflow facts. Per-machine
  worktree visibility continues to inherit the machine's owned-compute policy; no instance column
  or second tracker store was added.

## Open existence policy switches

The reports module owns one default-closed switch for each unresolved policy class:
cross-boundary edges, counts, tree, graph, doctor and reference allocation. Current values hide or
restrict all hidden-issue information. The switches reserve the policy decision without baking a
permissive answer into the queries.

## Behavior ledger

Stage transitions, authorization routing, mail send/inbox/claim shapes and post-chain worktree
semantics are unchanged. One deliberate multi-user correction lands here: the add-comment command
now passes the authenticated transport principal into comment persistence, so an agent comment
records `actor = session:<agent>` and `onBehalfOf = <delegating human>`. The registry regression
test proves both halves; no payload field can supply either value.

Verification on the final object composition: server typecheck; 2-file/20-test composition and
registry checkpoint; 28-file/632-test dense issue, funnel, authorization, mail, CLI, MCP and relay
surface; 10-file/183-test named SessionService oracle. Final repository lanes are recorded in the
issue handoff; explicit source audits report one `IssueStore` construction, six distinct capability
objects, zero service class inheritance, zero prototype installation and zero command-handler
`IssueService` bindings.
