# POD-329 post-cutover UI-state consolidation evidence

## Preconditions

- POD-404 complete: `engine.ts` / `connection.ts` deleted; provider is the principal-scoped composition root.
- POD-403 complete: single hydrate/flush path and one-shot legacy Workspace migration live in `packages/client-core/src/ui-state.ts`. This issue did **not** add a second persistence path or reimplement that migration.

## What landed

### One panelMode model + one derivation

- `effectivePanelMode` in `packages/client-core/src/ui-state.ts` is the sole chat-vs-native derivation (saved map → personal default → startScreen → mobile heuristic).
- `AgentPanel` consumes it and materializes the result into the store map on first open; `pickMode` writes the same map.
- Storage-key spellings of `podium.panelMode` / `podium.panelModeDefault` live only as the two owner declarations in `ui-state.ts` (panel-mode-duality audit: **2 → 0**).

### Routing table totality

- Workspace keys, client device-local keys (including debug flags and sound owner election), theme pre-auth exception, and known-unrouted non-UI keys (`superfeed` cursor, wire reload counter, legacy outbox blob) are classified.
- `uiStateRoute` throws on any unclassified key (default-closed).
- panelMode / panelModeDefault recorded as **per-user-replicated** with reason coordinated with POD-1076 layout family (personal tab presentation, not screen geometry).
- Superagent open state remains per-user-replicated (doc §3.1.6 S2).
- Theme remains the only pre-auth raw exception.

### Stragglers folded

| Former site | Disposition |
| --- | --- |
| `apps/web/.../file-panel-mode.ts` | Thin re-export from ui-state |
| `apps/web/.../shell-state.ts` key literals | Import from ui-state |
| `apps/web/.../EchoHud.tsx` | Reads `ECHO_HUD_KEY` via principal-scoped ui-state |
| `apps/web/.../outbox.ts` `localStorageBacking` | Removed; storage must be `replica.outboxStorage()` |
| `notification-sounds` owner election | Uses ui-state collection, not raw localStorage |
| `switch-trace` debug flag | Bound from runtime ui-state; URL query remains |
| terminal-client gpu/debug | URL-only (no raw localStorage) |
| Web `podium.*` key literals | **11 → 0** (centralized in ui-state / model) |

### Ownership lint

`packages/client-core/src/ui-state.audit.test.ts`:

- Owned-key raw localStorage access outside ui-state fails.
- Method-level `localStorage` / `AsyncStorage` access outside ui-state and the replica adapter / platform composition roots fails.
- Theme is the only pre-auth home (forward and reverse).

### Principal namespace

Existing cursor/collection isolation tests plus a planted **foreign ui-state blob** test: Bob never adopts Alice's `panelMode` / `view`.

### Migration verification

POD-403 one-shot path unchanged; browser e2e confirms planted `podium.panelModeDefault` is consumed and deleted, and panes/splits/tabs survive reload.

## Enforcement instrument (the part that outlives the consolidation)

**Rule:** `ui-storage-ownership` in `scripts/check-boundaries.ts`, wired into both
`checkFile` (legacy `lint:boundaries`) and `checkManifestFile` (`lint:architecture`
/`--manifest-only`) so a continue-on-error full lint cannot sail past a new raw call.

**Sanctioned files** are an exact-path set with a POD-1251-style comment: the next
entry must be a composition root that injects `StorageApi` into `createReplica`
(or its AsyncStorage twin), never a feature surface.

### Observed refusal (real exit codes)

Planted in `apps/web/src/features/terminal/EchoHud.tsx`:

```ts
export function __pod329Plant(): string | null {
  return localStorage.getItem('podium.echoHud')
}
```

| Run | Command | Exit | Verdict line / named hit |
| --- | --- | --- | --- |
| Planted | `bun run lint:boundaries` | **1** | `[ui-storage-ownership] apps/web/src/features/terminal/EchoHud.tsx: …` (both NEW architecture-manifest + Dependency-boundary) |
| Removed | `bun run lint:boundaries` | **0** | `boundaries OK (…) — 6 allowlisted, 0 new` |

Allowlisted `[agent-host-consumers] …` warn lines printed above the OK verdict are
**not** failures (read exit code + verdict line).

### Mutants that fired

| Mutant | Instrument | Result |
| --- | --- | --- |
| Feature `localStorage.getItem` plant (EchoHud) | `lint:boundaries` | exit 1, rule + file named |
| Unit: feature method call / AsyncStorage.setItem | `check-boundaries.test.ts` | rule fires |
| Unit: wired through `checkFile` | same | rule present in violations |
| Rogue third `'podium.panelMode'` literal in `ui-state.ts` | `audit:rearch` panel-mode-duality | baseline 0→1, exit 1, site named |

### Mutants that did **not** fire (reported)

| Mutant | Expected? | Notes |
| --- | --- | --- |
| Comment containing `localStorage.getItem` | Yes (silent) | `stripComments` — documenting the rule must not trip it. exit 0. |
| Bare `typeof localStorage` (no method call) | Intentional method-only scope | exit 0. Gap: indirect `const s = localStorage; s.getItem(…)` also stays silent — method-only regex cannot see it. Accept as residual; composition-root injection still needs a bare reference to pass the object. |
| Allowed files (`ui-state.ts`, `async-storage.ts`) | Yes (silent) | unit-tested |

## Verification

| Lane | Result |
| --- | --- |
| `ui-state` + audit + principal-storage unit tests | pass |
| `panel-mode`, `file-panel-mode`, `outbox`, web `ui-state` tests | pass |
| `notification-sounds` unit | pass |
| `check-boundaries` ui-storage-ownership unit | pass (6) |
| `bun run lint:boundaries` clean | exit 0, 6 allowlisted, 0 new |
| `bun run typecheck` | 22/22 (report Cached: line on tip) |
| `bun scripts/rearch-audit.ts` | panel-mode-duality 0, web-storage-keys 0; known integration red `representation-registry-rot` is POD-1385's, not this issue |
| Playwright `ui-state-persistence` — pane/split/dock/migration reload | pass |
| Playwright `ui-state-persistence` — chat↔native mode switch + reload | pass |

## Constraints held

- No `instance_id` on the client (ADR 1 D5).
- No per-user state tables or commands built here (POD-1076 / POD-402).
- No second hydrate/flush/migration path (POD-403 ownership).
- Single-user parity: one admin, same UX as before.
