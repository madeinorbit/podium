# Multi-user Podium instance: design

Status: accepted by the user, 3 November 2026 (Q1 and Q2 decided; the outbox question was dropped as out of scope). Issue: POD-6281 under PDM-107.

This file lives on the epic's integration branch `integrate/pdm-107-multi-user` (cut from `dev/mw`). Every task branches from that branch and fast-forwards back into it.
Written against `dev/mw` at `94a059bf3a7c65cb9a1effe761d8737c4796b1fa`. All file references below are to that commit.

This replaces the September design (`docs/architecture/2026-09-11-multi-user-instance-spec.md` in podium-cloud) as the working reference. It keeps that design's product decisions, adopts the machine model that shipped on `dev/mw` in POD-3955, and describes the change against today's code rather than the September branch.

## 1. What we are building

Several people sign in to one Podium instance. Everyone sees and works on the same tasks. Each person's agents, sessions, machines, provider accounts and personal settings stay their own. Admins run the instance, but cannot open or drive anyone else's agents. People join by invitation.

The first release targets one self-hosted or desktop instance. Hosted Podium follows with the same model afterwards (PDM-494).

A one-person instance runs exactly the same model, so nothing here may change how a single person's Podium behaves.

## 2. The rules

### 2.1 People

- **Members.** Each person is a row in `users` with a generated `mem_` id. Email is a login identifier and never a foreign key.
- **Roles.** `admin` or `member`. There is no viewer role.
- **Disabled.** A disabled member (`users.disabled_at`, D14) cannot sign in or act. Their history stays attributed to them.
- **Removal.** Removing a member also releases custody of their machines (POD-4153, already on `dev/mw`). Anything beyond that is out of scope: handing over their tasks, automations or private data.
- **Admission.** Invitation only (D8): an admin issues an expiring single-use link, optionally addressed to an email. Self-registration is deferred.

### 2.2 Tasks are shared

- **Reading.** Every active member can read every task, including tasks agents created (D4). There is no private-task option and no per-task read grant.
- **Editing.** Every active member can edit ordinary task content and properties and comment (D5). Description and brief edits are kept as attributed revisions that can be restored. Only a comment's author edits that comment.
- **The assignee.** Each task has exactly one accountable human, shown as **Assignee** (D1, D10). Any active member can reassign a task to any active member (D2). Agents never change the human assignee.
- **Creator and collaborators.** The creator is recorded separately and never changes. Collaborators are participation records, not access grants.
- **Lifecycle commands.** Destructive or operational commands (delete, restore, shipping, stage transitions with gates) keep their own command contracts. Being able to edit a task is not enough to run them.
- **The sidebar is personal (D3).** It shows tasks the person started or joined, plus a removable "assigned to you by X" row for tasks assigned to them. Seeing a task, searching for it or opening it adds nothing to the sidebar.

### 2.3 Sessions and agents are private

- **Ownership.** A session belongs to the person who started it, or to the person on whose behalf an agent started it. The session's task does not change that. If Bob starts an agent on Alice's task, the session is Bob's.
- **No one else gets in.** Only the session's owner can read, drive, resume, approve or download from it (D7). That excludes other members, the task's assignee and admins.
- **No session sharing.** Session sharing commands are refused at the server, and existing cross-person session grants have no effect.
- **What task readers see (D13).** For each session on a task they can read, other members see the owner, the title and whether it is live or idle. They never see its content or controls.
- **Agents act for one human.** An agent acts for exactly one human: the root of its delegation chain. The server records this as `sessions.delegation`, written by the server (POD-3961).
- **Agent limits.** An agent can read every task its human can read. It can write within its own task subtree, or anywhere its human can write if it says `--outside-scope`. It can never reach another human's sessions.
- **Who an agent talks to.** "Talks to the user" in the seat rule means the agent's own human. A top coordinator working on someone else's task still asks its own human.
- **Reassignment leaves work in place.** Reassigning a task does not move sessions, credentials, approvals or spending. Existing agents keep working under their original human (September addendum §6).

### 2.4 Machines: the POD-3955 model, as shipped

