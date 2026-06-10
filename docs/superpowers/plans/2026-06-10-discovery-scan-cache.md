# Discovery Scan Cache Implementation Plan

Goal: make Podium first paint independent of transcript discovery by serving cached conversation summaries, refreshing with cheap head-only scans, and pushing changes in the background.

Confirmed wiring: `apps/server/src/relay.ts` sends session snapshots to new clients and broadcasts `sessionsChanged`; `packages/terminal-client/src/connection.ts` stores sessions and exposes `sessions()`/`onSessions()`. Conversation push will mirror that path with `conversationsChanged`.

TDD order:

1. Add protocol and `SocketHub` failing tests for `conversationsChanged`.
2. Add provider tests proving head-only summary extraction survives garbage tails and omits list-only `messageCount`; keep full `loadConversation` parsing intact.
3. Add cache tests for hit/miss/delete/persistence/schema-version rebuild.
4. Add scanner tests for cached quick scans, single-flight behavior, sorting/dedupe, and provider/root concurrency.
5. Add daemon/relay tests for background `conversationsChanged`, fresh on-demand scan responses, and relay broadcast to late and current clients.
6. Wire web startup to stop awaiting conversation scan, subscribe to conversation pushes, and trigger refresh from `NewPanelMenu` mount.
7. Add a small benchmark harness for full scan, persisted-cache load, and warm quick scan.
8. Run focused tests after each red-green slice, then `bun test`, `bun run typecheck`, benchmark, and build before stopping.
