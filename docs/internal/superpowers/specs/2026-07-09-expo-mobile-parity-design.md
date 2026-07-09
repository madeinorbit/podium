# Expo Mobile: Web-Mobile Feature Parity + Shared-Core Completion — Design

**Date:** 2026-07-09
**Baseline:** `main` @ ad4f021 (`apps/mobile` inbox-tabs variant)
**Prior specs this builds on:** `2026-07-06-expo-mobile-shared-core-design.md` (issue #80),
`2026-07-09-mobile-sidebar-home-design.md` (issue #227, web responsive shell)

## 1. Goal

Bring the Expo app (`apps/mobile`, the inbox-at-bottom variant) to functional parity with
what the responsive web app offers on a phone today, and finish its integration with the
`@podium/client-core` rearchitecture. The web breakpoint shell (`apps/web/MobileApp`)
remains the parity *reference*, not the implementation: `apps/mobile` keeps its own
navigation identity (bottom tabs: Inbox / Sessions / Superagent / Issues) and native-feel
components.

Non-goal: unifying the two mobile experiences into one. The Expo app is the strategic
surface; the web breakpoint shell keeps evolving separately until the Expo app supersedes
it (a later decision, not this effort).

## 2. Inputs

Four research tracks feed this design (2026-07-09):

- **Current-app audit** — the Expo app already runs the shared `StoreProvider`
  (replica + outbox + SocketHub) but integrates shallowly: a `LiveBridge` god-context
  republishes the whole store (re-render fanout), read/unread and `getUserFocus()` are
  dead because store view/pane state is never set, transcripts are network-only despite
  the replica implementing cached windows, issue writes and question answers bypass
  optimistic paths, `spawnDraftAgent` is unused, the terminal opens a second WebSocket,
  and there are zero mobile tests.
- **Web-mobile inventory** — the parity target: work-list home (#227), AgentPanel with
  chat/native duality + recovery states, full IssuePage, superagent overlay with
  concierge threads, omni-search, 14 settings tabs, onboarding/repo scan, host/quota/
  connection/outbox indicators, usage view, notification triggers.
- **Orca mobile source** — transport-resilience playbook (foreground/network revival,
  activity probe, half-open socket detection, stream replay), local-notifications-from-
  socket pattern, WebView terminal at desktop dims with CSS scale, accessory key row,
  persisted snapshot caches. Anti-patterns: CDN-loaded xterm, 5k-line screens, poll-only
  lists, no structured approval UI.
- **Omnara / Conductor / adjacent** — structured one-tap answers above the composer
  (answer-and-submit vs answer-and-edit), approve-with-feedback, waiting-first inbox
  (nobody ships it well — we already do), foreground-aware push channel design,
  create-session-from-issue, archive/pin lifecycle, voice input convergence.

## 3. Settled decisions

| Topic | Decision |
| --- | --- |
| Base variant | Build on `main`'s `apps/mobile` (inbox tabs). The `fix/multi-machine-daemon-reconnect` "focus experience" variant is dead; do not port from it. |
| Navigation | Keep 4 bottom tabs + stack routes. Issues tab becomes the issue-centric **work list** (parity with #227's WORKING / PINNED / WORK sections); Inbox stays attention-triage-first (the app's identity). |
| Data layer | Kill `LiveBridge`/`MobileClientValue`. Screens consume `useStoreSelector` + store actions directly via thin typed hooks in `src/client/hooks.ts`. `MobileClientProvider` shrinks to bootstrap (replica, trpc handle, StoreProvider, demo mode). |
| View reflection | Expo-router navigation is reflected into the store (`setPane`/`setSelectedIssueId`/`setView`) from screen focus effects, making read/unread sync (`useMarkReadOnView`) and `getUserFocus()` (#225) work on mobile with zero new store concepts. |
| Transcripts | Extract web's `useTranscriptWindow` window-stitching into `@podium/client-core` (the `/transcripts` module #80 promised) and rewire **both** apps. Mobile gains cached first paint + offline copies with the same code web uses. |
| API extras | Move the hand-written `MobileTrpcExtras` procedure types into `@podium/client-core/api`'s `PodiumClientApi` so web's AppRouter assignability test covers them; delete the drift-prone local copy. |
| Spawning | New-session paths use `spawnDraftAgent` (optimistic, offline-tolerant), same as web. |
| Terminal (Expo web) | Reuse the store's SocketHub (no second socket) if `terminal-client-react` allows hub injection; otherwise add that seam. Key-toolbar parity with web mobile (toolbar groups, Ctrl modifier, arrow D-pad). |
| Terminal (native) | Orca-style WebView hosting the existing xterm terminal-client with **bundled** assets (never CDN), desktop-dims + fit. Designed here, implemented as the last slice; the stub stays until then. |
| Question answering | Keep `answerAskUserQuestion` direct/live (web parity), but add answer-and-edit (populate composer) alongside one-tap submit, and an optional steering comment on approvals (Conductor's approve-with-feedback) where the send path allows appending text. |
| Notifications | Settings UI parity only (ntfy topic, Telegram connect flow, web-push toggle where supported). Native Expo push is a separate future issue (out of scope, as in #80). |
| Specs editor / command palette | Out of scope. BlockNote is web-only and low-value on phones; the palette is hardware-keyboard-only even on web mobile. Omni-search covers palette's mobile job. |
| Tests | Mobile gets a real vitest suite (pure logic + component tests) and a Playwright phone-viewport spec in `tests/e2e` driving `/mobile`. |

## 4. Architecture (slice S1 — the "improve the code architecture" ask)

### 4.1 Store consumption

`src/client/hooks.ts` exposes the app's read surface as narrow selector hooks —
`useSessionList()`, `useSession(id)`, `useIssueList()`, `useIssue(id)`,
`useConnection()`, `useOutboxSize()`, `useStoreActions()` — each built on
`useStoreSelector` with shallow-stable projections. Screens never call `useStore()`.
`MobileClientContext` survives only for bootstrap values (trpc client, server config,
demo flag), which never change after mount.

### 4.2 Navigation → store reflection

A single `useReflectFocus` hook (in `src/client/`) is mounted by the session and issue
screens: on focus it calls `setPane('a', sessionId)` / `setSelectedIssueId(issueId)` and
clears on blur. That alone activates the store's `useMarkReadOnView` (read/unread sync to
desktop) and populates `getUserFocus()` for superagent turns. The memory
`RouterWindow` stays (expo-router owns real navigation); we are reflecting selection, not
URLs.

### 4.3 Shared transcripts module

`packages/client-core/src/transcripts/` gains the window-stitching state machine currently
in `apps/web/src/chat/useTranscriptWindow.ts`: replica-window first paint, live subscribe
from the tail, `transcriptRead` paging, merge/prepend via the existing viewmodel helpers,
offline-copy metadata (`asOf`). Exported through a new `./transcripts` package export;
`apps/web` re-exports/rewires with **zero behavior change** (its existing chat tests keep
passing), and mobile's `SessionScreen` drops its hand-rolled network-only effect.

### 4.4 API seam

`MobileTrpcExtras` (transcript paging, answerAskUserQuestion, superagent threads, issue
CRUD, repos.list) moves into `PodiumClientApi`. Web's compile-time assignability check
(`AppRouter` → `PodiumClientApi`) then guards the whole client surface; mobile's
`trpc.ts` shrinks to transport config.

### 4.5 Transport resilience (Orca lessons, applied to client-core)

- **Foreground revival:** mobile subscribes to `AppState`; on `active`, nudge the hub —
  if connected, force a liveness probe; if reconnecting, reset backoff and dial now.
  Exposed as a small hub method (`hub.nudge()` or equivalent) in client-core so web can
  use it on `visibilitychange` too.
- **Half-open detection:** verify SocketHub has (or gains) an app-level probe; RN sockets
  drop `onclose` after backgrounding/network handoff, so a ping-less socket must be
  force-closed on probe timeout.
- Stream replay after reconnect already exists in the hub's subscription model — verify
  with a test rather than reimplement.

### 4.6 Cleanups riding along

Raw hex colors move into `theme.ts` tones; repo/agent chip pickers dedupe into shared
components; `Date.now()`-per-render replaced by a minute tick hook; transcript page size
and other magic numbers named. The per-card N+1 `transcriptRead` on Inbox
(`usePendingQuestion`) is replaced by reading `agentState.need` metadata where sufficient,
falling back to one fetch for the focused card only.

## 5. Feature parity (slices S2–S8)

### S2 — Inbox & cards
Pinned section; swipe actions on cards (archive / snooze / pin) with haptics; unread
bolding from `readAt` (now synced); one-tap default spawn ("New Claude in <repo>", MRU +
`roles.coding` default, optimistic); answer-and-edit path on question cards; approve-with-
feedback comment; connection/outbox/quota/memory chips in the header (compact
HostIndicators parity, incl. quota + memory breakdown sheets).

### S3 — Session detail
Markdown rendering for chat blocks (RN-native renderer; web output keeps DOM renderer via
platform split); image attachments (pick/paste → `sessions.uploadImage` → prompt tokens,
with per-attachment states); queued-message strip; sticky last-prompt header + jump;
hibernated/exited recovery banners with Resume / Restart shell / Remove session actions;
resume-command copy sheet; BTW (seed superagent thread from session) and tl;dr; offline-
copy banner from the shared transcripts module; voice input (Web Speech on web; native =
stretch via expo-speech-recognition); transcript search (stretch).

### S4 — Issues & work list
Issues tab becomes the unified work list: WORKING / PINNED / WORK sections from
`sidebarSections`/`partitionUnifiedWork` viewmodels, group-by-repo toggle, stale-child
collapsing, long-press context menu (stage, priority, assign, labels, snooze/defer, pin,
archive, close, delete). IssuePage parity: editable title/description, sub-issues with
progress, Details section (status/priority/assignee/type/labels/estimate/due/defer,
relations), Sessions section (start work per agent kind, model/effort pickers, + shell),
Git actions (merge/PR/rebase per `gitWorkflow`), needs-human + suggested-stage banners,
activity feed (assistant notes, events, comments) with composer. New-issue parity: labels,
assignee, parent branch, model/effort, create-more, start-now.

### S5 — New session
Machine submenu when >1 machine (online dots, disabled offline); resume-from-history
(conversation mini-search scoped to worktree/repo); spawn-into-issue (`issueId` rides the
create); agent list derived from settings/machines instead of the hardcoded array.

### S6 — Superagent
Concierge + btw thread switching with proper labels; "Open in terminal"; legacy
pre-headless history block; stop-turn; fresh-thread composer with @-mentions (repos,
worktrees, past conversations); `getUserFocus()` payload on every turn (enabled by S1).

### S7 — Settings, search, tools
Settings restructured as a section list pushing sub-screens (parity with all 14 web tabs,
including RoleBackendEditor equivalents, Telegram connect flow with polling, machines
panel with pairing codes, network step, security/password, updates channel). Omni-search
screen (sessions/issues/conversations/transcripts/settings with FTS snippets). Usage
screen. Notification-triggers screen (the real part of AutomationsView). Onboarding/repo
scan flow (server-side directory browser + scan results) for the repos-empty state.

### S8 — Terminal
Expo web: single-hub attach, toolbar parity (Esc/Tab/⇧Tab/^C… groups, one-shot Ctrl
modifier, paste), ArrowSwipeKey D-pad, clickable file paths → file viewer route, viewport/
keyboard pinning. File viewer route: markdown preview/source (+save with conflict guard)
and read-only code view on native; CodeMirror stays web-only behind the platform split.

### S9 — Native terminal (last, gated)
WebView + bundled xterm/terminal-client assets, desktop-dims + `transform: scale` fit,
two-queue readiness protocol (RN→WebView queue until `web-ready`; in-page queue until
xterm init), reuse of the store hub's frames over a message bridge, accessory keys reusing
S8's toolbar definitions. If this slice slips, the stub remains and S9 becomes its own
issue — everything else must not depend on it.

## 6. Error handling

All store writes keep their existing optimistic/outbox semantics; direct tRPC calls
surface inline error strips (screen-local, not the global Inbox error line, which goes
away with LiveBridge). `sendText` stays fail-fast when live and `resumeAndSend` stays
outboxed (the deliberate web asymmetry). Destructive actions (kill, delete issue, disable
login) get confirm sheets via the shared guard logic (`useSessionGuard` equivalents).
Offline: every screen renders from replica data with the connection chip degraded; actions
that require liveness disable with a reason instead of throwing.

## 7. Testing

- **client-core:** transcripts-module unit tests ported from web's chat tests + new
  hub-nudge/replay tests. Web parity proven by keeping existing web chat/store tests
  green after the rewire.
- **apps/mobile:** vitest + react-test-renderer for logic-bearing components (inbox
  sections, question card paths, issue context menu eligibility, settings forms), pure
  tests for hooks/selectors.
- **tests/e2e:** a `chromium-mobile` phone-viewport Playwright project driving the served
  `/mobile` build against the harness: inbox renders seeded sessions, answer a question,
  open session → send → transcript updates, issues work list, new session optimistic
  paint, settings save, terminal attach smoke.
- Every slice lands with `bun run typecheck` green across workspaces.

## 8. Rollout / sequencing

S1 (architecture) → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9. Each slice is a commit-able
unit that leaves web untouched-or-green and the Expo app shippable. Slices not finished in
the first implementation pass are filed as tracker issues referencing this spec.

## 9. Out of scope

Native push notifications (future issue; Omnara's channel design + Orca's socket-driven
local notifications are the references when it happens). App-store packaging/signing.
Specs editor and command palette on mobile. Unifying web-mobile and Expo experiences.
Live localhost preview, screenshot-annotate, session sharing (idea backlog, not this
effort).
