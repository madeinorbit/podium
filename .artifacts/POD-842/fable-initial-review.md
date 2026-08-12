# Initial Fable performance review

Review date: 2026-08-12  
Runtime: Claude Fable 5, high effort  
Mode: read-only adversarial review of the audit and all nine implementation children

msg_c8b2870a-7011-4acd-b2b8-f048c943134b issue:#842 2026-08-12T16:58:36.041Z
  FABLE 5 HIGH-EFFORT REVIEW — react-ui-performance-audit.md + POD-845..853
Reviewer: Fable performance review (read-only delegate). Every ranked finding was re-verified against the CURRENT worktree tip (= local main 311130a1b), not the audit baseline.

VERDICT: All nine children should proceed. No child is dropped. One child (POD-849) needs a scope amendment before any agent starts it, several briefs carry stale coordination constraints, and the measurement plan has one hole that would make the headline acceptance tests vacuous. Details below, ranked.

== BLOCKER ==

B1. POD-849's "defer terminal implementation until a terminal surface is needed" collides with a load-bearing lifecycle invariant and with POD-847's scope.
Evidence: apps/web/src/features/terminal/AgentPanel.tsx:938-954 — the native terminal is deliberately mounted in BOTH panel modes (display:none under chat) "so switching modes never disposes and re-attaches the PTY". A chat-mode panel is exactly the case where lazy xterm looks free, but the hidden terminal there is what holds the PTY attach across mode switches. Deferring xterm changes attach/detach semantics, not just load order — the same resource lifecycle POD-847 redesigns (park/evict heavy views). Two children rewriting one lifecycle in parallel is how this epic produces a regression in its flagship interaction (session/mode switching, the 51ms-class switch-trace target).
Fix: amend POD-849 to routes/settings/dock/MotionDemo splits only; move xterm/terminal laziness into POD-847 (or explicitly sequence it after 847 with 847's owner). Either way add an acceptance test: chat↔native mode toggle performs zero PTY re-attaches, and warm reveal still fires chat:cache-hit.

== HIGH ==

H1. The audit and child briefs are stale on queued work: POD-781 and POD-782 are DONE and on local main (781: 733aed8c2 area; 782: cb1a3b581). ~80 files / +3,922 lines landed since the audit baseline 491520736, including ChatView, use-chat-surface, SuperagentView, SidebarUnified, client-core engine/actions.
Consequences: (a) POD-845's "coordinate with POD-782" and POD-851's "coordinate with POD-781" are moot — the real instruction is "you are already on top of them"; POD-802 (still in review, touches use-chat-surface/chat slice/transcript feed) remains the ONE live conflict for POD-845. (b) The bundle numbers (2,890,909 B main / 662 KB Brotli) and warm-panel residency claims predate a large chat/superagent landing — re-run `bun run --cwd apps/web build` at the current tip as the epic's first act and pin THAT as baseline. I re-verified all hot-path code claims at current HEAD myself (refs below), so only the measured numbers need refreshing, not the findings.
Also: local main is now 4 ahead / 7 behind origin/main (audit said 2/2), and POD-797 has an open NEEDS-HUMAN about reconciling that divergence. The epic's final "rebase onto current local main" target is moving; track it.

H2. The acceptance-test plan leans on the 674-issue fixture, but that harness mocks the store: apps/web/src/perf/large-state.frontend-perf.tsx:44-49 vi.mocks useStoreSelector AND useReplicaIssues. Render-count / derivation-count acceptance for POD-845/846/851 through that harness would pass vacuously. A real-store harness (real engine store + replica, React Profiler commit counting, frozen coarse clock) is a prerequisite deliverable — I'd make it the first commit of POD-845 so every later child inherits it. Related: the coarse clock ticks every 60s (runtime.ts:181,427) and legitimately invalidates FlightDeck and the worklist slice (published.ts sourceEqual includes coarseNow) — freeze it in tests or the "no unrelated renders" assertions flake.

H3. POD-846 has a cheap first win the audit missed, plus a doc bug and a coordination gap.
(a) useIssueViewModels bypasses the shared snapshot's memoized rollup cache: it calls deriveIssueRollups directly per issue per hook instance (packages/client-core/src/replica/use-issue-views.ts:274) even though the snapshot already exposes rollupsFor with a per-issue cache (use-issue-views.ts:117-126). Routing through rollupsFor is a one-line-class change that removes the worst multiplier before the full shared-projection refactor.
(b) The doc comment at use-issue-views.ts:237-239 ("re-derived once per settled replica state, memoised on the shared snapshot") is factually wrong — it is per mounted hook instance. Fix it with the refactor.
(c) The comment at use-issue-views.ts:219 says "POD-797 deletes the legacy collection", but tracker POD-797 is "Bug: initial message order" — the ref is wrong or renumbered. POD-846 restructures exactly the projection-over-legacy merge that cutover rewrites; locate the real legacy-deletion issue before freezing 846's API shape.

H4. File-ownership collisions between children — serialize or assign one owner per file, and make the prose dependency a tracked edge:
- AgentPanel.tsx is edited by POD-845 (selector block, now :161-180), POD-852 (transcript effect, now :585-604), POD-847 (residency). Serialize 845 → 852 → 847 or one owner.
- IssuesKanban.tsx is edited by POD-850 and POD-853. Serialize 850 → 853 (as the audit's waves already imply; make it explicit — both briefs say "keep separate" but they cannot run concurrently on one parent branch).
- FlightDeck.tsx is edited by POD-845 (subscriptions) and POD-851 (row models). Add dep edge 851→845 (audit says "land 845 first"; nothing in the tracker enforces it — both are stage=backlog ready=true, so a scheduler could start 851 first).

== MEDIUM ==

M1. POD-848/849 will double-count the same ~202 KB. The web's ONLY runtime import from @podium/commands is the settings write planner (apps/web/src/features/settings/save-settings.ts:23; everything else is `import type`), reached through the EAGER SettingsView import in AppShell.tsx:12. Lazy Settings (849) alone evicts @podium/commands from the main chunk; 848's subpath work then improves the settings chunk and install transfer only. Sequence: 849's splits first, measure, then 848, measure again — credit each with its own delta.

M2. POD-848 build mechanics, verified: the web build resolves via the `@podium/source` condition (apps/web/vite.config.ts:154), so Vite bundles package SOURCE — subpath exports are not strictly required for shaking. The actual blockers are matrix.ts's module-init global bind (packages/model/src/annotations/matrix.ts:2838-2841 mutates MATRIX_INDEX_HOLDER.index) plus `export *` from the barrel (model index.ts:125-131) and NO sideEffects field in either package.json. Removing the side effect + sideEffects metadata may deliver most of the 126 KB matrix win without touching export maps; do subpaths for the boundary hygiene, but measure the cheap step first.

M3. POD-849's PWA precache change is a product decision, not an optimization: today's config (vite.config.ts:99-105, glob everything, 5 MiB ceiling) buys instant offline cold-start of installed PWAs. Moving cold chunks to runtime caching trades that for install/update transfer. Split this slice out and get an explicit call from the operator; don't let an implementing agent decide it silently.

M4. POD-847 is correctly framed as measurement-first; two guardrails to put in acceptance: eviction must reuse the existing cold-remount path (PanelDeck.tsx:125-131 already handles beyond-cap eviction — extend, don't invent), and the switch-trace marks + chat:cache-hit telemetry must survive so the before/after warm-switch p50/p95 comparison is honest.

== LOW ==

L1. Positive de-risk for POD-845, verified: per-entity identity IS preserved through the whole pipeline — replica upsert skips unchanged rows via jsonRowsEqual (packages/client-core/src/replica/replica.ts:1514-1540) and the optimism fold returns base rows untouched when unpatched (packages/client-core/src/engine/overlay.ts foldOverlays). Keyed selectors with Object.is equality (useSession(id), useSessionDraft(id)) work WITHOUT write-path changes. The audit assumed this; it is now confirmed.
L2. Count/ref drift (cosmetic): 35 (not 36) production useReplicaIssues callers; 32 (not 35) files selecting s.sessions; drafts selections now at AgentPanel.tsx:171, use-chat-surface.ts:188, FlightDeck.tsx:1682; runtime.ts:938-940 unchanged. All patterns hold exactly as described.
L3. AppShell.tsx:223 selects full sessions to answer `sessions.length === 0` at :410 — select the boolean, not the length.

== RECOMMENDED ORDER (amended waves) ==
0. Re-baseline at current tip: `bun run --cwd apps/web build` (record main JS raw/Brotli); `bun run --cwd apps/web test:perf:large-state`.
1. POD-845 (incl. real-store render-count harness, H2; watch POD-802 in review) → POD-846 (start with the rollupsFor reroute, H3a).
2. POD-849-as-amended (routes/Settings/Usage/dock/MotionDemo; NO terminal slice; PWA slice split per M3) → measure → POD-848 → measure.
3. POD-847 (owns terminal laziness per B1) → POD-852 (after 845 clears AgentPanel).
4. POD-850 → POD-853 (serialized, same file) ; POD-851 (after 845+846).

== ACCEPTANCE TESTS TO REQUIRE PER CHILD ==
- 845: real-store harness; 50 keystrokes in session A with 8 warm panels + FlightDeck open → 0 renders of panels B-H, their ChatViews, or FlightDeck (coarse clock frozen); same for a metadata tick on one non-focused session.
- 846: 674/530 fixture WITHOUT store mocks; one settled replica delta → exactly one flat-model build regardless of mounted reader count (assert via derivation counter); useIssueViewModel renders only on its issue's change.
- 847: heap/DOM-node/GPU-context/hub-callback counts at 1/3/8/20 visited sessions, after settle and after eviction+GC; warm-switch p50/p95 vs switch-trace baseline; zero PTY re-attach on mode toggle (B1).
- 848/849: source-map-attributed main-chunk budget that FAILS on @podium/commands or annotations/matrix entering the eager graph; per-step size deltas (M1); SW install bytes recorded before/after (M3 decision).
- 850: 5s drag on revealed large board → React commits only on {stage,index} change; proxy motion off React; frame-time budget.
- 851: background session tick and one draft keystroke → commits bounded to affected rows; layout animation fires only on placement change.
- 852: long-transcript benchmark — allocations per delta O(new paths), not O(all paths); retention capped and documented.
- 853: DOM-node + heap budget on the 674 fixture after deep scroll; focus/selection/scroll-anchor preserved.

Nothing in the audit's causal analysis was found wrong; the ranked mechanism claims all reproduce at current HEAD. The corrections above are staleness, one unsafe scope slice (B1), one measurement hole (H2), and sequencing. Good audit — proceed with the amendments.