- **Custody.** A machine's custodian is its `grants` row with `verb='manage'` and `custody=1`. Being allowed to run agents on it is a personal `use` grant.
- **Admins.** Admins hold `manage` and `see` on every machine because of their role, but never `use`. An admin who wants to run on someone's machine has to take custody, which is recorded as a takeover, or be given a `use` grant.
- **Unowned machines.** A machine with no custodian can't be used by anyone. Any admin can adopt it.
- **Removal and disable.** Removing a member makes their machines unowned in the same transaction, each with an audit row. Disabling a member keeps other people's shares on their machines.
- **Tasks grant nothing on machines.** Reading or editing a task gives no right to use a machine. A `use` grant never gives access to another person's sessions on that machine.

This replaces the September D9 ("exactly one executing human per machine, no sharing"), the machine half of D12, and §8.1.

**Running on someone else's machine is allowed, with clear warnings (decided 3 Nov 2026, Q1).**
- When Bob holds `use` on Alice's machine, Bob's runs use only Bob's own provider connection, which he explicitly sends to that machine.
- Alice's native logins on it are never used for Bob, and a run with no usable connection of Bob's fails clearly.
- Granting `use` to another person, accepting it, and sending a connection to that machine each show the same warning: both people's agents run under the machine's OS account, so each can read the other's files and installed credentials there.

### 2.5 Provider accounts and credentials

- **Personal ownership.** A provider connection (managed API key, native harness login) belongs to one member. Others cannot see or use it.
- **Explicit selection.** A run uses the initiating member's selected connection. If none is selected it fails; it never falls back to someone else's account.
- **The D11 checkbox.** Each connection has one checkbox, unticked by default: use this connection on all machines I hold custody of, now and in future. The checkbox only reaches the person's own custody machines.

### 2.6 Administration

An admin area covers:
- **People:** members, invites, roles, disable.
- **Access:** admission status and sign-in sessions.
- **Machines:** custody, adopt, revoke.
- **Instance:** instance settings.
- **Audit:** security events, without secrets or transcript content.

Personal settings remain per member.

### 2.7 Not in the first release

- Registration with approval or open registration.
- Per-person concurrency limits and admin usage totals. Usage is still attributed to the person who started the run.
- Following, mute and subscriptions.
- Offboarding beyond custody release.
- Sharing or transferring automations.
- Per-machine credential permissions.
- Recalling credentials already installed on a machine.
- Shared session viewing.
- Presence.

## 3. What `dev/mw` does today, and the gaps

### 3.1 How a request gets an identity

- **Browser and HTTP.** `apps/server/src/server.ts:1596-1625` resolves a cookie or bearer credential to a member row. It mints `userCommandPrincipal(member, role)` (`apps/server/src/command-principal.ts:124-135`).
- **Open mode.** A host-local request, while no member has a password, acts as `store.users.earliestAdmin()`. Open mode turns itself off once any member has a password (`credentialsRequired`).
- **Agents.** Agents arrive over the relay with `capabilityForSession` (`apps/server/src/modules/sessions/session-authz.ts:260-276`). The role is `worker` and the scope is the session's task subtree, or `none`. `resolvePrincipalAsync` walks the delegation chain to its root human (`command-principal.ts:207-232`).
- **System jobs** are `systemPrincipal(job)` and have no transport (`command-principal.ts:263`).

### 3.2 How each kind of thing is authorized today

| Resource | Rule today | Where |
|---|---|---|
| Task, commands | Admin: scope `all`, so everything is allowed. Member: scope `owned`, so only tasks they own or hold a read/write/manage grant on. | `command-principal.ts:129-130`, `packages/model/src/authz/issue-authz.ts:295-355`, `apps/server/src/issue-authz.ts` `checkIssueAccess` |
| Task, feed | Owner, or anyone holding an issue grant. Admins get nothing extra. | `apps/server/src/feed-visibility.ts:193-209`, `211-220` |
| Session, commands | Effective owner is the **task's** owner when the session has a task; grants come from the **task's** grants. Admin scope `all` passes. | `session-authz.ts:294-314`, `159-163` |
| Session, feed | The session's own owner, or anyone holding a session `read` grant. | `feed-visibility.ts:229-235` |
| Machine | Custody/use grant edges; admin manage/see by role, never use. | `apps/server/src/machine-access.ts` (POD-3955) |
| Per-user state | Keyed to the member (`self` scope, `keyedUserOf`). | `feed-visibility.ts:358-386` |
| Automation, run | Feed: owner only. | `feed-visibility.ts:343-354` |
| Task artifact bytes | Any signed-in caller. | `apps/server/src/file-artifact-route.ts` |
| Session or worktree file bytes | Any signed-in caller who names an existing session or root. Only the daemon's path sandbox applies. | `apps/server/src/file-asset-route.ts:30-39` |
| Provider credentials | Instance-wide. The `accounts` table has no owner column. | `apps/server/src/migrations/schema.ts:2777` |
| Everything, legacy device | `device:shared-instance-password` reads every feed row. | `feed-visibility.ts:278` |

