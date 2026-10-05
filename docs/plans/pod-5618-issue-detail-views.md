# Issue detail model computeds

Analysis and operator brief, 2026-10-05. No product changes.

Reviewed integration snapshot: `82de74b82fa5fae56599aba8e43023a49ec93c36`
(`integrate/4286-pilot`). Tasks-board comparison: `9fc5782b5616b4e8d650c1b08d7623fdfee68262`
on `issue/5555-bug-board-opening-latency`, read only. The issue-page and mission-view
implementations reviewed in the initial checkout are unchanged at this integration snapshot.

## Operator brief

Approve a detail-view refactor using the same direction as POD-5555 and the landed
POD-5575 mission models: one stable model per issue, independently cached questions,
and small observer sections and rows. The current page and panel observe one
assembled `IssuePageData`; opening either builds children, session rosters,
references, presence, and title together. Archived sessions of neighbouring issues
enter this assembly even when their history is not shown. The phone page repeats
the assembly, while the web phone inspector receives whole issue/session catalogs.

First separate panel identity and issue scalars from child, relation, present-session,
history, and activity questions. Then connect the web page/panel and phone
page/inspectors directly to those models; activate retired rosters and picker
catalogs only when shown. Use identity for models/results, scalar equality for
facts, and shallow ID equality for lists; remove rich structural comparisons and
render-time neighbourhood indexes from the migrated detail path.

Acceptance is bounded work at a fixed displayed neighbourhood, unchanged output
and navigation semantics, and an armed test against today's archived-reference
loop. Retire the two recorded `55→151` and `49→145` structural failures after the
replacement readers pass. Preserve own archived membership, continuation witnesses,
loading/eviction handling, close guards, and existing history access. Implementation
begins only after operator approval; this document does not claim new timings.

## What the code computes today

The page is already addressed by issue ID. This is not a fresh discovery of an
unconditional repository-wide scan on every page open. The remaining problem is
the breadth of each addressed result, its subscriptions, and eager hidden data.

