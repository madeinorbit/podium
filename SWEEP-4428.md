# SWEEP-4428 — Legacy PTY path: every hit deleted or justified

Scope: POD-4414 Phase 0 step 3. Base: the integration branch with POD-4426 +
POD-4427 landed. Seed: the DONE WHEN greps from VERIFY-4426.md and
VERIFY-4427.md, re-run here, then widened per the issue plus the 0.R review
(POD-4479) leftovers.

Method: every grep below was run with `rg -n` (no `-r`, which would mean
`--replace`). "DELETED <sha>" names the commit removing the hit; "KEEP" carries
the one-line reason. Zero TODO rows.

## 1. POD-4426's DONE WHEN grep (daemon scope) — 0 hits, re-verified

```
$ rg -n "PODIUM_RUNTIME_CONTRACT|PODIUM_RUNTIME_DRIVER|runtimeContractEnabled|runtimeContract\b" apps/daemon packages/protocol packages/agent-runtime
rg-exit=1 (no matches)
$ ls apps/daemon/src/runtime/flag.ts
(absent)
$ rg -n "RuntimeContractRequest|RUNTIME_DRIVER_ENV|runtimeDriverByEnv|runtimeDriverFor" apps/daemon packages/protocol packages/agent-runtime
rg-exit=1 (no matches)
```

The flag module, both env switches, and the `runtimeContract` wire field are
gone from daemon, protocol and agent-runtime.

## 2. POD-4427's DONE WHEN greps (server inbox scope) — 0 hits, re-verified

