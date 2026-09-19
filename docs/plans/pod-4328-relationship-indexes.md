# Incremental relationship indexes

E2 adds infrastructure to the existing opt-in presentation model. No consumer,
default, or runtime flag changes, and no library is added.

## Read contract

`model.relationship(kind, id, type?)` returns a shared read cell containing a
frozen, lexically sorted set of IDs. It does not promise legacy slice ordering;
consumers apply their domain ordering and read current content through row cells.

| Kind | Members |
| --- | --- |
| `sessionsByIssue` | Visible sessions matching explicit attachment or longest-root cwd fallback; archived/headless excluded, shells included |
| `attachedSessionsByIssue` | Explicitly attached visible sessions, including archived/headless, for mission rules |
| `sessionsByWorktree` | Longest-root membership, archived/headless excluded |
| `childrenByParent` | Visible formal children, archived/deleted children excluded |
| `issuesByRepository` | Visible issues referencing a visible replica repository ID |
| `dependentsByIssue` | Legacy dependent issue IDs, keyed by target ID and dependency type |
| `dependencyEdgesByIssue` | Normalized edge IDs, keyed by target ID and dependency type |

Dependency readers must supply the edge type; these are typed buckets, not an
untyped union. Normalized issue own-fields take precedence over a simultaneously
present legacy wire; normalized edges remain separately addressed rows. Both
endpoints must be visible before an edge or parent relationship is exposed.
No issue/session object is synthesized for an inaccessible reference.

Session membership inputs are only ID, issue ID, cwd, archived and headless.
Content, status and agent kind do not rebuild membership. The ownership predicate
is shared with `session-ownership.ts`; formal child eligibility is shared with
`mission.ts`. Shell filtering remains a consumer policy, not an index policy.

Private reverse candidates retain references to missing endpoints. Creating,
evicting, removing or readmitting an endpoint revisits those candidates only.
Empty read cells remain subscribable. Scope replacement clears candidates,
buckets and explicitly supplied roots before rebuilding from the new visible
rows. Stop/start reseeds, and destroy clears held values and subscriptions.

## Root input boundary

Issue worktree paths are indexed directly. Host-discovered roots do not exist in
the effective-change feed: `EngineState.repos` is host discovery, whereas the
replica `repos` kind is logical repository identity. Future adapters can provide
explicit root additions/removals through
`adapter.updateWorktreePaths(added, removed)`. No adapter is installed by E2.
Callers must resend their visible roots after replacement/restart; roots from a
previous principal must not survive a rescope.

Root spelling and longest-match semantics reuse the model's root helpers.
Reference counts retain shared issue/host roots. An ancestor-to-session candidate
index includes unmatched cwds so later root admission works without a session
scan. A root delta revisits sessions under that path, including sessions whose
nearest root changes. Root changes legitimately affect an entire subtree.

## Cost and evidence

This is addressed incremental maintenance, **not an O(collection) lazy index**.
Seeds/replacements enumerate collections. Ordinary deltas visit addressed rows,
path ancestors, and affected incoming/outgoing buckets only. Reading a changed
bucket materializes and sorts that bucket, never the collection. Session-content
updates compare a fixed membership input tuple and perform no membership work.

The focused A/B test invokes the real legacy `indexMissionSessions` through a
counting iterator. Its assertion that membership visits equal zero deliberately
fails for the legacy arm. Both arms assert the same memberships on every update
and read the updated session content once per update. Delta views throw if any
consumer asks to enumerate a collection.

| 1,000 sessions × 100 content updates | Legacy | Incremental |
| --- | ---: | ---: |
| Membership row visits/evaluations after seed | 100,000 | 0 |
| Incremental bucket writes after seed | — | 0 |
| Current-content reads | 100 | 100 |
| Membership results | Equal | Equal |

A separate move assertion proves one session evaluation and four bucket writes:
remove/add in the navigation and explicit-attachment buckets. An unrelated
bucket retains its snapshot identity. Root admission evaluates only the one
session under the changed root in its fixture. Reparenting/dependency edits
perform one issue evaluation and zero session evaluations.

Validation on 2026-09-19:

- `bun run typecheck -- --filter @podium/client-core`: seven successful tasks,
  six dependency cache hits.
- One `bun run test:file --` invocation naming `presentation/relationships.test.ts`,
  `presentation/model.test.ts`, `engine/runtime.test.ts`, `viewmodels/mission.test.ts`,
  `viewmodels/session-ownership.membership-index.test.ts`, and
  `viewmodels/session-ownership.partial-world.test.ts` under
  `packages/client-core/src`: **478 tests passed in six files**. This includes
  the existing D6 differential/lifecycle gate and nine new relationship tests.
  This is focused evidence, not the full suite or lean gate.

## Disable and revert

The existing `init.presentationModel` opt-in remains the activation boundary;
omitting/disabling it prevents construction of the presentation model and its
indexes. E2 introduces no production consumer. Revert the E2 commit to remove
this infrastructure; no data migration or persistent-state cleanup is needed.
The next consumer migration is a separate decision owned by E1.
