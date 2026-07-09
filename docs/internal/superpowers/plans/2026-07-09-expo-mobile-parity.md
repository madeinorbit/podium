# Expo Mobile Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `apps/mobile` (inbox-tabs Expo app) to functional parity with the responsive web app on phones, completing its `@podium/client-core` integration per `docs/superpowers/specs/2026-07-09-expo-mobile-parity-design.md`.

**Architecture:** Slice S1 rebuilds the mobile data layer on `useStoreSelector` + store actions (killing the `LiveBridge` god-context), reflects expo-router navigation into store selection (activating read/unread sync and `getUserFocus()`), and extracts a portable transcript-window data hook into client-core consumed by both apps. Slices S2–S9 add parity features on top, each independently shippable.

**Tech Stack:** Expo 57 / RN 0.86 / React 19.2, expo-router, `@podium/client-core` (TanStack DB replica + outbox + SocketHub), `@podium/terminal-client-react`, vitest, Playwright (tests/e2e harness).

## Global Constraints

- Bun workspace; run everything with `bun`; source-level imports via the `@podium/source` condition (no build step for packages).
- `bun run typecheck` must stay green across all workspaces after every task.
- `apps/web` behavior must not change in S1 except where a task explicitly rewires it — its existing tests are the parity proof and must pass untouched (except mechanical import updates).
- No new runtime dependencies without a task explicitly naming them.
- Biome for lint/format (`bun run lint`).
- Mobile may not import from `apps/web` or `apps/server` (type-only `AppRouter` import stays banned in Metro's graph — extras live in `@podium/client-core/api`).
- Commits per task, message style `feat(mobile): …` / `refactor(client-core): …` matching repo history.

## Execution model

Tasks 1–10 (slice S1) and 11–12 (S2 start) are specified in full below. Slices S3–S9 are scoped as task groups with exact targets and acceptance criteria; **expand each into full tasks at execution time** (per-slice planning against the then-current tree — this program spans many sessions and speculative code for far slices would drift). A slice is done only when typecheck + its tests + a runtime verification pass.

Research reports backing this plan (in-session, 2026-07-09): current-app audit, web-mobile inventory, Orca source deep-dive, Omnara/Conductor research. Key file references appear inline.

---

### Task 1: Worktree + baseline

**Files:** none (environment)

- [ ] **Step 1:** `git -C <repo> worktree add .worktrees/expo-mobile-parity -b feat/expo-mobile-parity` (branch off current `main`).
- [ ] **Step 2:** `cd` the worktree (agents: use `git -C` / absolute paths), `bun install`, then `bun run typecheck` — expect green; `bun run --filter @podium/client-core test` and `bun run --filter @podium/web test` — record baseline pass counts.
- [ ] **Step 3:** `bun run --filter @podium/mobile typecheck` — expect green.

### Task 2: client-core `/transcripts` — portable transcript window data hook

**Files:**
- Create: `packages/client-core/src/transcripts/index.ts`, `packages/client-core/src/transcripts/use-transcript-data.ts`
- Create: `packages/client-core/src/transcripts/use-transcript-data.test.ts`
- Modify: `packages/client-core/package.json` (add `./transcripts` export, same three-condition shape as `./focus`)
- Modify: `apps/web/src/chat/useTranscriptWindow.ts` (becomes a thin DOM wrapper)

**Interfaces:**
- Produces: `useTranscriptData(opts: { sessionId: string; hub: Store['hub']; trpc: Store['trpc']; replica: Store['replica']; active: boolean; session: SessionMeta | undefined }): TranscriptData` where `TranscriptData = { blocks: ChatBlock[]; rows: ChatRow[]; visibleRows: ChatRow[]; renderStart: number; moreAbove: boolean; hasMoreOlder: boolean; loadingOlder: boolean; initialLoaded: boolean; offlineAsOf: number | null; loadOlder(): void; setRenderCount: Dispatch<SetStateAction<number>>; resetEpoch: number }` — everything `apps/web/src/chat/useTranscriptWindow.ts` returns today **except** the DOM-scroll refs (`pinnedToBottom`, `didInitialScroll`, `prependAnchor`, `scrollerRef`). `resetEpoch` increments on snapshot reset so platform wrappers can re-arm their scroll behavior (web) or FlatList position (mobile).

**Steps:**
- [ ] **Step 1:** Read `apps/web/src/chat/useTranscriptWindow.ts` (330 lines) fully. Identify every use of `scrollerRef`/`prependAnchor`/`pinnedToBottom`/`didInitialScroll`. The data state machine (initial replica-window paint → disk read `INITIAL_LIMIT: 1000` → tail subscribe → older pages `PAGE_LIMIT: 400` via anchored `transcriptRead direction:'before'` → `RENDER_WINDOW: 300` row windowing → `reconcileReset`) must move verbatim; only the scroll-anchoring side effects stay in web.
- [ ] **Step 2:** Write failing tests in `use-transcript-data.test.ts` covering: (a) initial paint from a stubbed replica window sets `offlineAsOf` and `initialLoaded`; (b) live subscribe merge clears `offlineAsOf`; (c) `loadOlder` widens over locally-held rows before fetching, then fetches an anchored older page and prepends; (d) a `reset` delta bumps `resetEpoch` and replaces items; (e) windowing: `visibleRows.length ≤ renderCount`, `moreAbove` correct. Use fake hub/trpc/replica stubs modeled on `packages/client-core/src/react/*.test.*` fixtures (check `packages/client-core/src` for existing test helpers first and reuse).
- [ ] **Step 3:** Run `bun run --filter @podium/client-core test -- use-transcript-data` — expect FAIL (module missing).
- [ ] **Step 4:** Implement `use-transcript-data.ts` by moving the logic from the web hook (respect its comments; keep constant names/values). Add the `./transcripts` export to package.json.
- [ ] **Step 5:** Tests pass. Then rewrite `apps/web/src/chat/useTranscriptWindow.ts` as: call `useTranscriptData`, keep its existing return type by adding the scroll refs and the reset re-arm effect (`useEffect` on `resetEpoch` flips `didInitialScroll.current = false`). Its exported interface must not change (ChatView untouched).
- [ ] **Step 6:** `bun run --filter @podium/web test` — web chat tests green, count matches Task 1 baseline. `bun run typecheck` green.
- [ ] **Step 7:** Commit: `refactor(client-core): extract portable transcript window data into client-core/transcripts`.

### Task 3: client-core api — absorb `MobileTrpcExtras`

**Files:**
- Modify: `packages/client-core/src/api.ts` (extend `PodiumClientApi`)
- Modify: `apps/mobile/src/client/trpc.ts` (delete `MobileTrpcExtras`; keep transport config)
- Test: web's existing AppRouter↔PodiumClientApi assignability check (find it: `grep -rn "PodiumClientApi" apps/web/src | grep -i assign` or in `apps/web/src/store.tsx` / a `.test-d` file)

**Interfaces:**
- Produces: `PodiumClientApi` additionally typing: `sessions.transcriptRead.query`, `sessions.answerAskUserQuestion.mutate`, `superagent.{listThreads,history}.query` + `{interruptTurn,clear}.mutate`, `issues.{get}.query` + `{create,start,update,addComment}.mutate`, `repos.list.query` — copy the exact shapes from `apps/mobile/src/client/trpc.ts:55-114`, reconciling with the server router where they drifted (`apps/server/src/router.ts` procedure defs are the truth).

**Steps:**
- [ ] **Step 1:** Move the types; fix any drift the assignability check exposes (it now covers these procedures — that's the point).
- [ ] **Step 2:** `apps/mobile/src/client/trpc.ts` shrinks: `MobileTrpc = PodiumClientApi`; `makeMobileTrpc`/`readServerConfig` stay. Update mobile imports.
- [ ] **Step 3:** `bun run typecheck` green (this compiles server, web, mobile — the whole guarantee). Commit: `refactor(client-core): type mobile's extra procedures in PodiumClientApi`.

### Task 4: Mobile selector hooks — kill `LiveBridge`

**Files:**
- Create: `apps/mobile/src/client/hooks.ts`
- Modify: `apps/mobile/src/client/MobileClientProvider.tsx` (drop `LiveBridge` + `MobileClientValue`; keep bootstrap: replica hydration, trpc, StoreProvider, demo)
- Modify: every screen/component using `useMobileClient()` (all files in `src/screens/`, `app/(tabs)/_layout.tsx`, `src/hooks/usePendingQuestion.ts`, `src/terminal/*`)
- Test: `apps/mobile/src/client/hooks.test.ts`

**Interfaces:**
- Produces (all built on `useStoreSelector` from `@podium/client-core/react`, with an `arrayShallowEqual`/`shallowEqual` helper for projections):
  - `useSessions(): SessionMeta[]`, `useSession(id: string): SessionMeta | undefined`
  - `useIssues(): IssueWire[]`, `useIssue(id: string): IssueWire | undefined`
  - `useConversations(): ConversationSummaryWire[]`
  - `useConnected(): boolean` (from store connection health — check how web reads it; provider exposes health via hub, web's ConnectionIndicator is the reference)
  - `useOutboxSize(): number`
  - `useFocusSessionIds(): string[]` (the current `focusSessionIds` memo, as a selector)
  - `useStoreActions()` — stable action bundle `{ resumeAndSend, archiveSession, setWorkState, killSession, continueSession, renameSession, setSnooze, clearSnooze, markSessionRead, markIssueRead, spawnDraftAgent, setPane, setSelectedIssueId, setView, startBtw, tldrSession, setPinned }` selected with a shallow-equal object selector (actions are stable in the store; verify in provider.tsx:1289-1376).
  - `useTrpc(): PodiumClientApi`, `useHub(): Store['hub']`, `useReplica(): Store['replica']`
  - Context `MobileBootstrap { serverConfig: ServerConfig }` via `useServerConfig()`.
- Consumes: Task 3's `MobileTrpc = PodiumClientApi`.

**Steps:**
- [ ] **Step 1:** Write `hooks.test.ts` (vitest, jsdom + `react-native` → `react-native-web` alias — see Task 9 for the shared test config; if Task 9 hasn't run yet, colocate a minimal `vitest.config.ts` in `apps/mobile` now): render a probe component under a stub `StoreProvider` (reuse client-core's store test fixture) asserting `useSessions` re-renders on session change but `useOutboxSize` consumers don't. Expect FAIL.
- [ ] **Step 2:** Implement `hooks.ts`. Demo mode: rework `DemoProvider` to run the REAL `StoreProvider` over a replica seeded from `demoData.ts` fixtures (`createReplica` + in-memory storage pre-populated with `DEMO_SESSIONS`/`DEMO_ISSUES`/`DEMO_TRANSCRIPTS`), an api stub that returns fixtures, and a `wsClientUrl` pointing at an unroutable origin; if the hub's reconnect chrome pollutes screenshots, gate the connection chip on `demoEnabled()`. If seeding proves impractical inside this task, keep a `DemoStoreProvider` shim implementing just the hooks' read surface and file the seed approach as a follow-up — but try the replica seed first.
- [ ] **Step 3:** Migrate all consumers mechanically: `client.sessions` → `useSessions()`, `client.sendMessage(id, text)` → `useStoreActions().resumeAndSend(id, text)`, `client.trpc.X` → `useTrpc().X`, `client.subscribeTranscript` → `useHub().subscribeTranscript`, etc. Delete `MobileClientValue`, `LiveBridge`, `useMobileClient`. The global inbox `error` line: replace with screen-local error state fed by `notices` (StoreProvider already takes `notices`; route `error` notices into a small `useNoticeStrip()` hook + component rendered by Inbox and Settings).
- [ ] **Step 4:** `bun run --filter @podium/mobile typecheck && bun run --filter @podium/mobile test` green; boot the app (`bun run --filter @podium/mobile dev`, or the harness from Task 10) and click through all four tabs + a session. Commit: `refactor(mobile): consume the shared store via selectors, drop the LiveBridge context`.

### Task 5: Navigation → store reflection (read/unread + user focus)

**Files:**
- Create: `apps/mobile/src/client/useReflectFocus.ts`
- Modify: `apps/mobile/src/screens/SessionScreen.tsx`, `apps/mobile/src/screens/IssueScreen.tsx`, `app/(tabs)/_layout.tsx` (tab → `setView` mapping)
- Test: `apps/mobile/src/client/useReflectFocus.test.ts`

**Interfaces:**
- Consumes: `useStoreActions().setPane('A', sessionId)`, `.setSelectedIssueId(id)`, `.setView(view)`, `.markIssueRead(id)` (session read-marking happens inside the store via `useMarkReadOnView` once paneA is set — provider.tsx:1028-1032; do NOT call `markSessionRead` manually).
- Produces: `useReflectSessionFocus(sessionId: string)` — on focus (expo-router `useFocusEffect`) sets `setPane('A', sessionId)`; on blur sets `setPane('A', null)`. `useReflectIssueFocus(issueId: string)` — on focus `setSelectedIssueId(issueId)` + `markIssueRead(issueId)`; on blur clears selection.

**Steps:**
- [ ] **Step 1:** Failing test: fixture store + a component mounting `useReflectSessionFocus('s1')` → store's `paneA === 's1'`; unmount → null. Same for issue focus incl. `markIssueRead` called once.
- [ ] **Step 2:** Implement with `useFocusEffect` from expo-router (`import { useFocusEffect } from 'expo-router'`; cleanup runs on blur). Mount in the two screens. Map tabs to `setView`: Inbox/Sessions → `'home'`, Issues → `'issues'`, session screen → `'workspace'` (check `MainView` union in provider.tsx:80 and use only existing values).
- [ ] **Step 3:** Tests + typecheck green. Runtime check: open a session on mobile, confirm the web desktop UI un-bolds it (read-state round trip), and a superagent turn now carries focus (`getUserFocus()` non-empty — verify via server logs or the turn payload in devtools).
- [ ] **Step 4:** Commit: `feat(mobile): reflect navigation into store selection — read sync + user focus`.

### Task 6: Session screen on shared transcripts + recovery states

**Files:**
- Modify: `apps/mobile/src/screens/SessionScreen.tsx` (drop the hand-rolled fetch/subscribe effect, lines ~53-97)
- Modify: `apps/mobile/src/components/TranscriptList.tsx`
- Test: extend `apps/mobile/src/screens/SessionScreen.test.tsx` (new)

**Interfaces:**
- Consumes: Task 2's `useTranscriptData` (hub/trpc/replica from Task 4 hooks); `exitedRecovery`, `chatActivity` from `@podium/client-core/viewmodels`.
- Produces: SessionScreen renders `visibleRows` (ChatRow[]) through TranscriptList; an offline banner when `offlineAsOf !== null` ("Offline copy — as of {time}"); hibernated banner + Resume (`resurrectSession`); exited banner with `exitedRecovery(session)`-driven action (Restart shell / Resume session / Remove session); queued-message strip from `session.queuedMessageCount`.

**Steps:**
- [ ] **Step 1:** Failing component tests: offline banner renders when replica-only; hibernated session shows Resume; exited shell shows Restart.
- [ ] **Step 2:** Rewire the screen: `useTranscriptData({ sessionId, hub, trpc, replica, active: isFocused, session })`; TranscriptList consumes ChatRows (it currently consumes TranscriptItems — adapt its row model to the shared `ChatRow` batching so tool-fold logic comes from client-core instead of the local collapse code). Keep inverted-FlatList paging: `onEndReached` → `loadOlder()`; use `resetEpoch` to scroll-to-bottom on snapshot reset.
- [ ] **Step 3:** Tests + typecheck green; runtime: transcript paints instantly from cache on reopen (kill server, reopen app, see offline banner + cached transcript).
- [ ] **Step 4:** Commit: `feat(mobile): cached/offline transcripts via client-core transcripts + recovery banners`.

### Task 7: Optimistic spawn on mobile

**Files:**
- Modify: `apps/mobile/src/screens/NewSessionScreen.tsx`
- Test: `apps/mobile/src/screens/NewSessionScreen.test.tsx` (new)

**Interfaces:**
- Consumes: `spawnDraftAgent({ target, agentKind, firstPrompt })` from `useStoreActions()` — read its `SpawnTarget` type and return shape in provider.tsx:209 first; it returns ids synchronously (client-minted) with rollback on failure.

**Steps:**
- [ ] **Step 1:** Failing test: submitting the form calls `spawnDraftAgent` (not `trpc.sessions.create`) and navigates to `/session/<draftId>` synchronously.
- [ ] **Step 2:** Implement; keep the free-cwd path working (SpawnTarget supports a cwd/worktree target — mirror web's `NewWorkRow` usage in `apps/web/src/SidebarUnified.tsx:161-398`). Show the 'starting' state on the session screen for pending spawns (`pendingSpawnIds` in store).
- [ ] **Step 3:** Tests + typecheck; runtime: create session offline → card paints, queued; reconnect → materializes. Commit: `feat(mobile): optimistic session spawn via spawnDraftAgent`.

### Task 8: Terminal on the store hub + foreground revival

**Files:**
- Modify: `apps/mobile/src/terminal/TerminalPane.web.tsx`
- Modify: `packages/terminal-client-react/src/*` (only if hub injection is missing)
- Create: `apps/mobile/src/client/useForegroundRevival.ts` (+ test)
- Modify: `packages/client-core/src/transport.ts` or the SocketHub source (add `nudge()` if absent — find SocketHub: `grep -rn "class SocketHub\|function createSocketHub" packages/`)

**Steps:**
- [ ] **Step 1:** Read `packages/terminal-client-react` exports (`useSocketHub`, `useTerminalSession`). If `useTerminalSession` can take an external hub, pass the store's hub from `useHub()`; delete the second `useSocketHub()` in TerminalPane.web. If not, add an optional `hub` param (non-breaking; web AgentPanel unaffected).
- [ ] **Step 2:** SocketHub foreground nudge: add `nudge(): void` — if status is degraded/reconnecting, reset backoff and dial immediately; if connected, run a liveness probe (if the hub has ping support; if it has none, `nudge()` just forces a reconnect cycle when the socket is not OPEN). Unit-test with the hub's existing test fixture (`packages/client-core/src/transport.test.ts` has the patterns).
- [ ] **Step 3:** `useForegroundRevival`: `AppState.addEventListener('change', ...)` → on `'active'`, `hub.nudge()`. Mount once in `MobileClientProvider`. Test: fake AppState emitter → nudge called.
- [ ] **Step 4:** Typecheck + tests; runtime smoke on web (`/mobile` terminal attaches; only ONE ws visible in devtools network tab). Commit: `feat(mobile): single-socket terminal + app-foreground connection revival`.

### Task 9: Mobile test rig + inbox/N+1 cleanups

**Files:**
- Create: `apps/mobile/vitest.config.ts` (jsdom, alias `react-native` → `react-native-web`, `moduleSuffixes` web-first) — if Task 4 colocated one, finalize it here
- Modify: `apps/mobile/package.json` (`test` script drops `--passWithNoTests`)
- Modify: `apps/mobile/src/hooks/usePendingQuestion.ts`, `apps/mobile/src/theme/theme.ts`, `apps/mobile/src/components/{AskQuestionCard,SessionCard,TabBar}.tsx`, `apps/mobile/src/screens/{NewIssueScreen,NewSessionScreen}.tsx`
- Create: `apps/mobile/src/components/ChipRow.tsx` (shared repo/agent chip picker), `apps/mobile/src/hooks/useMinuteTick.ts`

**Steps:**
- [ ] **Step 1:** Test rig proven by the suites from Tasks 4–7 running under `bun run --filter @podium/mobile test`.
- [ ] **Step 2:** `usePendingQuestion`: prefer `session.agentState.need` metadata (check `SessionMeta.agentState` shape in `@podium/protocol`) and only `transcriptRead` for the card the user opens/answers; add test for "no fetch when need summary suffices".
- [ ] **Step 3:** Raw hex → theme tones (add `tone.surfaceAlt`, `tone.needsYou`, etc. as needed); chip pickers dedupe into `ChipRow`; `useMinuteTick()` (setInterval 60s returning `now`) feeds relative times so they don't go stale.
- [ ] **Step 4:** Typecheck + tests + `bun run lint`. Commit: `chore(mobile): test rig, need-metadata inbox cards, theme/chip cleanups`.

### Task 10: Playwright phone-viewport e2e for /mobile

**Files:**
- Modify: `tests/e2e/playwright.config.*` (add `chromium-mobile` project: iPhone-ish viewport 390×844, touch)
- Create: `tests/e2e/browser/mobile-app.browser.e2e.ts`
- Possibly modify: `tests/e2e/serve-harness.ts` (serve the Expo web export under `/mobile` — check how `apps/server/src/static-web.ts:79-95` serves it in prod and mirror; the harness may need `bun run --filter @podium/mobile build:web` as a pre-step)

**Steps:**
- [ ] **Step 1:** Wire the harness to serve the built Expo web app at `/mobile` (build once in the spec's `beforeAll` or a global setup; document the command).
- [ ] **Step 2:** Spec: phone viewport → `/mobile` → inbox renders seeded sessions (harness seeds — see `tests/e2e/browser/_harness.ts` helpers); tap a card → session screen; type in composer + send → transcript grows; back → tabs work; issues tab renders.
- [ ] **Step 3:** `cd tests/e2e && npx playwright test mobile-app --project=chromium-mobile --timeout=90000` — green. Commit: `test(e2e): phone-viewport coverage for the Expo web app`.

---

## Slice S2 — Inbox & cards (expand at execution)

### Task 11: Swipe actions + pinned section on Inbox
`react-native-gesture-handler` swipeable rows (dependency exists? check; if not, this task names it): swipe right = archive, swipe left = snooze menu; pin via long-press sheet; PINNED section above Needs-you (uses `pins` + `setPinned` from store); unread bolding from `readAt` (works after Task 5). Haptics on commit (`PressableScale` patterns). Tests: section partitioning + eligibility pure functions.

### Task 12: One-tap default spawn + header indicators
"New {Agent} in {repo}" primary button on Inbox header region (MRU repo + `roles.coding` default via `settings` — check how web resolves `resolveDefaultAgent` in SidebarUnified and reuse/extract to viewmodels if web-local); compact indicator cluster: connection (only when degraded, hysteresis like web's ConnectionIndicator), outbox count (exists), quota gauge (`quota.summary` 60s poll, worst-window %; tap → per-account sheet), host memory chip (`hostMetrics` from store; tap → breakdown sheet). Answer-and-edit on question cards (option long-press fills the composer); optional feedback text on approvals (appended as a follow-up send after the choice, matching web's semantics — verify how web sends approval comments, or drop if web has no equivalent path — do not invent a wire change).

## Slice S3 — Session detail parity (expand at execution)
Markdown rendering for chat blocks (platform-split: web keeps DOM/DOMPurify path via existing web renderer; native uses a RN markdown renderer — pick the one Omnara used, `react-native-markdown-display`, new dependency, named here); image attachments (expo-image-picker — new dep — → `sessions.uploadImage` → prompt tokens with per-attachment state chips); sticky last-user-prompt header; BTW (`startBtw`) + tl;dr (`tldrSession`) actions; resume-command sheet (`resumeCommand` viewmodel); transcript search (stretch); voice input on web (Web Speech), native stretch.

## Slice S4 — Issues work list + IssuePage parity (expand at execution)
Issues tab → unified work list using `sidebarSections`/`partitionUnifiedWork` from viewmodels (WORKING / PINNED / WORK, group-by-repo toggle, stale collapse); long-press context menu with `issueMenuEligibility`; IssuePage: editable title/description, sub-issues + add, Details sheet (stage/priority/assignee/type/labels/estimate/due/defer/relations), Sessions section (start work per agent kind + model/effort pickers reading the model catalog like web's ModelPicker, + shell), Git actions (`issues.action {rebase|pr|merge}` per `gitWorkflow.mergeStyle`), needs-human + suggestion banners, activity feed (`issues.events` + comments, composer). New-issue parity: labels/assignee/parent-branch/model+effort/create-more. Note: several `issues.*` procedures may need adding to `PodiumClientApi` (Task 3 pattern).

## Slice S5 — New session parity (expand at execution)
Machine submenu (>1 machine, online dots), resume-from-history (`useConversationSearch` equivalent — check what client-core exposes; scope worktree/repo), spawn-into-issue (`issueId` on create/spawn target), agent list from settings/machines instead of the hardcoded `AGENT_KINDS`.

## Slice S6 — Superagent parity (expand at execution)
Concierge + btw threads with labels; Open in terminal (`superagent.openInTerminal` → navigate to that session's terminal); legacy history block; @-mention composer (repos/worktrees/conversations); stop-turn already exists; focus payload arrives via Task 5.

## Slice S7 — Settings/search/tools parity (expand at execution)
Settings section list → sub-screens covering web's 14 tabs (`SettingsView.tsx` is the reference; whole-blob load/save semantics; RoleBackendEditor equivalent; Telegram connect flow with `telegramSetupStart`/`telegramSetupPoll`; MachinesPanel with pairing code mint; NetworkStep; password section; updates channel). Omni-search screen over `search.query` with FTS marks. Usage screen (`usage.summary`). Notification-triggers screen (`issues.subscriptionList/Add/SetEnabled/Remove`). Onboarding repo-scan flow for the repos-empty state (`repos.browse`, `discovery.scanFolder`, `repos.addMany`).

## Slice S8 — Terminal & file viewer parity (expand at execution)
Key toolbar parity from `terminal-client`'s `TOOLBAR_GROUPS` (render RN-native buttons dispatching `keySequence`/`ctrlSequence`); ArrowSwipeKey port; clickable file paths (file-link provider → file route); file viewer route: markdown preview/source + save-with-conflict-guard (`files.read`/`files.write` via `readFileScoped`), read-only code view on native; keyboard/viewport pinning audit on web (visualViewport) and native (KeyboardAvoidingView).

## Slice S9 — Native terminal (gated; expand at execution)
`react-native-webview` (new dep) hosting BUNDLED xterm + `@podium/terminal-client` assets (expo-asset; never CDN); two-queue readiness protocol (RN→WebView queue until `web-ready`; in-page queue until xterm init — Orca findings); frames bridged from the store hub over `postMessage` (define the tiny opcode protocol); desktop-dims + CSS scale with pinch presets, or server phone-fit if Podium's PTY resize seam allows per-client viewports (investigate `docs/mobile-web-agent-cli-challenges.md` + sessions module first — do NOT build a presence-lock in this slice; single-controller semantics only). Accessory keys reuse S8 definitions. If slipped: file as its own issue.

---

## Verification (every slice)
1. `bun run typecheck` at repo root.
2. `bun run --filter @podium/mobile test`, plus `--filter @podium/client-core` / `@podium/web` when touched.
3. Runtime: harness + `chromium-mobile` Playwright spec (Task 10) extended with the slice's happy path.
4. `bun run lint` clean on touched files.