### 3.3 Gaps against the rules

1. **Tasks are owner-or-grant, and need to be member-wide.** Today a member who is not the owner and holds no grant can neither read nor edit a task, in commands or in the feed. This is the single largest change. The fix has two halves: commands and feed must be changed together (§4.1), and the split of private execution data (§4.2) has to happen first.
2. **Admins can do everything through commands.** Admin scope `all` short-circuits `authorize()` and `checkIssueAccess`, sessions included. The admin role must stop covering sessions, private files and credentials.
3. **A session inherits its task's owner and grants.** `sessionOwner()` substitutes the task's owner. That breaks D7 both ways: Alice can drive Bob's agent on her task, and Bob can be refused on his own session.
4. **Session file bytes are not owner-checked.** The asset route serves files for any named session or worktree root.
5. **Credentials have no owner.** Managed provider accounts are shared by everyone, which contradicts §2.5. The fix needs an owner column, a migration that assigns existing rows, and per-member selection at spawn.
6. **The first admin stands in for everyone.** 23 non-test server files call `firstAdminMemberId()` or `earliestAdmin()`. Most are bootstrap or recovery paths and should stay. Several read as "the viewer" for everyone:
   - `IssueService.broadcastViewer` (`modules/issues/service/core.ts:130`): the issue broadcast carries the first admin's per-user markers.
   - `settingsViewer` (`session-authz.ts:481`): spawn preferences are read as the first admin's.
   - the session view, revival and start paths.
   - the superagent service and store.
   - the messages service.
7. **A legacy device reads everything.** The `device:shared-instance-password` exception still grants that principal every feed row.
8. **The binding inventory is not filtered** (handover item 1). At daemon connect, the inventory of sessions confirmed for a machine is not narrowed to what the machine's custodian may see. It is `gateway/machine-directory.ts` `bindingConfirmations` and `legacyBindingOwners`.
9. **Owner and on-behalf-of may be conflated** (handover item 2). Not yet verified on every authoring path with two members.
10. **Some notifications are not per member.** Inbox delivery is keyed, but push/ntfy fan-out and issue-event notifications need checking against two members.

What already matches and only needs two-member proof:
- invites, per-member passwords and sign-in sessions (`member-routes.ts`, `member-invites.ts`, `auth-route.ts`);
- the disable and remove transactions (`store/users.ts:468-633`);
- client storage namespaced by `[syncBoundaryId, memberId]` (`packages/client-core/src/replica/principal-storage.ts`);
- the per-member feed machinery (`GrantEdgeVisibilityPolicy`, `grant_audiences`, authorization revision);
- the machine model;
- server-authored delegation.

### 3.4 Which task closes which gap

| Gap | Task |
|---|---|
| 1 Tasks owner-or-grant | POD-6288 |
| 2 Admin bypass | POD-6283 (sessions), POD-6284 (private files and automations), POD-6300 (credentials) |
| 3 Session inherits task owner | POD-6283 |
| 4 Session file bytes | POD-6284 |
| 5 Credentials have no owner | POD-6300 |
| 6 First admin stands in | POD-6285 (request paths), POD-6291 (`broadcastViewer`) |
| 7 Legacy device reads everything | POD-6285 |
| 8 Binding inventory | POD-6286 |
| 9 Owner vs on-behalf-of | POD-6286 |
| 10 Notifications per member | POD-6291 |

## 4. Design changes

### 4.1 One policy for human principals