| Surface or reader | Current answer and trigger | Remaining work and growth |
| --- | --- | --- |
| `createIssuePageViews.issue(id)` (`packages/client-graph/src/issue-page.ts:281`) | A copied full issue projection, text documents, prefix/ref, inverse dependencies, raw member IDs/summary, child IDs/counts, readiness and unread. | Reads the raw member roster before returning the issue, calls `missionView.issueMembers`, and reads every direct child's summary to count completed children. A title/body/read-cursor consumer therefore inherits membership and child work. |
| `data(id)` (`issue-page.ts:361`) | One `page:<id>` computed containing the issue, rich children, neighbourhood summaries/exits, combined sessions, members, relations, title, presence and target existence. | Loads each child's **full** issue projection, not just the child row's display facts. Traverses spin-off continuations, assembles related-session rosters, then walks every returned session for references and every reference/ancestor for summaries. Any changed input can replace the page result. |
| `panel(args)` (`issue-page.ts:467`) | Resolves explicit issue, then session attachment, then the maintained cwd winner; delegates to `data(id)`. | Resolution is already indexed and bounded. It still attaches the entire page answer. Its JSON key contains identity arguments, not selection/menu/fold state; do not treat it as the board's former screen-state key problem. |
| Web page (`pool-issue-page.tsx:13`, `IssuePage.tsx:73`, `issue-page-model.ts:82`) | One pool projection publishes `{data, views}` through context; the page passes issue/arrays to ordinary React sections. The page model combines fetched comments/events into a feed. | Module separation has not created independent MobX subscriptions. A new assembled context value propagates to its consumers; a parent render also executes ordinary child components. Page-level minute ticks and comment-editor state can rebuild presentation/feed work. |
| Web properties/header/child rows (`issue-page/IssueProperties.tsx:102`, `IssueDetailHeader.tsx:45`, `IssueSubIssues.tsx:118`, `issue-edges.tsx:104`) | Header finds its parent in the neighbourhood and derives phases across members. Properties derives moved-on sessions and picker options. Each edge resolver builds a neighbourhood `Map`. Sub-issues builds worker counts for all children from a combined session list. | These are neighbourhood scans, not necessarily whole-world scans. They repeat on broad context/prop changes. Both the desktop rail and the CSS-hidden phone Details subtree mount properties; closing `<details>` does not stop their subscriptions. |
| Web dock/explorer detail (`IssuePanelView.tsx:826`, `RightDockIssuePanel.tsx`, `explorer/IssueExplorer.tsx:95`) | Builds an issue map, partitions children, selects/sorts active and retired sessions, and derives each child's operational state from combined sessions. Fetches cost and recent activity. | Retired rows and completed children are folded by default, but their rich rows are already in `pooled`. Each open child calls `issueSessions` against the shared roster. The explorer frame uses this same panel; there is no separate web issue-detail side-sheet data engine in the inspected paths. |
| Phone page and native inspector (`screens/IssueScreen.tsx:180`, `client/use-issue-inputs.ts:19`, `app/inspect/[issueId].tsx`) | `readIssueInputs` assembles rich children, parent/edge summaries and exits, and attached sessions for the issue **and every child** in one hook. The page filters its own active sessions, builds an edge map, and distributes the arrays. Native `TaskSheet.native.tsx` routes to this page. | Attached sessions include archived rows even though the phone's ordinary roster filters them out. `[issue]` captures a replaced rich issue object, and any changed assembly input wakes the whole content component. The child/body/edge/session sections share this subscription. |
| Web phone inspector (`components/TaskSheet.tsx:82,198,342`) | `SheetHead` and `SheetBody` each build a map from supplied issues and filter supplied sessions; body derives children from the issue array. | The array parameters are catalogs from its callers, not addressed sheet inputs. `SessionConversation.tsx:245` enables whole issues/sessions while peeking; `SessionsScreen.tsx:38` already reads both catalogs; `MissionScreen` passes its mission arrays. Opening a peek from conversation is a concrete full-catalog demand. Keep callers' independently needed list data separate from sheet demand. |
| Target/close sheets and web pickers | Phone target choices use a declared repo/query/limit question; `IssueTargetSheet.tsx:80` renders ID rows through `FlatList`, and each row reads its own summary. `IssueCloseSheet` uses addressed close concerns. Web `useIssuePageCatalog(open)` gates catalog demand. | Preserve these existing good boundaries. Web parent/relations/labels/supersede options still enumerate rich summaries and build candidate maps/options once open; one `optionsOpen` can enable more catalog work than the particular chooser needs. |
| `issues`, `menuIssues`, `explorer` (`issue-page.ts:263,338,516`) | Catalog summaries; enriched child/member facts for every catalog issue; sorted `explorerSessions` summary roster. | Whole-query materialization belongs to an opened explorer/catalog, not ordinary detail. The fallback explorer uses it intentionally. Coordinate explorer-list changes with POD-5555 instead of hiding them in the detail rewrite. |

## Archived-history mechanism and evidence limits

The two reported counters are **distinct collection elements iterated**, not DOM
elements or React render counts. `packages/worklist-proto/harness/src/work-meter.ts:18`
counts array/set/map walks, spreads, sorts and structural comparisons, attributed
to the derivation performing the walk.

| Reported reader/action | 1× | 4× | Interpretation |
| --- | ---: | ---: | --- |
| `consumer:issue-page.detail/IssuePage@page:guard-root`, `select` | 55 | 151 | +96 elements |
| `consumer:issue-page.detail/IssuePage@page:guard-child`, `navigate-by-ref` | 49 | 145 | +96 elements |

These are the starting measurements supplied with this issue and the POD-5575
handoff, not measurements rerun for this document. The current fixture
(`pool-screen-work.ts:175`) creates `32 * scale` archived sessions attached to
`guard-root`: 32→128 is exactly +96. When reading the child, root is its neighbour.

The code supports that attribution:

1. `relatedSessions` (`issue-page.ts:132`) joins born sessions with
   `attachedSessions(owner)` for every neighbour, including archived sessions.
2. `data` (`issue-page.ts:412–452`) walks all joined sessions to add `issueId` and
   `refIssueId` references, then reads their issue summaries and parent chains.
3. `pagePresence` (`issue-page.ts:150`) separately reads `attachedSessions(owner)`
   to populate `index.byIssue`, despite already having each owner's present seats
   and only using the existing mission reader for the origin's moved witness.
4. `issue(id)` asks for rich raw member rows even when the caller only needs issue
   scalars. Rich children consequently pull another tier's member and child facts.

Do not solve this by dropping all archived sessions. `pageSessions` explicitly
includes raw archived/headless/resume-twin members and excludes shells; the full
web page currently renders that member roster, including own archived members.
`missionSessions` uses explicit ownership and the existing visual-collapse rules;
`bornSessions` records creation independently of current attachment. Reusing one
list for all three changes behavior. Presence also needs archived moved/newest
witnesses for some continuation states.

POD-5575 supplies useful `present(id)`, `history(id)`, `issueMembers(id)`, `moved(id)`
and roster accessors in `mission-view.ts:563–583,708–772,834`. History keeps scalar
counts and winner IDs apart from live seats. **Its first observed aggregate can
still walk archived IDs/facts.** Reuse it rather than rebuilding history in page
assembly, but measure cold initialization separately from an already observed
heartbeat/revisit. Merely renaming a historical list as a computed is not a proof
that first-open work is flat.

At the reviewed SHA, `screen-work.expected-failures.json` still lists older detail
exceptions under **POD-5453**; it does not contain a POD-5618 entry for the two
reported action/counter pairs. `declared-query-work.test.ts:407–410` explicitly
selects those pairs for judgment. Reconcile the pending POD-5575 handoff before
editing exceptions; remove exactly the repaired allowance wherever it lands, and
do not delete other owners' exceptions or use the ownership mismatch as a waiver.

## MobX model and observer shape

Use a pool-owned lookup returning a stable `IssueDetailModel` for one issue ID.
Its getters use `cachedGroup`/`keyedComputed` from the established helpers and have
observation-scoped lifetimes. Constructors must not allocate every computed or
hydrate every child/session. Models borrow the existing graph, source rows,
queries and mission facts; they do not introduce a new feed, reverse index or
reaction-maintained cache.

| Model question | Inputs and consumers |
| --- | --- |
| Identity and scalar display | Addressed issue/repo fields: existence, ref, title, stage, archive/deletion, colour, readiness and document values. Header, body, banners, controls and git sections read just their own getters. Scalar computeds absorb immutable source-row replacement before unrelated sections are notified. |
| Children and progress | Direct `treeChildren` IDs in seq order, with archived children retained and deleted children excluded. Per-child scalar finished/running contributions; parent counts depend on these contributions. The list observer reads IDs; each child observer reads that child's title/state/workers. Do not resolve each child through the full rich `issue()` answer. |
| Relations and breadcrumbs | Own edge IDs/types plus incoming edge facts; parent/superseding/canonical IDs separately. Each edge observer resolves only its target and, if absent, its addressed `issueExit`. Ancestor traversal belongs to the breadcrumb that needs it, not every page reference. |
| Present crew and naming | Preserve surface-specific raw-member versus collapsed/explicit-attachment contracts. Separate the live ordered IDs, member counts, working/waiting flags, draft-title winner and moved-on IDs. A session row observer reads one session. Reuse existing motion/working predicates and deadline clock; no minute value in a model key. |
| History and continuation | Counts and selected archived witness IDs use existing mission history where semantics match. Resolve only a witness needed for displayed presence. Full retired row IDs/payloads are demanded by the opened retired roster. Continuation traversal is a separate issue question over declared spin-offs, with cycle handling and current tie/order rules preserved. |
| Close and destination | Keep `closeFacts(id)` and maintained cwd/session resolution as addressed scalar/count questions. Resolve a panel's identity before obtaining the model. A close guard or “open in work” trigger should not hydrate the full page merely to establish eligibility. |
| Activity and cost | Their existing issue-scoped RPC/state stays with its consuming section. Compute a feed when comments/events change, not on composer input, timer ticks, or unrelated roster updates. Cost accounting keeps its existing all-history semantics and is not derived by dropping retired sessions. |

