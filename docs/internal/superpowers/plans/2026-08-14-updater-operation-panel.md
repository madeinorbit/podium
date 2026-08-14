# Update operation panel — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §6, §7, P2/P5
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** Update operation choreography. Replaces the retired top-level bug POD-2091.

**Goal:** The client becomes a renderer of the operation: one panel, one toolbar
indicator, collapse-not-dismiss, one primary action per state, reload as a step the user
takes, and the three competing progress models plus the in-button wait loops deleted.

**Owns:** `apps/web/src/features/updates/**` (rewrite), `apps/web/src/app/UpdatePrompt.tsx`,
the bottom status-bar integration, `apps/web/src/app/WireSkewBanner.tsx` (remedy only),
`apps/web/src/features/setup/version-guard.ts` (post-reload explanation only). Not
Settings (separate issue), not Rust.

## Context

- Current pieces and their pathologies are catalogued in spec §1: `dismissed` as component
  state (`UpdateDialog.tsx:33`), `viewKey` dismissal semantics (`:24-38`), three progress
  sources (`use-update-state.ts:337-357` vs `update-view.ts:349-353` vs server),
  `waitForWebIdentity` 300×1s and `waitForCompatibleWebBuild` 120×1s inside a button,
  up to three co-equal primary buttons (`use-update-state.ts:508-526`), four dismiss
  labels, `installUpdate` rejections lost in `runAction`'s try/finally (`UpdateDialog.tsx:65-73`).
- Keep: the non-modal bottom-right `aside`, the place-language copy generator
  (`update-view.ts` place rows), the service-worker plumbing as an *input*, the existing
  poll infrastructure (`usePolledQuery`) now pointed at `operations.active`.
- The status bar: locate the bottom toolbar component (`apps/web/src/app/` shell — the
  same bar that hosts connection status); add the indicator there.

## Tasks

- [ ] **View model** — new pure `operationView(operation, offer, localBuild, surface)` →
  one of `offer | running | waiting-you | waiting-elsewhere | done | failed | none`, with:
  the step checklist (done/current/pending + substatus lines from `places` and
  `lastProgressAt`), the single primary action for this surface, the liveness line
  ("downloading 62%" / "no progress for 40 s" — computed from `updatedAt` vs render
  clock), and the collapsed-indicator variant (`idle-dot | animating | attention`).
  Everything §6.2/§6.3 lives here, table-tested with vitest + happy-dom, including the
  §8 rows that concern rendering (old bundle renders unknown fields — feed it a payload
  with extra fields).
- [ ] **State hook slims down** — `use-update-state.ts` keeps: polling
  `operations.active` + the offer facts (`/version` target when no operation),
  service-worker `needRefresh` as an input to the local-action fact, the Tauri bridge
  surface detection, and the action dispatchers (`updates.start`, `updates.retry`,
  `operations.cancel`, `reload()`, `bridge.installUpdate()`). Delete:
  `waitForWebIdentity`, `waitForCompatibleWebBuild`, all client-side done/total
  computation, optimistic in-progress fabrication. Poll at 1 s while an operation is
  active, 30 s idle (reuse `FLEET_POLL_MS` constants).
- [ ] **Panel** — render the view model. One dismiss verb ("Hide") in every state; Hide
  collapses to the indicator and nothing else. `failed` renders the typed error's three
  layers (message / next action / collapsed technical detail incl. operation id).
  **Catch every action rejection** and surface it through the failed rendering — this
  closes the swallowed `installUpdate` bug (retired POD-2091): `runAction` gets a catch
  that feeds a local action-error into the view model.
- [ ] **Toolbar indicator** — always rendered while an offer or non-terminal operation
  exists (or a failed one not yet acknowledged): dot / animated / warning per view model;
  click toggles the panel; `aria-label` states the situation ("Update available",
  "Update running: step 2 of 4", "Update failed"). Collapse state is per-tab UI state —
  losing it on reload is fine because the indicator always comes back from server truth.
- [ ] **Reload as a step** — in `waiting-you`, primary **Reload** calls the existing
  `reload()`; the panel names the consequence ("reloads this page, about 2 seconds; your
  sessions keep running"). After reload, the rejoin path (fetch active operation, same
  id) must render the same panel at the later step — verify in the runtime drive.
- [ ] **Skew banner remedy** — `WireSkewBanner` button opens the panel (dispatch the
  same toggle the indicator uses) instead of prescribing its own remedy text; the banner
  itself stays as the backstop. `version-guard.ts`: when the reload budget was spent, the
  post-reload panel explains what happened (read the counter, one sentence in the view
  model) — no behavior change to the guard itself.
- [ ] **Delete the second prompt** — `UpdatePrompt.tsx`'s sonner/toast path collapses
  into the panel inputs; `__PODIUM_CHECK_UPDATES__` keeps working (opens the panel and
  triggers `updates.checkNow`).

## Testing

View-model tables (every state, every surface, unknown-field payload, absent-field
payload); panel interaction tests (hide → indicator → reopen; failed → try again;
action rejection surfaces). Gates: typecheck, `bun run test:related -- <changed>`,
`bun run test`. Then the real drive (`docs/agents/driving-podium.md`): available →
applying → your-turn → done in one panel with zero unexplained dialogs; induce a failure
and dismiss it; hide mid-update and recover via the indicator. Screenshot the four
states into `docs/design/update-dialog/` replacements and attach them to your issue
(`podium issue artifact`).

## Acceptance

- The literal complaints from the epic brief are each demonstrably closed in the drive:
  hidden panel recoverable; progress shows liveness; step names visible; one linear flow;
  no second dialog after the server restart; errors human-first with details collapsed.
- `grep`-level: `waitForWebIdentity`, `waitForCompatibleWebBuild`, and the client-side
  done/total math are gone from `apps/web`.