**Change.** Replace the two human scopes, `all` for admins and `owned` for members, with one member policy that decides by resource class:

| Class | Read | Write | Admin extra |
|---|---|---|---|
| Shared task (issue, issue deps, issue events, task artifacts, comments) | Every active member | Every active member (ordinary edits); lifecycle commands by contract | Moderation and lifecycle commands per contract |
| Private (session, conversation, transcript, approvals, private files, automation, provider connection) | Owner only; task readers get D13 metadata | Owner only | None |
| Machine | POD-3955 (`see`) | POD-3955 (`use`, `manage`) | Manage and see by role |
| Per-user state | Self | Self | None |
| Instance settings and members | Members read what the UI needs | Admins | Instance administration |

**Mechanism.** Add the class as a fact on the authorization target. Make `authorize()` decide by class for humans. Remove the human `all` scope, so an admin is an ordinary member plus the admin actions above. Agents keep `subtree`/`none` for writes, intersected with their human's rights. They never gain anything on another human's private class.

**What happens to legacy grants.** Issue grants become inert history: kept, but no longer consulted for tasks. Session grants become inert for cross-person access. The share and unshare commands for issues return a clear "tasks are visible to all members" answer instead of writing grants.

**Change commands and feed together.** The feed's `mayReadIssue` and the command layer's `checkIssueAccess` change in the same task. The point is that the two never disagree about who may read a task.

### 4.2 Shared and private task data

The task row carries fields that belong to someone's private work. These include:
- coordinator and started-by session ids;
- the worktree path;
- the machine id the task is homed on;
- agent defaults chosen by a person;
- anything else that points into a session.

**Change.**
- Classify every field of the issue projection as shared or execution-private.
- Execution-private fields go only to the person whose session or machine they point at.
- Task readers get D13 session metadata through a session-summary projection: owner, title, live state.
- Apply the split everywhere the task is read: commands, feed, search, tree/graph, counts, exports and artifacts.
- This lands before the read widening in §4.1, so widening reads never exposes private fields.

### 4.3 Owner and assignee

**What exists.** `dev/mw` already has `issues.owner_user_id`, the canonical accountable human. It also has a separately writable `issues.assignee` (`packages/model/src/fields/issue.ts:126`), which is used by `store/issue-listings.ts` filters and counts, by claim, and by the CLI's `--assignee`.

**Change.**
- Present the owner as Assignee and retire independent `assignee` writes.
- Migrate the data: human member ids map to members. Agent labels and `me` keep only a legacy display label.
- `--assignee me` resolves to the authenticated human.
- Agent claim and seat attach never touch the owner.
- Reassignment writes an attributed event and notifies the old and new assignee.

### 4.4 Revisions, participation and personal records

- **Revisions.** Record description and brief revisions on top of the existing change-provenance machinery (`store/issue-revision.ts`). Restore creates a new revision.
- **Comments.** A comment carries its author, and only that author edits it. Admin moderation is audited.
- **Personal records.** Per-member start and join reasons, plus removable assignment rows, feed the sidebar. Collaborators are participation records with no access meaning.

### 4.5 Sync and clients

- The feed already evaluates per principal, so the work is changing the policy (§4.1), the field split (§4.2) and the remaining shared broadcasts (gap 6).
- A change of access goes through the existing authorization revision and `grant_audiences`, so a person who lost access is evicted without the source data being deleted.
- Signing out on a device closes its transports and never replays another member's outbox.
- What happens to a person's own unsent offline commands when their namespace is evicted is an offline-sync question, not a multi-user one. It is out of scope here (handover item 3).

### 4.6 Credentials

- Add an owner to provider connections.
- **Migration (decided 3 Nov 2026, Q2).** Assign existing rows to the custodian of the machine they were captured on where that is known. Otherwise assign them to the earliest admin, and say so in the upgrade notes. A one-member instance gets exactly today's behaviour.
- Spawn selects the initiating member's connection.
- Native harness logins found on a machine belong to that machine's custodian.
- Add the D11 checkbox and the transfer rules from the September addendum §4–5, limited to custody machines.

## 5. Decisions taken on this design (3 November 2026)

