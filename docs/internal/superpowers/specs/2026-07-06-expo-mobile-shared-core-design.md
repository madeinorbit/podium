# Expo Mobile Client with Shared Core - Design

**Date:** 2026-07-06
**Branch / worktree:** `issue/80-expo-mobile-shared-core` @ `afbf0ff`
**Status:** Approved design boundary, pending written-spec review -> implementation plan
**Issue:** #80, "Expo React Native mobile client"

## 1. Goal

Build a new mobile Podium experience with Expo and React Native that is separate from
the existing desktop web UI. The first delivery surface is Expo web served by Podium at
`/mobile`, so mobile users and open-source users can try it without installing an app.
Native iOS/Android support should be designed in from the start, but app-store packaging
is a later rollout step.

The first product slice is the existing agent/session workflow:

- A Focus home view shows the active/recent sessions that need attention first.
- Cards are session/agent-centric, with issue context attached when available.
- Tapping a card opens the session.
- Back returns to the same Focus queue.
- A "next" affordance moves through the queue without making the user re-triage.
- Session detail is chat/transcript first, with terminal available from the start.

## 2. Current state

Podium already has thin-client behavior, but it lives inside `apps/web`:

- `apps/web/src/store.tsx` owns tRPC, WebSocket, replica hydration, outbox draining,
  session actions, and app view state.
- `apps/web/src/replica.ts` owns browser-backed local replica storage and transcript
  window caching.
- `apps/web/src/home.ts` and `apps/web/src/derive.ts` own important product selectors,
  including "needs your attention" ordering.
- `apps/web/src/MobileApp.tsx` is a breakpoint/mobile layout inside the desktop app,
  not a separate mobile product surface.
- `packages/terminal-client` is browser/xterm-specific and not a portable terminal
  interface.

The key correction for this effort: mobile must not start by cloning the web store into a
second app. The first slice must create one shared client core and make desktop web consume
the same overlapping primitives that mobile consumes. Desktop web keeps its desktop UI,
but its shared data/sync/action behavior should move toward the same core instead of
forking.

## 3. Settled decisions

| Topic | Decision |
| --- | --- |
| App shape | Add a separate `apps/mobile` Expo app. Do not keep building the mobile experience as a desktop breakpoint. |
| Shared logic | Add a shared client package from the start, tentatively `@podium/client-core`. Desktop web and mobile both consume it for overlapping session/data/action logic. |
| First surface | Expo web at `/mobile`, same origin as Podium. Native Expo remains structurally supported but not the first published surface. |
| Initial workflow | Existing agents/sessions first, not a new issue-only app. |
| Home model | Focus Stack: a queue of active/recent sessions ordered by existing attention logic. |
| Detail default | Chat/transcript first. Terminal is secondary in layout but first-class in architecture. |
| Terminal | Build a platform terminal adapter from the start. Expo web uses the hardened browser/xterm path; native can start limited/experimental behind the same interface. |
| Routing | Phones visiting `/` should land on `/mobile` by default, with an explicit escape hatch back to desktop. |
| Offline model | Use the existing P6/P3 replica/outbox direction. Do not invent a mobile-only sync model. |

## 4. Architecture

The architecture has three layers:

```text
apps/web                    apps/mobile
desktop React UI            Expo Router + React Native UI
       |                    |
       +---------+----------+
                 |
        @podium/client-core
        selectors, client state model,
        sync/outbox contracts, action layer
                 |
       +---------+----------+
       |                    |
web platform adapter        Expo platform adapters
browser storage,            Expo web browser storage,
tRPC/WS origin, xterm       native storage, terminal bridge
```

`@podium/client-core` is a pure shared package. It depends on `@podium/protocol`,
portable utilities, and typed interfaces supplied by platform adapters. It must not import
React DOM, React Native, localStorage, AsyncStorage, xterm, `window`, `document`, Expo
Router, or app-specific UI components.

`apps/web` remains the desktop product. The implementation should extract shared
primitives from `apps/web` into `@podium/client-core` and then rewire web to consume them
before mobile builds on the same pieces. This prevents two attention-ordering functions,
two outbox contracts, and two subtly different session action models.

`apps/mobile` owns mobile navigation, layouts, controls, and platform-specific rendering.
It should not import from `apps/web`.

## 5. Shared client core boundary

The shared core should own the parts of "being a Podium client" that are not visual:

- Session and issue projections used by both apps.
- Focus queue selectors, including the current "needs your attention" behavior:
  `needs_user`, retryable/error states, idle question/approval/open-todos verdicts,
  snooze handling, and recency ordering from real session timestamps.
- Work item/card view models: display title, agent kind, status tone, issue context,
  last activity, blocked/needs-human summaries, and action availability.
- Typed action layer for shared user intents: send message, resume/send, rename,
  snooze, archive/unarchive, mark/pin as needed, request transcript window, and
  reconnect/refresh.
- Replica and outbox contracts: storage driver interface, hydration lifecycle,
  mutation-id generation, queue classification, retry/drop behavior, and subscriber
  notifications.
- Sync ingest helpers for metadata snapshots, `sync.changesSince(cursor)`,
  `metadataDelta`, transcript window deltas, and local optimistic patches.
- Connectivity and freshness state that both apps can surface consistently.

The shared core should expose a small set of public modules rather than a large global
store. A useful shape for the implementation plan is:

- `@podium/client-core/focus` for attention grouping and queue ordering.
- `@podium/client-core/replica` for storage-neutral replica/outbox primitives.
- `@podium/client-core/actions` for typed client commands and write classification.
- `@podium/client-core/transcripts` for cached window state and read/subscribe stitching.
- `@podium/client-core/testing` for fixtures used by both app test suites.

The exact filenames can change during implementation, but the import boundary cannot:
shared core is app-neutral, and apps supply adapters.

## 6. Mobile app experience

`apps/mobile` should use Expo Router for separate mobile navigation:

- `/` or `/focus`: Focus home, the first screen.
- `/session/[sessionId]`: chat/transcript-first session detail.
- `/session/[sessionId]/terminal`: terminal surface, reachable from the session detail.
- `/issue/[issueId]`: lightweight issue context/detail when a card needs deeper issue
  inspection.
- `/settings`: server connection, desktop escape hatch, diagnostics, and later native
  app settings.

Focus home is dense and operational, not a marketing page. It should prioritize:

- Needs attention
- Working/recent
- Idle but recently active
- Snoozed or archived only when explicitly requested

Session detail should have:

- A transcript/chat timeline using cached transcript windows for first paint.
- A composer for sending/resuming turns.
- Clear state for sending, queued, disconnected, needs approval, errored, or blocked.
- A terminal entry point that keeps terminal available without making it the default
  reading experience.
- Back to Focus and next-session controls that preserve the queue position.

The first mobile UI should be useful on a phone viewport in Expo web. Tablet layouts and
native-specific polish are follow-ups unless needed to keep the architecture honest.

## 7. Terminal strategy

Terminal support is required from the start, but it is platform-adapted:

- Define a shared terminal surface contract outside `packages/terminal-client`, for example
  attach/detach, input, paste, resize, redraw, control request, connection state, and frame
  stream handling.
- Expo web uses a browser adapter that reuses the existing xterm implementation from
  `@podium/terminal-client` where possible.
- Native uses the same contract. The first native implementation may be limited, read-only,
  or WebView/DOM-component based, but it must sit behind the same interface so native
  parity does not require changing product code later.
- Terminal is never offline. When disconnected, mobile should show cached transcript and
  explicit reconnect state, not pretend the terminal can keep running locally.

This keeps the terminal first-class without letting xterm leak into the shared client core
or React Native screens.

## 8. Offline and sync model

The mobile app should follow the existing offline-first direction from the issue/docs
corpus:

- P6 thin-client replica for offline reads and fast first paint.
- P3 outbox with mutation ids for replay-safe queued writes.
- Transcript lake/window caching for recent and open sessions.
- Provenance and write classification so the client knows what can queue and what must be
  live.

Behavior:

- On boot, hydrate Focus home, sessions, issues, conversations, and recent transcript
  windows from the local replica before waiting for the network.
- Then call `sync.changesSince(cursor)` and apply live `metadataDelta` through the same
  reducer path.
- Queue replay-safe writes such as message send/resume-send, rename, snooze, archive,
  and later issue edits with stable mutation ids.
- Keep destructive/live-control actions direct only: kill, terminal takeover, raw terminal
  input, and similar operations require an active server connection.
- Show pending/queued/error states in both web and mobile from the same outbox state.

The first implementation can keep browser-backed storage for Expo web and define the native
storage adapter boundary. Native durable storage is required before app-store publication,
but mobile web should not wait for that.