The root provides stable pool/model identity plus navigation/command ports, not a
changing `{data: IssuePageData}` snapshot. Small `observer` components dereference
their getters while rendering. Pass IDs or stable models to child/session/edge
rows, not rich plain records and neighbouring arrays. Put title/description
editing, comment drafts, completed/retired folds, and picker state in their owning
components; preserve a shared dialog/busy controller where actions actually span
sections. Both CSS-hidden duplicate properties trees and closed Details content
must avoid data work; reveal mounts/activates the appropriate observers.

Identity is the normal equality contract. ID-only arrays may use explicit shallow
ID/order equality. Do not compare documents, rich issue/session records or page
graphs recursively to suppress notification. In particular:

- `issue-page.ts:52` currently gives `issue`, `summary`, presence and close answers
  structural equality. `data` and `panel` already use the **identity** cache; the
  problem there is assembly breadth, not a page-result deep comparator.
- `roster` uses `createQueryResult`; its row refresh (`query-result.ts:493`) deeply
  compares `{order,value}` for each copied session. It is a per-row comparison,
  not a comparison of the whole roster. The replacement detail roster should
  observe membership IDs and individual session models instead of rich payload
  query results. Do not rewrite generic query infrastructure for this issue.
- `createPoolProjection`/the host currently use `Object.is` by default. Preserve
  that fixed bridge; do not reintroduce deep equality there to support new plain
  object results. Shared comparison cleanup beyond detail belongs to POD-5424.

## Implementation sequence after approval

These are proposed implementation steps, not newly claimed work or product edits.

1. **Establish the detail counter contract.** Add focused model/render probes using
   the actual product readers, with equal issue text and displayed IDs at 1×/4×.
   Separate cold model/history initialization, warm revisit, and one-row deltas.
   Arm the archived-reference guard against today's `data()` loop; also plant a
   rich-catalog/whole-roster read that keeps the same output and must fail. Update
   the structural harness to measure migrated sections and real phone inputs;
   its current “IssueScreen” label invokes web `panel()`, not `readIssueInputs`.
2. **Add independent per-issue questions and panel identity.** Implement the model
   table above using existing relations and mission history. Split scalar issue
   access from own member/history hydration; remove neighbour history from live
   reference/presence construction. Keep a temporary compatibility adapter only
   for consumers still migrating; no permanent replacement mega-computed.
3. **Migrate the web page and dock.** Replace assembled context consumption with
   stable identity and observer sections/rows. Move feed and editor/timer state to
   their consumers. Read retired/completed payloads when the fold opens; replace
   neighbourhood maps with addressed edge reads. Preserve explicit issue/session/
   cwd fallback, explorer trail behavior, shared row close dialog, and eviction.
4. **Migrate phone page and inspectors.** Replace `readIssueInputs` with the same
   model questions. Make web `TaskSheet` accept issue identity and navigation ports;
   remove its whole-world array dependency and the peek-only catalog reads in
   callers. Retain native `/inspect/:id` routing, artifact modal layering, and the
   bounded target `FlatList`. Move property chooser demand into the shown sheet/
   submenu; keep label and target eligibility semantics.
5. **Remove adapters and record proof.** Delete unused `IssuePageData` aggregation,
   rich roster comparisons and edge-map helpers from migrated detail consumers.
   Retire the exact fixed structural exceptions; preserve diagnostic parity
   comparisons outside the production read path. Record counter output and one
   matched first/repeated-open comparison at 1×/4× if performance acceptance is
   requested for implementation. No timing target is invented from structural
   counts alone.

