# Mission pane pool readers

Baseline: `integrate/4286-pilot` at `0f629c488a`. This expands the 01a inventory in `POD-5077-switch-baseline.md` before changing FlightDeck. The pane keeps its existing components, labels, layout, folds, modes, selection and mutation owner. The startup choice is POD-5089's pane switch (`mobxPane=1/0`, otherwise POD-5280's device pilot setting).

| Legacy read at this baseline | Values and replacement |
| --- | --- |
| FlightDeck.tsx:190 MissionAgentMenu | Full repo/machine slices, reposToViews and machineViewsFromWire for eligible hosts. Address repo/host facts through the existing pool header source. |
| FlightDeck.tsx:689 CrewCensus, :1086 SessionRow | coarseNow for timing; keep bounded clock reads and pure timing policy. Session display props must come from the pool. |
| FlightDeck.tsx:1076 SessionRow | renameSession action; keep the existing mutation owner. |
| FlightDeck.tsx:510 rowUnread | subtreeUnread walks the supplied issue map and row descendant IDs. Keep the presentation helper over addressed pool values. |
| FlightDeck.tsx:1571, :1601, :1604 TaskRow | deck state, note and seat; issueNote/presenceNote indirectly derive legacy spin-off ownership. Replace their entity queries with pool presentation values. |
| FlightDeck.tsx:2954 main selector | sessions and repos; remove these full-slice subscriptions on the pool path. Keep selection, panes, split, visit cursor and actions. |
| FlightDeck.tsx:2989-2992 | useReplicaIssues and allWorktreePaths; replace with addressed issue rows and declared ownership relations. |
| FlightDeck.tsx:3060-3088 | selectedMissionRoot, root lookup, buildFlightDeckRows, reuse, display titles and all-issue map. Pool root/members API plus per-member rows, stable row reuse and explicit title input. |
| FlightDeck.tsx:3066-3069 | status picker reads a legacy full issue and close guard sessions. Supply addressed issue/member inputs. |
| FlightDeck.tsx:3097-3116 | focused-session find, missionIssueIds, progress and departures. Address sessions; use the shared pool membership and relation traversal. |
| FlightDeck.tsx:3127 | session-name map over deck rows; keep over pool-supplied rows. |
| FlightDeck.tsx:3156, :3177, :3196, :3204 | root continuation, note, seat and empty note read all issues/sessions. Pool continuation/dependency/ownership queries, preserving exact wording. |
| FlightDeck.tsx:3221-3308 | proposal partition, search, folds, guides, lead set and rails. Keep existing pure presentation over pool rows. |
| FlightDeck.tsx:3311-3317 | proposal author lookup in full sessions. Address the starter session. |
| FlightDeck.tsx:3328-3339 | archivedSessionsForIssue once per displayed row: rows × all sessions. Read issue.sessions (including archived) by relation, preserve shell/headless/explicit ownership and reveal order, deduplicate by ID. |
| FlightDeck.tsx:3341-3352 | mission-session set, root session, draft display title and root composer draft. Keep local set/draft; address the title's member input. |
| FlightDeck.tsx:3420-3424 | reveal callback finds session/owner and runs missionRootFor. Address session/owner and shared pool root. |
| FlightDeck.tsx:3507-3513 | departure callback filters all sessions for its target. Address explicit target members. |
| FlightDeck.tsx:3540, :3561 | context-menu and rename issue lookups. Address rows at gesture time. |
| FlightDeck.tsx:3592 and mounted IssueCloseDialog | full-session subscription and member filtering in close eligibility. Shared guard belongs to POD-5165; coordinate its pool input API, do not edit concurrently. |
| FlightDeck.tsx:3622-3624 | add-agent excludes existing sessions via whole-slice filter. Address root attachments. |
| FlightDeck.tsx:3667, :3672 | handoff callbacks find sessions in the full slice. Address sessions. |
| FlightDeckHandoff.tsx:268-280 | missionSessions, deriveHandoffNow and deriveHandoffNext rederive membership. Supply pool crew/current/next values; keep transcript/API event reads and the rendering tree. |
| FlightDeckWaterfall.tsx | Pure deckSessions/native subagent/ask/unread policy over row props; bounded coarseNow and rename/trpc actions. Preserve rendering. |
| MissionGauge.tsx / MissionCostChip.tsx | Gauge uses supplied progress; cost is an explicit lazy API query. Preserve API/mutation ownership. |
| explorer-context.tsx:96-248 | Switch selects the existing pool provider only for the sidebar choice; pane-on/sidebar-off must also choose the pool provider. Obtain coordinator clearance before editing. |
| IssueCompactControls.tsx / IssueContextMenu | Shared status/decision/action/guard readers can run behind mission menus. POD-5165 owns command/guard migration; coordinate supplied inputs or shared switch coverage. |
| Workspace.tsx and FoldedFlightDeckBar.tsx | Enclosing/folded mission selection and roster reads from 01a. Coordinate with pane/navigation ownership before touching these files. |

Reviewable slices: (1) declared summaries and addressed mission-value reader, (2) FlightDeck root/rows/member/archived/title/continuation reads, (3) handoff and gesture/guard inputs, (4) focused value and rendered-output parity plus zero-legacy counters. Each slice gets a WIP checkpoint and code review before the next; validation runs only once the implementation is complete, with required planted-fault controls thereafter.

Cold policy: every entity value goes through pool.row; relation metadata supplies IDs without a separate ownership index. Cold scalar summaries are declared before ingest. Missing required fields return LOADING and schedule the ordinary batched load. Never peek, never read old issue records, never fabricate a missing entity as a deleted one.

Acceptance evidence: synthetic corpus and change-generator comparisons of all mission values, rendered visible text/labels/element order, store-level zero-legacy mission and session-ownership counters, private replay on ludovico (only counts/positions/opaque IDs may leave), and two same-SHA real Chromium runs per pane-switch arm through the click speed gate on flatblock. Do not claim speed or completion until the evidence exists.