`inbox.ts` (2609 lines at Phase-0 base → 1747): READY_POLL_MS,
SUBMIT_CR_DELAY_MS, MAX_DELIVERY_ATTEMPTS, RETRY_BACKOFF_MS, CONFIRM_POLL_MS,
routesThroughContract, legacyDeliveryBatches, typeText, scheduleSubmitVerify,
attemptDelivery, readyForInput, confirm( — all 0. contract-delivery.ts absent.
`rg -n "daemon-headed-delivery" .` excluding .git → 0.

## 3. Widened `legacy` sweep — per file

`rg -n -i "legacy" apps/server/src/modules/sessions apps/daemon/src/control
apps/daemon/src/runtime packages/agent-runtime/src` (280 hits). Every hit is
KEEP — none is the deleted delivery loop:

- A different rollout's "legacy", not the PTY delivery path — KEEP:
  keychain fallback (claude-keychain-credential-store, credentials), the
  sessions.rename rollout POD-380 (rename-adapter, rename-target-path,
  rename-shadow, trpc LEGACY_PATH_VALUE), Draft Sync v2 POD-859
  (store/sessions.ts:1042 versioned vs unversioned drafts), the legacy
  HEADLESS port POD-4392 (headless-driver x11, headless-turn, turns,
  session-spec, machine-runtime:221), issue-mail nudge + IssueWire
  (issue-mail-nudge, publication/broadcast), the W4 receipt-seam vocabulary
  (messages/service.ts:311,1516, characterization-support.ts,
  receipt-send.guard.test.ts:41-47, answer-delivery.ts:44, lifecycle.ts:278).
- Deliberate mixed-version / old-row compatibility — KEEP: old-daemon frames
  (daemon-lifecycle agentExit/unfenced/open-url shims, "older daemons omit
  driverId" at :441 — the upgrade premise), pre-migration rows + unfenced
  path for mixed deployment (session.ts:96,113,701,
  observation-leases.ts:48), the migration pins themselves
  (archive-park.test, session-start.test "legacy selected-driver lifecycle
  compatibility", inbox.test legacy-attempts cases,
  inbox-gateway-delivery.test header), old-client/old-daemon wire frames
  (terminal.ts legacyRequest, viewport-request.test, session.test legacy
  clients, daemon-projection tap+legacy dual-send, runtime-event-gate,
  runtime-transcript, codex/opencode-driver legacy frames,
  session-state/service legacy setSessionDraft, command-ctx mailSendInput,
  session-start in-process fallback, stop.test wording, command-plane
  upload leg, session-wiring ports, repository snapshot/observation,
  durable-write-ordering, receipt-reconciliation fixture,
  control/session.ts issue-relay env + launch test seam + createTerminal
  survivor note + throw-now note + observer state,
  control/transcripts.ts, native-terminal-input.ts,
  control/context.ts argv seam, control/exec + inventory guard comments,
  registry.ts:137 legacy-row driver preference,
  session-plain-terminal.test history note, conformance test agentState
  note, headless-driver.test note).
- The surviving seam's own vocabulary (the inbox API driverless sessions
  still use) — KEEP: receipt-send.ts legacy ports ("Shells keep the legacy
  verbs"), receipt-send.guard.test.ts LEGACY_CALL map, lifecycle.ts:291,
  session-wiring.ts:876 (the TURN PREVIEW switch POD-2293, still live).
- Port notes recording where the surviving driver code came from — KEEP
  (history, not a second path): terminal-driver abortKeyFor/answer-script
  comments, injection.ts:121, terminal.test.ts pins, registry.ts:51,
  opencode-driver.ts:33 default-path note, codex-app-server.test socket-dir
  bounds, handlers.ts:72 hazard statement, thread-start.json provider enum.
- The mixed-peer input adapter — KEEP: control/legacy-terminal-input.ts
  REFUSES automation bytes for contracted sessions and keeps byte transport
  for shells/older unbound hosts (the filename is historical; renaming would
  churn 4426's lane for no behavior gain).
- POD-4440's, recorded not renamed (coordinator scope note) — KEEP, see §6.

## 4. injectionPayload / claudePromptHookFingerprint under apps/server

inbox.ts:43,1690,1700 + paste.ts:57 — KEEP: the envelope constructor is now
exclusively the shell raw-transport constructor (sendShellText + CR, no
timers). No harness delivery uses it. claudePromptHookFingerprint: 0 hits
under apps/server (lives in packages/harness agent-state — the hook receipt
that replaced polling, KEEP by design).

## 5. flag-off / until-W4 mentions (45 hits)

Historical plan/spec records, not code — KEEP: docs/agents/
pod-378-tanstack-retirement.md, pod-1239-attribution-gate-caller.md,
docs/internal/pod-796-ab-report.md,
docs/investigations/POD-1204-chat-send-held-by-stale-draft.md,
docs/superpowers/specs/2026-07-17-draft-sync-v2-design.md,
docs/plans/pod-2022-receipt-migration.md,
docs/plans/pod-1761-agent-runtime-plan.md,
docs/plans/pod-1761-results.tsv + pod-1761-release-ledger.md (dated run
conditions, not instructions).
A different flag's "off" — KEEP: client-core engine/runtime + socket-hub,
web MachinesPanel/updates/Workspace, cli issue-cli parser test,
relay.test.ts:5348 (drafts rollout), session-wiring.ts:876 (preview switch),
store/sessions.ts:1042 (drafts v2).
W4 receipt-seam vocabulary for the surviving direct-verb path — KEEP (§3).
- packages/agent-runtime/src/drivers/terminal/injection.ts — DELETED the
  "server copy authoritative until W4" paragraph; this file is now the only
  harness-delivery copy.
- apps/server/src/modules/sessions/paste.ts — DELETED the "until W4 retires
  the server's copy" paragraph; the file is the shell-transport envelope +
  shared sanitize rule.
- apps/server/src/modules/sessions/lifecycle.ts — DELETED "No caller routes
  through it until W4" (callers do) and "flag-off implementation" (now
  "driverless-session implementation").
- apps/server/src/modules/sessions/turn-preview-flag.ts — DELETED the
  PODIUM_RUNTIME_CONTRACT framing + dead flag.ts pointer; the machine-switch
  rationale stands on its own (coordinator mail item 2).
- apps/web/src/features/setup/ColdStartComposer.tsx — DELETED live sender of
  the deleted field: the driver picker sent `runtimeContract`, which the
  server zod-strips, silently dropping the choice; now sends
  `requestedDriverId` (test pins both the positive key and the absence of the
  old one). NOTE: filed separately as POD-4487 after this fix landed here;
  kept here, recommend closing that as already-fixed.
- apps/web/src/features/chat/use-attachments.ts — DELETED "live runtime
  contract" phrasing (now "live driver").
- packages/harness/src/manifest.ts — DELETED stale spawn field in the
  headless-driver comment (now requestedDriverId).
- tests/e2e/browser/native-view-latency.browser.e2e.ts — DELETED env read +
  dead report fields (unlaned file; driver assertion now unconditional).
- apps/server/src/relay.ts — DELETED "headed text-delivery rollout ...
  legacy inbox script" sentence (predicate itself is POD-4440's).
- apps/server/src/superagent-headless.test.ts — DELETED stale field name
  (requestedDriverId headless, matching the assertion below it).
- docs/runtime/native-terminal-boundary.md — REWROTE "Migration boundary" as
  retired-history + permanent rule (batches, rollout, switch all deleted).
- docs/architecture/pod-2413-resource-isolation.md — DELETED switch name
  (isolation unconditional; terminal family means a bound driver).
- docs/agent-harness-reference/claude.md,
  docs/architecture/claude-subscription-oauth-policy.md,
  docs/agents/pod-1761-standing-brief.md (x2) — REWORDED credential-safety
  advice to requestedDriverId (prohibition stands, deleted var gone).
- docs/plans/pod-2021-terminal-driver.md — DELETED whole plan (superseded by
  the built driver + this sweep).

## 6. runtimeContract repo-wide (POD-4440 owned + deliberate pins)

session.runtimeContract (session.ts:424, derived at daemon-lifecycle.ts:434
as `msg.driverId !== undefined`) and its ~10 readers (relay contractRouted,
daemon-projection, session-wiring, command-plane, session-state, messages
service, receiptSender.onContract) plus inbox.ts:560 (Grok-ACP recovery
predicate, also guarded by agentKind + driverId — not a delivery path) —
KEEP, owned by POD-4440 (0.5 Derived contract field named as a switch). This
issue touches none of them for naming reasons. Deliberate pins:
session-start.test.ts:549 (reattach must NOT carry runtimeContract —
one-field rule), command-plane.test.ts:247 (a `runtimeContract: true` input
does NOT parse into requestedDriverId — old clients' boolean is dropped),
command-plane.ts:240 (absence is the point, POD-2113),
model/entities/session.ts:533 (already the new "requested runtime contract"
vocabulary).

## 7. Web "runtime contract" sweep

`rg -n -i "runtime contract" apps/web/src packages/model/src` → only the
model comment above (KEEP, new vocabulary) after the ColdStartComposer fix.
NewPanelMenu was already migrated by POD-4427. The remaining driver-picker
vocabulary ('Headed (driver contract)', the runtime-drivers experiment gate)
is POD-4429's UI lane — noted to them, not renamed here.

## 8. DONE WHEN 2 greps (repo-wide, excluding .git)

- Seed deletion symbols (env switches, wire field, delivery-loop symbols,
  daemon-headed-delivery): 0 hits outside .git.
- `runtimeContract`: only the §6 POD-4440 set + deliberate pins (listed).
- `injectionPayload` / `claudePromptHookFingerprint`: only the §4
  shell-transport + harness-receipt uses (listed).
- English `legacy` / `flag-off`: only the §3/§5 KEEP groups (listed).

Zero TODO rows.