- **Q1, running on someone else's machine:** allowed, with the warnings in §2.4. A run uses only the runner's own connection, and the custodian's logins are never borrowed.
- **Q2, existing provider accounts on upgrade:** they go to the custodian of the source machine where known, otherwise to the earliest admin, with an upgrade note.
- **Dropped:** whether unsent offline commands survive namespace eviction. It is not a multi-user question. The multi-user rule, that one person's queued commands are never sent as another person, is MU-12.

## 6. Acceptance matrix

Each row is proved by a two-member test (Alice admin, Bob member, Carol disabled) on the fixture from POD-6282, written by the owning task. Rows marked UI also need a browser check. POD-6303 re-runs every row end to end.

| ID | Observation | Owner |
|---|---|---|
| MU-01 | A fresh one-member install and an upgraded one both act as an ordinary member. Open mode is local-only and ends once anyone has a password. | POD-6285 |
| MU-02 | Forged payload identity has no effect. Each transport resolves the caller's own member. | POD-6285 |
| MU-03 | An invite is consumed once under concurrency. Carol sees nothing and cannot sign in. The last admin cannot be removed or demoted. | POD-6298 |
| MU-04 | Alice's task appears for Bob under All users, in search, and in Bob's agent's discovery, with Alice as assignee. It does not appear in Bob's sidebar. | POD-6296 |
| MU-05 | Bob reads and edits Alice's task and its task artifacts on every path, without any grant. | POD-6288 |
| MU-06 | No path carries Alice's execution-private task fields to Bob. Bob sees only D13 metadata for Alice's sessions. | POD-6288 |
| MU-07 | Bob's agent on Alice's task belongs to Bob. Alice, and admin Alice, cannot read, drive, resume or approve it. Reassignment does not change that. | POD-6283 |
| MU-08 | Session file bytes, transcripts, conversation search, approvals and superagent session tools refuse a non-owner. | POD-6284 |
| MU-09 | Me / All users and Show agent tasks are filters. The sidebar and preferences stay personal. (UI) | POD-6294 |
| MU-10 | Task access never grants machine use. A `use` grant never grants session access. An unowned machine runs nothing. Admin custody is audited as a takeover. | POD-6286 |
| MU-11 | Disable, role change, sign-out and delegation end each evict or rescope live feeds and refuse queued work at dispatch. A reconnecting daemon is fenced. | POD-6293 |
| MU-12 | Switching account on web, desktop and phone shows nothing of the previous member and replays none of their outbox. (UI) | POD-6292 |
| MU-13 | Task dependencies across owners are visible. Counts, events, notifications and artifact previews leak no private fields, emails or machine paths. | POD-6291 |
| MU-14 | Removing a member releases custody with audit rows. Their history stays attributed. No other offboarding is exposed. | POD-6298 |
| MU-15 | Upgrading a real one-member database keeps ownership, preferences and sessions. Historical tasks become member-readable while sessions stay private. A matched backup and binary restore works. | POD-6302 |
| MU-16 | An automation is owner-only for read, edit, run and transfer. | POD-6284 |
| MU-17 | Concurrent edits and claims resolve by revision, with attributed events and no idempotency-result leak across members. | POD-6287 (claims), POD-6289 (edits) |
| MU-19 | Bob's edit to Alice's task is a revision attributed to Bob. Restore creates a new revision. Bob cannot edit Alice's comment. | POD-6289 |
| MU-21 | Bob's edit or mention on Alice's task cannot create or widen an effect under Alice's credentials. | POD-6286 |
| MU-24 | Reassignment by any active member notifies both people, and agents cannot reassign humans. Delete or status changes cannot stop another person's session. | POD-6287 |
| MU-26 | Alice's and Bob's provider connections, login attempts and quotas stay separate. A missing selection never falls through. | POD-6300 |
| MU-27 | The D11 checkbox installs only on the owner's custody machines. An existing different login on a machine is preserved. | POD-6301 |
| MU-28 | Bob's run on Alice's machine uses only Bob's connection, never Alice's logins; granting, accepting and sending show the shared-account warning; a missing connection fails clearly. | POD-6300 |
| MU-30 | After reassignment, existing runs keep their original scope and human. Approvals and usage stay with the run owner. | POD-6287 |

