## Issue-tracker schema research for Podium (read-only, sources as of 2026-10-13)

Where possible I read primary schemas directly: Linear's SDK `schema.graphql`, Plane's Django models (`makeplane/plane`, `apps/api/plane/db/models/`), Asana's OpenAPI spec (`Asana/openapi`) and the octokit GitHub GraphQL schema. The rest comes from vendor docs. Jira and GitLab details lean partly on community threads and GitLab tracker issues; I mark those below.

### 1. Hierarchy
- **GitLab work items: one table plus a rules table.** Every type lives in the `issues` table (`WorkItems::WorkItem` sets `table_name = 'issues'`). Parent and child are stored as `work_item_parent_links` rows. Allowed pairs were kept in `work_item_hierarchy_restrictions` (parent type, child type, `maximum_depth`, `cross_hierarchy_enabled`). Since 18.1 the types and rules live in code under `types_framework/system_defined/definitions/`. The rules:
  - an epic can parent epics or issues, and an issue can parent tasks;
  - an epic's child list can't mix issues and child epics;
  - an item has at most one parent;
  - epics nest 7 levels deep and OKRs 9 (the depth figures come from a GitLab tracker issue, not the docs);
  - an item can have at most 5,000 direct children.

  A bug report on that rules table is a warning sign: stray Ticket rows made `allowedParentTypes` wrong. A rules table needs a seed and a check.
- **GitHub: one tree, no type rules.** `Issue.parent` plus `subIssues`. Limits are 100 sub-issues per parent and 8 levels, and sub-issues can come from other repos. Issue types are defined per organisation (up to 25, defaults task/bug/feature) and do not constrain which type can parent which.
- **Jira: numeric type levels.** `hierarchyLevel` is -1 for subtask, 0 for base types (story/task/bug) and 1 for epic. Premium adds levels 2 and up. No level can be inserted between 0 and 1. A child must sit one level below its parent.
- **Linear: an untyped tree.** `Issue.parent` with no type constraints. Projects and initiatives above it are separate entities, not issue types.
- **Plane:** `Issue.parent` FK, plus a workspace `IssueType` with `is_epic` and `level` (a float).
- **YouTrack:** the parent/child link is just one link type, "Subtask" (`aggregation: true`, "parent for" / "subtask of"), stored next to the other links.

Pattern: store the tree as a `parent_id` FK (or a single link table). Allowed shapes come from rules keyed on type, enforced on write together with depth and cycle checks. GitHub and Linear run with no type rules at all.

### 2. Type, kind and category axes
- Mature tools separate three axes:
  - **structural level:** Jira `hierarchyLevel`, Plane `is_epic`/`level`, GitLab type definitions;
  - **nature of work:** GitHub issue types (bug/feature/task), Jira base-level types;
  - **free tags:** labels.
- Linear has no issue type at all. Nature of work is a label, often inside a label group (`IssueLabel.isGroup`: "acts as a container for child labels and cannot be directly applied").
- Asana keeps behaviour separate from type. `resource_subtype` (`default_task | milestone | approval | custom`) changes behaviour: a milestone "represents a single moment in time… cannot have a start_date". `custom_type` and `custom_type_status_option` carry the user's own type and status.
- **Anti-pattern: one enum carrying both structure and nature.** Jira used to model "Epic" both as an issue type and through a special `Epic Link` custom field, alongside the Advanced Roadmaps `Parent Link` field. Atlassian had to deprecate both in favour of a single `parent` field (removal slipped to about September 2025). The webhooks gained `IssueParentAssociation` changelog items, and cross-project parents broke for a while.

### 3. Grouping: separate entity, membership field, or tree
- Grouping is almost always a separate entity referenced from the issue, not an issue type:
  - **Linear:** `Issue.project`, `Issue.cycle` and `Issue.projectMilestone`. A milestone belongs to a project and has its own `sortOrder`, `targetDate`, `progress` and `status`.
  - **Plane:** cycles and modules are join tables (`CycleIssue`, with one live cycle per issue).
  - **Asana:** sections are "a subdivision of a project… a header above a list of tasks… or a column in a board". A task's `memberships[]` holds `{project, section}`, and a task can be in several projects.
  - **GitLab:** milestones and iterations are widgets, i.e. fields.
- **The closest match to Podium's planned "phase" marker:** Asana's `is_rendered_as_separator`. Subtasks "can appear similar to sections without being true section objects". The flag is read-only and only applies to a `default_task`.
- **Do sub-issues inherit grouping?** Copying usually happens once, at creation:
  - **Linear:** sub-issues copy the parent's team and project when created. They copy the cycle only if created in an active status, and never copy labels.
  - **Asana:** exposes `effective_memberships`, "the union of direct and inherited memberships", where a direct membership wins.
  - **GitLab:** moving a parent moves its children with it.

### 4. Ordering
- Linear stores several per-scope float ranks:
  - `sortOrder: Float!` ("in relation to other items in the organization");
  - `prioritySortOrder` (order within a priority);
  - `subIssueSortOrder` ("only set if the issue has a parent");
  - `WorkflowState.position`, ordered "within their type group".
