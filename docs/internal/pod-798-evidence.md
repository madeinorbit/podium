# POD-798 — Issues-vertical pilot: runtime evidence bundle

**HEAD:** `10c647cc4d2591fc2aba71a9a76271ecc0e1cf7c` (branch `issue/790-issues-vertical-on-new-architecture`, working tree clean)
**Date:** 2026-07-19 · **Stack:** isolated only — `PODIUM_STATE_DIR=/tmp/pod-798-runtime-10c647cc/state`, port 28798, `PODIUM_NO_SCOPE=1`, seeded from a read-only copy of `~/.podium/podium.db` (taken 2026-07-18 23:17). The live stack was never touched.
**Seeded scale:** 1001 issues / 749 sessions (the live copy grew past the ~793/588 quoted in the brief — counts below are from this copy).

## 1. Full suites at 10c647cc (exit codes)

`bun install` first (no changes, 1510 packages).

| Gate | Command | Exit | Result |
|---|---|---|---|
| Typecheck | `bun run typecheck` | **0** | clean |
| Boundary lint | `bun run lint:boundaries` | **0** | clean |
| Manifest | `bun scripts/check-boundaries.ts --manifest-only` | **0** | clean |
| Deletion audit | `bun scripts/rearch-audit.ts` | **1 (expected)** | failing set exactly `router-triple-access` (POD-314; pinned POD-857 exclusion): baseline 123 → now 128. Also `publish-computed-fanout` **improved** 12 → 11 (audit suggests locking the baseline in). |

Vitest lanes (`bun --bun vitest run`, root config = `@podium/source` conditions + workspace aliases; run sequentially on an otherwise-quiet machine):

| Lane | Exit | Files | Tests |
|---|---|---|---|
| `apps/server/src` | **0** | 156 passed | 2076 passed, 1 skipped |
| `packages` | **0** | 162 passed, 3 skipped | 1918 passed, 4 skipped |
| `apps/web` | **0** | 136 passed | 1057 passed |

The load-sensitive mirror-lag test did **not** flake — no rerun needed.

Caveat: lanes must run from the repo root (or apps/web's own config). Running `vitest` inside `apps/server` resolves `@podium/*` via dist and fails on unbuilt packages; also `bun run build` (all packages) fails in `@podium/model`'s tsup dts step with TS5074 (`--incremental` quirk) — environmental, irrelevant to the source-condition lanes, noted for honesty.

## 2. Runtime verification at live scale (screenshots 01–03, predecessor run)

Driver: `docs/internal/pod-798-evidence/runtime-verifier.ts` (isolated server = `scripts/switch-bench-serve.ts`, real daemon, Playwright, `?e2e=1`).

- **01** `01-live-scale-board-ready-blocked-refs.png` — board renders from the replica (normalized path); blocked/ready + POD-refs spot-checked against direct SQL on the seeded DB.
- **02** `02-boot-backfill-member-session.png` — boot backfill at live scale: `sessions.issue_id` NULL 309 → 300 (9 cwd-only sessions attached); a formerly cwd-only session shows as an issue member in the UI.
- **03** `03-command-create-edit-close.png` — create → title edit → close round-trip through the command registry from the UI, each verified in the server DB (`stage='done'`, `closed_reason='done'`).
- `runtime-trace.zip` — Playwright trace of that session.

## 3. Offline edit drains (ADR 2 D7, real stack) — completed this run

Driver: scratchpad `offline-drain.ts` (same isolated stack + daemon as the verifier). Flow, all DB-verified against `/tmp/pod-798-runtime-10c647cc/state/podium.db`:

1. Created issue `POD-798 offline-drain 1784418933422` (`iss_783dfa10-109f-49ca-a5fa-8701e46f9742`) from the UI; context menu → **Mark as read** while online → `issues.read_at = 2026-07-18T23:55:42.874Z`.
2. **Stopped the isolated server** (health-checked down). Context menu → **Mark as unread**. The mutation queued durably in the client outbox — localStorage `podium.replica.outbox.v1` holds one `issueMarkUnread` entry (stable mutationId + baseline snapshot); server DB still shows the old `read_at` (offline write did not fake-land). Screenshot `04-offline-edit-drains-1-queued.png`.
3. **Restarted the server.** The outbox drained: `issues.read_at` flipped to `NULL` in the server DB and the queue emptied. Screenshot `04-offline-edit-drains-2-landed.png`. Zero page errors.

**Honest scope caveats:**
- At 10c647cc the outbox covers `issueMarkRead`/`issueMarkUnread` among issue mutations (`OutboxKinds`, `packages/client-core/src/engine/wiring.ts`); **`issues.update` (title/description) is tRPC-direct and fails fast offline** — it does not queue. The predecessor's attempt to demo an offline *title* edit failed for exactly this reason. The demo above is therefore the real outbox-covered issue edit path, not a title edit. If ADR 2 D7 is read as "all issue field edits queue offline", that is **not yet true** on this head — a finding, not a regression (main behaves the same; per the spec, procs "opt in as they join the outbox").
- The "N pending" header chip did not render during the offline window in this headless run; the durable-queue proof is the storage entry + DB flip, not the chip.

## 4. Switch latency at live scale (POD-701/736 harness)

Instrument: `scripts/switch-bench-serve.ts` + `tests/e2e/switch-bench.ts` (unchanged; `packages/protocol/src/perf.ts` metric names untouched — consumer only). 40 chat-mode switches across 6 issue rows (warm-set rotation), 2500ms dwell, seeded scale 1001 issues / 749 sessions:

```
traces=40 quiesced=40 timedOut=0
p50=168ms  p90=798ms  max=887ms
```

Reference (post-722/725 main, 530-session scale): p50 548ms / p90 1012ms. **At/better than parity — no switch regression.** (Expected ~parity: the pilot's switch-relevant work was already zeroed by POD-722; the pilot's own win is the agent-activity path, committed as the POD-796 bench: old 81.7ms p50 / 15,860 scans per activity tick → new phase-absent / 0.) Caveat: different machine-load conditions and a larger dataset than the reference run; the numbers are not a strict A/B, but the direction is unambiguous. Raw traces + server perf snapshot: `05-switch-latency.json`; summary: `05-switch-latency.txt`.

## 5. Artifact list (registered on POD-798)

All under `docs/internal/pod-798-evidence/`:

- `01-live-scale-board-ready-blocked-refs.png`
- `02-boot-backfill-member-session.png`
- `03-command-create-edit-close.png`
- `04-offline-edit-drains-1-queued.png`
- `04-offline-edit-drains-2-landed.png`
- `05-switch-latency.json` · `05-switch-latency.txt`
- `runtime-trace.zip`
- `runtime-verifier.ts` (driver for 01–03)
- `pod-798-evidence.md` (this document)