## Acceptance counters and semantic checks

Let `V` be mounted child/session/reference rows, `E` displayed relation edges,
`A` required breadcrumb/continuation ancestry, and `H` undisplayed archived rows.
At fixed `V`, `E`, `A`, changes to total repository size or unrelated/neighbour
`H` must not increase detail presentation work. Iterating the IDs of a list that
is actually displayed is legitimate; materializing its hidden rich rows is not.

| Probe | Required result |
| --- | --- |
| Known `guard-root/select` and `guard-child/navigate-by-ref` cases | Remove the +96 page-assembly archive contribution. Replacement detail readers must meet the existing neighbourhood ratio independently for rows, derivations and elements. Record exact new values; do not require the old totals 55/49 or “pass” by dropping reader instrumentation. |
| Fixed detail with 1×/4× unrelated issues and archived neighbour sessions | No unrelated issue/session payload loads; mounted presentation work is bounded by `V + E + A`. Include incoming parents/dependencies with large archived rosters, not just unrelated issues as the existing bounded-read test does. |
| Local edit, menu trigger, read marker or minute tick | Typing a draft reruns its editor, not roster/child/history/feed derivations. A closed chooser reads zero catalog rows. A timer only wakes age/timing/working facts it can change. Unchanged scalar values stop downstream propagation. |
| One session heartbeat | Recompute the changed session and its issue's relevant live state/order/counts. Zero neighbour-history payload walks, zero unchanged child/edge/body renders. Archived aggregates whose inputs did not change must not execute. |
| Child title or stage update | Title: one child row, with no parent count recomputation. Stage: that row and applicable parent progress/fold membership. Sibling rich projections, session rosters and relation targets do not rebuild. |
| Retired/completed fold and own history | Closed retired fold loads no retired row payloads for rendering. Opening it preserves all retired entries and order. The page's own raw archived membership/counts remain correct. If a long visible roster needs bounding, use the established virtual-list behavior while keeping all rows reachable; changing default archive visibility requires a separate operator decision. |
| Property target sheet | Closed: zero catalog demand. Open: matching IDs from the declared question, payload reads only for mounted target rows; one target title update leaves other target rows unchanged. Candidate-ID search cost is reported separately from payload/render work. |
| Load, switch, unshare and unmount | `LOADING` stays distinct from absent/deleted; late edge data does not blank unrelated sections. Reset issue-local edits on switch, dismiss an observed evicted issue once, release model computed/roster/chooser observations on close and principal change. |

Keep existing parity and behavior coverage for archived children, raw headless/
resume-twin membership, moved sessions and multi-hop continuations, draft naming,
coordinator ordering, opaque/pending/deleted references, close eligibility,
artifact opening, event/mail semantics, and panel navigation. Existing useful
locations include `client-graph/src/issue-page.test.ts`, web
`IssuePage.pool-parity.test.tsx`, `IssuePanelView.inspector.test.tsx`, issue-page
edge/payload-identity/switch tests, and mobile target/artifact/close-sheet tests.

Implementation validation follows `docs/agents/testing.md`: choose the focused
files that cover the changed questions, use the existing structural lane for the
scale contract, and collect runtime evidence only for a changed interaction
boundary or the explicitly requested performance capture. Do not run broad suites
or browser-drive this analysis. This document was checked against code and issue
handoffs; no tests/build/timing capture were run because it changes no runtime.

## Ownership and approval

POD-5555 owns the Tasks board and explorer materialization; POD-5561 owns shared
title/reference search; POD-5575 owns mission models and history semantics;
POD-5424 owns generic comparison/sidebar cleanup; POD-5620 owns broad engine
publication work. Coordinate changes to their shared files and APIs before
implementation. This proposal keeps the existing pool, declared queries and
source ownership. It does not require a new indexing or transport architecture.

The operator decision is approval of this model/observer scope and sequence.
Analysis is complete; implementation remains unstarted.