Rows dropped from the September matrix:
- **MU-18:** hosted, moves to PDM-494.
- **MU-20, MU-22, MU-23, MU-25 and MU-29:** covered by MU-04, MU-16, MU-06, MU-26 and MU-27 respectively, or deferred.

## 7. The filed tasks, checked against this design

| Task | Verdict | Main files |
|---|---|---|
| POD-6282 Two-member test fixture | Keep. | server test support, `store/users*.test.ts`, gateway test helpers |
| POD-6283 Private sessions | Keep. Covers gaps 2 (sessions part) and 3, plus the session half of §4.1's class policy. | `session-authz.ts`, `command-principal.ts`, `issue-authz.ts`, session commands |
| POD-6284 Private resource routes | Keep. Add automations and runs. | `file-asset-route.ts`, conversations search, `modules/superagent/tools.ts`, approvals, mail/inbox |
| POD-6285 Retired identity fallbacks | Keep. Covers gap 7 and the request-path half of gap 6 (`settingsViewer` and the session, superagent and messages paths). | the files in gap 6 except `broadcastViewer`, `feed-visibility.ts:278` |
| POD-6286 Daemon delegation checks | Keep. Covers gaps 8 and 9. | `gateway/machine-directory.ts`, session start, handoff, binding store |
| POD-6287 One accountable assignee | Keep. | `fields/issue.ts`, `store/issue-listings.ts`, claim, CLI and MCP |
| POD-6288 Shared and private task data | **Widen.** It owns §4.2 and the task half of §4.1 in **both** commands and feed (gap 1). The feed's task readability moves here from POD-6291. | `issue-authz.ts` (model and server), `feed-visibility.ts`, issue projection |
| POD-6289 Task edit history | Keep. | `store/issue-revision.ts`, comments |
| POD-6290 Personal task records | Keep. | issue user state, client-graph worklist |
| POD-6291 Member-scoped feed | **Narrow.** The remaining shared broadcasts, including `broadcastViewer`'s first-admin markers (gap 6), private-field bootstrap and eviction on access change, and notification channels per member (gap 10). | sync worker, Authority broadcast, `modules/issues/service/core.ts`, notifications |
| POD-6292 Account switch isolation | Keep. Outbox survival on eviction is out of scope. | `principal-storage.ts`, transports |
| POD-6293 Access change invalidation | Keep. | authorization revision, outbox dispatch, daemon fencing |
| POD-6294 Task filters and sidebar | Keep. | web task views |
| POD-6295 Shared task detail | Keep. | web task detail |
| POD-6296 Agent task discovery | Keep. Add the seat rule's "talks to its own human" (§2.3). | issue CLI and MCP, `service/seat.ts` |
| POD-6297 Mobile and desktop parity | Keep. | phone and desktop shells |
| POD-6298 Admission and member lifecycle | Keep, but much exists already: prove it with two members and fill gaps (recent authentication, last admin, recovery). | `member-routes.ts`, `store/users.ts`, `auth-route.ts` |
| POD-6299 Administration area | Keep. | settings UI, machines panel |
| POD-6300 Personal provider accounts | **Widen and move to Private by default** (credentials are private data that must be protected before a second person joins). It owns the owner column and migration for `accounts` (gap 5, Q2), and runs on another person's machine with their warnings (Q1). | `schema.ts` `accounts`, `apps/server/src/accounts.ts`, `modules/accounts`, spawn |
| POD-6301 Owned-machine credential propagation | Keep. | accounts, machine enrollment |
| POD-6302 / 6303 / 6304 Release | Keep. | upgrade fixtures, acceptance, notes |

**Order constraint.** POD-6288 must land after POD-6283 and POD-6284, which is already the case. Within POD-6288, the field split lands before read widening.

## 8. Sources

- PDM-107 artifact 20: re-assessment.
- PDM-107 artifact 19: POD-3955 handover.
- The September spec and addendum (podium-cloud `origin/issue/107-multi-user-architecture:docs/architecture/`).
- `docs/design/2026-09-16-machine-ownership-target-model.md`.
- `docs/adr/0003-command-security.md` with amendments.
- `docs/adr/0009-identity-ownership-sharing.md`.