- Plane: `sort_order FloatField(default=65535)`. GitLab issues use `relative_position`, an integer.
- Jira uses LexoRank strings in buckets. A rebalance is scheduled at 128 characters, runs immediately at 160, and writes are blocked at 254 (Data Center docs).
- Lesson: keep one rank per ordering scope (global, within parent, within column), not one overloaded key. Float ranks need a renumbering job; string fractional indexing (LexoRank, Figma-style) needs a length cap and a rebalance.

### 5. Dependencies and relations
- **Linear:** `IssueRelation {issue, relatedIssue, type}` with the closed enum `IssueRelationType {blocks, duplicate, related, similar}`. Only the forward verb "blocks" is stored; "blocked by" is the reverse view.
- **Plane:** `issue_relations(issue, related_issue, relation_type)` with explicit pairs: `blocked_by/blocking`, `relates_to` (symmetric), `duplicate` (symmetric), `start_before/start_after`, `finish_before/finish_after`, `implemented_by/implements`. Only one direction is stored and a reverse map derives the other. A unique constraint on `(issue, related_issue)` while not deleted allows one relation per pair. Its older `IssueBlocker(block, blocked_by)` table shows they migrated off a dedicated table.
- **GitHub:** `blockedBy`/`blocking`, generally available August 2025, up to 50 per relationship type.
- **Shortcut:** links are subject–verb–object, with verbs `blocks | duplicates | relates to`.
- **YouTrack:** link types are admin-defined with `sourceToTarget`/`targetToSource` names plus `directed` and `aggregation` flags.
- **Jira:** issue link types have inward/outward names.
- Consensus: a closed or admin-registered set of types, each with a direction and a reverse name, stored once in canonical direction, deduplicated per pair. Cycle checks matter for "blocks" and for parent links (GitLab MR "Validate parent and child depth and cyclic references"). No tool I found lets the relation type be a free string.

### 6. Status and workflow
- Custom statuses map onto a small fixed set of categories, and behaviour is keyed on the category:
  - **Jira:** `statusCategory.key ∈ {new, indeterminate, done}` (plus a legacy `undefined`); match on `key`, not id.
  - **Linear:** `WorkflowState.type ∈ {triage, backlog, unstarted, started, completed, canceled, duplicate}`, with `startedAt`, `completedAt` and `canceledAt` stamped when the issue enters each category.
  - **Plane:** `StateGroup ∈ {backlog, unstarted, started, completed, cancelled, triage}`.