## 9. Server and deployment integration

Expo web output should be served by Podium at `/mobile` on the same origin as the existing
web app. That gives mobile web the same auth/cookie model, tRPC origin, WebSocket origin,
and local development topology.

Initial server integration:

- Add an `apps/mobile` build that emits static web assets.
- Teach the Podium web/server packaging path to serve those assets under `/mobile`.
- Preserve existing desktop web at `/`.
- Add phone detection on `/` that redirects to `/mobile` by default.
- Add an explicit escape hatch, such as `/desktop` or a persisted "use desktop" setting,
  so users can get back to the existing app.

The current desktop breakpoint mobile UI can remain as a fallback during rollout, but it is
not the target mobile experience.

## 10. Testing and verification

The implementation should start test-first around the shared core:

- Unit tests for Focus ordering using real cases from `apps/web/src/home.ts` and recent
  issues: needs-user, approval, errored, open todos, snooze, archived, working, and recency.
- Import-boundary tests proving `@podium/client-core` does not import app/UI/platform
  modules.
- Replica/outbox tests that run without DOM or React Native globals.
- Web parity tests proving desktop web still uses the same selectors/action contracts.
- Mobile component tests for Focus home rendering, queue navigation, session detail state,
  and terminal entry-point state.

Runtime verification is required for UI/interaction work:

- Start the local app stack in the worktree.
- Open `/mobile` at a phone viewport with Playwright.
- Verify Focus cards render from seeded/live data.
- Click a card into session detail, send/resume where the harness allows it, go back, and
  jump to the next session.
- Verify the Expo web terminal adapter attaches to a session and handles a real interaction
  if the current test harness supports terminal control.
- Verify `/` redirects phones to `/mobile` and the desktop escape hatch works.

Current baseline before any implementation:

- `bun install --frozen-lockfile` passes.
- `bun run typecheck` passes.
- `bun test` fails in the clean worktree with `1596 pass / 245 fail / 109 errors`, mostly
  existing environment/version, DOM-under-Bun, node-pty/tmux, and `node:sqlite`/Vitest API
  failures. The implementation plan should use narrower verification commands until the
  baseline suite is repaired.

## 11. Rollout

Ship in slices:

1. Add `@podium/client-core` and move the first shared selectors/contracts into it.
   Rewire desktop web to consume those primitives with parity tests.
2. Add replica/outbox/shared action contracts and adapt the desktop web path where the
   mobile first slice needs them.
3. Add `apps/mobile` Expo shell with Focus home using the shared core.
4. Add session detail with transcript/chat and composer.
5. Add terminal adapter contract plus Expo web terminal adapter.
6. Serve `/mobile` from Podium and add the phone redirect plus desktop escape hatch.
7. Expand native adapters after mobile web is useful and before app-store publication.

Each slice should leave desktop web working. Shared-core extraction should be incremental,
but not optional.

## 12. Out of scope

- App Store / Play Store packaging, signing, and release process.
- Push notifications.
- Full native terminal parity in the first mobile web iteration.
- Offline terminal operation.
- Replacing the desktop web UI.
- A full issue-management mobile app before the agent/session workflow is solid.
- Broad unrelated cleanup of `apps/web`.

## 13. Primary file touchpoints

- `packages/client-core/*` - new shared client core package.
- `apps/web/src/home.ts`, `apps/web/src/derive.ts`, `apps/web/src/store.tsx`,
  `apps/web/src/replica.ts`, `apps/web/src/outbox.ts` - source material and desktop
  integration points for shared extraction.
- `apps/web/src/AppShell.tsx`, `apps/web/src/MobileApp.tsx` - routing/rollout interaction
  with the legacy breakpoint mobile UI.
- `packages/terminal-client/*` - browser terminal adapter source.
- `apps/mobile/*` - new Expo Router / React Native app.
- `apps/server/src/*`, `scripts/*`, package/build config - serving `/mobile` and packaging
  the Expo web build with Podium.
- `docs/spec/oplog-read-path.md`, `docs/spec/outbox-write-path.md`,
  `docs/spec/thin-client-replica.md`, `docs/spec/transcript-mirror.md`,
  `docs/spec/conversation-registry.md`, `docs/mobile-web-agent-cli-challenges.md` - prior
  architecture that this design follows rather than replacing.
