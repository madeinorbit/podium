# Multi-user instance: release and upgrade notes

**Draft / unreleased.** These notes describe the reviewed candidate. Full release
acceptance remains blocked on native desktop and phone account-switching proof
(MU-12, POD-6458 / POD-6459). POD-6304 still waits for POD-6303 and user review.
The self-hosted release comes first; hosted Podium follows afterwards.

## Before inviting another person

**Every active member can read every current and historical task and its task
artifacts, including tasks created by agents.** There is no private-task option;
old task-sharing grants no longer restrict access. Review existing task content
and attachments before admitting someone. Session files remain private through
Podium's session controls.

Any active member can edit ordinary task content and properties and comment.
Delete, restore, shipping and gated stage changes retain their existing command
requirements. Editing a task does not grant permission to stop another person's
sessions or act under their credentials.

## Assignment, history and your sidebar

Each task has one accountable human, shown as **Assignee**. Any active member can
reassign it to another active member; both people are notified. Agents cannot
change the human assignee. The creator is recorded separately and never changes.
Old agent names and other free-text assignee labels survive without authority;
`--assignee me` refers to the signed-in person.

Collaborators are people who explicitly joined or started work on a task. That
record grants no additional access. Your sidebar contains your started or joined
tasks and removable “assigned to you by” entries. Searching for or opening someone
else's task does not add it. **Me**, **All users** and **Show agent tasks** filter task
views; they do not change access or anyone else's sidebar. Preferences stay
personal.

Description and brief edits have attributed revisions; restoring one creates a
new revision. Only a comment's author can edit it. Admin moderation is audited
and preserves the original author.

## Sessions, accounts and spending

A session belongs to the person who started it, including when their agent starts
it on their behalf. Starting an agent on someone else's task keeps the session
yours. Other task readers see only its owner, title and live/idle state. Only the
session owner can read its conversation, transcript or files, drive or resume it,
answer its questions, approve actions or click its offers. Admins and the task's
assignee gain no extra session access. Old cross-person session grants have no
effect. Automations also remain private to their owner.

Provider connections, login attempts and quota history are personal. A run must
select its initiating person's usable connection: a missing or someone else's
selection fails, without borrowing an admin's or machine custodian's login.
Reassignment leaves existing runs, approvals, credentials and spending with the
original person.

Task cost totals, rollups, model totals and comparisons are shared with the task.
Session cost lines, personal hourly usage and quota history stay with the run
owner, including after reassignment. There is no new admin view of everyone's
personal usage or per-person concurrency limit.

## Invitations and administration

An admin creates an expiring, single-use invitation link and shares it with the
intended person, who accepts it to establish their own sign-in. A link may be
restricted to an email address. Admission is invitation-only; open registration
and a viewer role are not included.

Admins manage members, invitations, roles, access settings, machines, instance
settings and security audit events. This role gives no access to another
person's sessions, private files, automations or provider credentials through
Podium. The last active admin cannot be removed or demoted. Disabled members
cannot sign in or act; their history stays attributed. Removal releases their
machine custody with an audit record, without transferring their private data or
automations to someone else.

Open mode works only locally on the server, with exactly one active member and
when existing password/login settings allow it. Adding or enabling a second active
member ends it, even if login was turned off. Disabling that member can restore
open mode only when the other conditions also hold.

## Machines and the shared-account warning

A machine has a custodian; permission to **use** it is separate. Task access grants
no machine use, and machine use grants no access to another person's sessions.
Admins can see and manage machines, but must receive use permission or take
custody before running there. Taking custody is an audited takeover. An unowned
machine runs nothing until an admin adopts it.

**People sharing a machine run agents under the same operating-system account.
Either person's agents can read the other's files and installed credentials
there.** Podium warns when use is granted, before the recipient's first run and
when a connection is sent. Podium's session and account permissions do not provide
OS-account isolation. A run on someone else's machine requires your own explicitly
sent connection and fails if it cannot be used without replacing their login.

A task still has one worktree on one machine. Use that machine only with
permission; otherwise contribute through your own subtask and worktree.

## Provider accounts on upgrade

- **Existing managed accounts** (API keys and setup tokens) become the earliest
  active admin's. Those records contain no source-machine provenance, so none can
  be assigned by source-machine custody. Other members connect their own
  accounts. On a one-member instance the accounts remain that person's.
- **Native CLI logins** belong to the custodian of the machine where they are
  observed, including after upgrade. A use grant does not make that login yours.
- **Automatic copying of supported native logins** has a “use on all machines I
  hold custody of, now and in future” checkbox (D11). Fresh installations and newly observed logins
  start unticked. Upgrade ticks eligible, identified logins already observed on
  custody machines for their custodians, preserving prior copying behavior.
  Review these choices after upgrade. Copying reaches only your custody machines,
  including future ones, never machines you merely have permission to use.
- **Upgrade both source and destination daemons before copying.** Older daemons
  cannot enforce the selected-account and installed-identity checks. D11 copying
  refuses incompatible peers with upgrade guidance. With compatible daemons it
  checks the source account and preserves a different or unknown installed
  identity, including an expired different login. Credentials for the same
  identity can still be refreshed. Unticking stops future copies; it does not
  recall or remove credentials already installed.

## Backup and rollback

Before upgrading, keep a consistent pre-upgrade database backup and the previous
binary that can open it. Preserve external configuration, machine identity files,
agent homes, credentials and transcripts separately where needed. See
[data, upgrades and backups](../data-and-upgrades.md).

To roll back across these migrations, stop Podium, restore the **matching database
backup and previous binary**, remove stale `podium.db-wal` / `podium.db-shm`
sidecars, then start that binary. Running an older binary against the migrated
database can refuse startup. Restoring the backup discards database writes made
since it was taken. See the [snapshot restore
instructions](../data-and-upgrades.md#snapshots-before-update-migrations).

The accepted rehearsal proved database upgrades and a matched database-only
backup/binary restore. It did not restore external configuration, identity-file
credentials, agent-home files or transcripts. Full external-state recovery still
needs its own verification.

## Draft review note

Source: the [current design](../design/multi-user-instance.md), POD-6303's
`two-member-acceptance-report.md` and `candidate-design.md`, and the accepted
POD-6302 / PDM-107 `upgrade-rollback-report.md`.

Server, browser and independent-daemon evidence exists. Browser account switching
passed in Chromium and Expo web; two separately enrolled daemon processes proved
the named file/git boundaries. These observations do not prove native desktop
cookies/storage/sidecar behavior or native phone storage and queued-write
suppression. **Native MU-12 remains required and unproved under POD-6458 /
POD-6459, without waiver.**

The reviewed checkpoint is `a679e6d1789c0574ed9b9b51aa034f5c9afb4eb5`.
Its production runtime matches repair baseline `547da65fa3`; the report keeps
the earlier server/browser/upgrade evidence separate from checkpoint fixture
and lean-gate checks. No complete baseline or full-suite pass is claimed. The
retired color assertion, Sidebar tally, three mobile assertions/snapshot,
WorkScreen resource limit and broad wire drift/reporter obstruction remain explicitly unpassed or
unproved. Selected-source substitution diagnostics do not establish complete
baseline attribution or exclude regressions. Real provider execution and full
external-state restoration were not proved.