- **Parent status is not derived; it is automated.** Linear has team-level `autoCloseParentIssues` ("when all child issues are closed") and `autoCloseChildIssues`.
- **Progress counts:**
  - GitHub `subIssuesSummary {total, completed, percentCompleted}` ("an issue's sub-issues"; the schema text doesn't say whether that is direct children or all descendants).
  - GitLab counts descendants and their total weight, and task progress rolls up through its parent issue.
  - Linear project progress uses estimate points (1 point each when a team has no estimates), counts in-progress issues at 1/4 weight, and canceling issues shrinks scope.
  - Structure for Jira: a resolved parent counts 100% whatever its children; unestimated children are either averaged or excluded.

### 7. Custom fields vs. first-class columns
- Fields become real columns when the system's behaviour depends on them: state, parent, priority (Linear `priority` 0–4 plus `prioritySortOrder`), estimate, dates, cycle, milestone. Asana makes the same point by putting behaviour in `resource_subtype` and user taxonomy in `custom_fields`/`custom_type`.
- GitLab's widget model turns this into composition: one shared pool of widgets, each type enabling a subset, so changing a type changes which widgets apply.
- Jira's Epic Link shows what goes wrong otherwise: a structural relationship stored as a custom field had to be pulled out into a real field later, at great cost.

### 8. Migration lessons
- **Jira, Epic Link / Parent Link to `parent`:** the old fields were kept readable for years, the removal date slipped, webhook consumers had to migrate by hand, and cross-project parents regressed.
- **GitHub, tasklist blocks to sub-issues:** retired 30 April 2025. Hierarchy kept as markdown in the body did not last; GitHub added a tool to convert checklist items into sub-issues. Ordinary markdown task lists still exist, which caused naming confusion.
- **GitLab, epics to work items:**
  - Every epic got a backing `issues` row.
  - `epic_issues` and `epics.parent_id` were backfilled into `work_item_parent_links`, with two-way sync between the old and new tables.
  - This produced years of repair work: re-sync migrations (MR 172071), stale links for moved issues, about 225 missing rows fixed by idempotent `ON CONFLICT DO NOTHING` backfills.
  - Only now is GitLab removing the two-way sync and writing only through work items. The separate list pages were replaced by one Work items list in 18.10, and old URLs redirect.

  The lesson: dual-write between two hierarchy models is the expensive part, so cut over to a single writer as soon as possible.

### Implications for Podium
1. **Split `issues.type`.** Use a structural axis (`kind`: epic | task, possibly milestone) whose values carry behaviour, plus a separate nature axis (bug/feature/chore) or labels. Only behaviour-bearing values belong in the enum, as with Asana's `resource_subtype`. Mixing the two is exactly the Jira epic anti-pattern.
2. **Hierarchy rules.** Keep the `parent_id` tree, and add a small allowed-pairs table in code (GitLab style) with depth and cycle checks on write. Expose `allowedChildKinds` so the UI and agents can't build invalid shapes.
3. **The "phase" marker.** As a type with no behaviour it repeats Asana's `is_rendered_as_separator`: a display flag that can't carry dates, progress or membership. Since milestone and phase are groupings, prior art says make them an entity (Linear `ProjectMilestone`, with `sortOrder`, `targetDate`, `progress`) referenced by a `milestone_id`/`phase_id` field, with children copying it once at creation, as Linear does for project and cycle. If it stays a marker row, it must be excluded from progress counts and dependency targets.
4. **`issue_deps.type`.** Move from a free string to a closed, registered set, each with a canonical direction and reverse name (Plane's pair table). Add a unique `(from, to)` constraint and cycle detection for `blocks`. Keep parent/child out of this table.
5. **Stages.** Add a fixed category per stage (Linear-style `type`: backlog/unstarted/started/completed/canceled). Policy such as "is it done", auto-close and progress should read the category, so stages can be renamed or added safely. Stamp `started_at`/`completed_at` when an issue enters a category. Podium currently has no canceled stage; every tool surveyed has one, and progress counting depends on it.
6. **Progress.** Decide and document one rule. Recommended: count leaves, exclude canceled items, optionally weight by estimate, and auto-close the parent as an opt-in automation rather than a derived status.
7. **`sort_key`.** Keep one per scope, e.g. a global rank plus a rank within the parent (Linear's `subIssueSortOrder`), and plan a rebalance job.
8. **The planned task `role` (research/design/build/review/qa/security).** It drives agent behaviour, so make it a first-class column with a closed enum, not a label. Keep it separate from both type axes.

### Uncertainty
- Jira's level details come from community threads; LexoRank thresholds are from Data Center docs, not Cloud.
- GitLab's depth limits come from tracker issues.
- GitHub `subIssuesSummary`: unclear whether it counts direct children or all descendants.
- GitLab migration detail comes from tracker issues and MRs, not the design doc, whose body I couldn't retrieve.
- I found no Height sources (it was likely shut down; not verified).

### Sources
- [GitLab work items (dev)](https://docs.gitlab.com/development/work_items/)
- [GitLab child items](https://docs.gitlab.com/user/work_items/child_items/)
- [GitLab: backfill `work_item_parent_links` from `epic_issues`](https://gitlab.com/groups/gitlab-org/-/epics/12742)
- [GitLab MR 253761: backfill missing epic_issues rows](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/253761)
- [GitLab MR 172071: re-sync work item data](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/172071)
- [GitLab issue 474312: depth limits](https://gitlab.com/gitlab-org/gitlab/-/issues/474312)
- [GitHub sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)
- [GitHub issue types](https://docs.github.com/en/issues/tracking-your-work-with-issues/configuring-issues/managing-issue-types-in-an-organization)
- [GitHub tasklist retirement](https://github.blog/changelog/2025-02-18-github-issues-projects-february-18th-update/)
- [GitHub issue dependencies GA](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)
- [Linear SDK schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- [Linear sub-issues](https://linear.app/docs/parent-and-sub-issues)
- [Linear project graph](https://linear.app/docs/project-graph)
- [Plane models](https://github.com/makeplane/plane/tree/preview/apps/api/plane/db/models)
- [Asana OpenAPI](https://github.com/Asana/openapi)
- [Jira Epic Link deprecation](https://community.developer.atlassian.com/t/deprecation-of-the-epic-link-parent-link-and-other-related-fields-in-rest-apis-and-webhooks/54048)
- [Jira hierarchy level IDs](https://community.developer.atlassian.com/t/removing-hierarchy-level-ids-from-jira-cloud-platform-apis/45083)
- [Managing LexoRank](https://confluence.atlassian.com/adminjiraserver0903/managing-lexorank-1167690137.html)
- [Jira statusCategory](https://community.developer.atlassian.com/t/bad-documentation-for-rest-api-3-statuscategory/78565)
- [YouTrack link types](https://jetbrains.com/help/youtrack/devportal/resource-api-issueLinkTypes.html)
- [Shortcut story links](https://github.com/timetoreply/shortcut/blob/HEAD/docs/Model/CreateStoryLinkParams.md)
- [Structure progress column](https://help.tempo.io/structure-dc/latest/progress-column)

No repo files were edited. The downloaded schemas are in `/tmp/claude-1000/-home-mgw-src-other-podium-wt-6000/b1983ca6-7b48-4e5b-80fe-a5fdef435598/scratchpad/dl/`.