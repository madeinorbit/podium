# Phase-3 policy completion evidence

**Run:** 2026-08-01  
**Candidate:** `4bca542609d4278b14cb44c5fae58ac8d9a15f03` (`issue/1283-phase-3-policy-completion`)  
**Verdict:** **PASS — the POD-424 production-policy refusals are closed.**

This rerun targets the production registries, authenticated HTTP/MCP entry points, durable stores, scoped feed, and browser kernel Outbox. Policy doubles remain useful unit coverage, but no closure below relies on an injected principal or permissive port standing in for a missing production path.

## Closure register

| POD-424 refusal | Production closure |
|---|---|
| Ambient OPERATOR on human transports | Authenticated accounts mint distinct user principals. tRPC and MCP resolve the authenticated account; mail and workflow commands carry the effective principal and transport-stamped attribution pair. Cross-transport lifecycle coverage lives in `apps/server/src/issue-lifecycle-authz-transports.test.ts`, with production mail and workflow coverage in their multi-user suites. |
| Missing sharing and rescope | Owner-only `issues.share` / `issues.unshare` and `machines.share` / `machines.unshare` persist attributed grant edges. Issue revocation emits scoped rescope/evict, and direct machine ownership is required to delegate even when another user has `manage`. |
| Single-user ownership defaults | Issue, superagent, per-user state, machine discovery, mail, and workflow paths read current ownership and grants. Superagent durable rows are owner-keyed and private; POD-1209 can consume the completed ownership model. |
| Automation attribution | Automations persist their creator. Scheduled execution re-resolves that creator and enforces current issue and machine rights rather than retaining stale authority. |
| Ambient system writes | Steward, expiry, and boot-reconcile jobs construct named system principals and persist system attribution with no human on-behalf-of value. |
| Legacy web outbox | The web engine uses the kernel IndexedDB Outbox. A real authenticated two-user browser run proves that a queued rename denied after revocation becomes a dead letter and that retry, edit, and discard operate through the production recovery UI. |
| Router escape hatches | `apps/server/src/router.ts` contains zero hand-written `.mutation(` procedures. Both POD-313 and POD-314 deletion-audit items are zero. |
| Normalized feed bootstrap gap | `FeedChange` carries all eight normalized entity arms. Expected bootstrap reconnects preserve the waiter, while unexpected socket closure disconnects the replica. The two-user browser receives the shared issue and sessions through the authenticated production slice. |

## Counterfactual source probes

Every original POD-424 source probe was rerun as its probe-plus-live package script. All exited 0:

- `bun run audit:sessions` — five planted violations fired; production tree clean.
- `bun run audit:router-mutations` — parser plus four checks fired; zero hand-written mutations.
- `bun run audit:mail` — all 17 probes agreed; production authz has one door.
- `bun run audit:workflows` — all six probes fired; production ledger has one door.
- `bun run audit:machine-grants` — every check fired and clean controls stayed silent.
- `bun run audit:telegram-binding` — all three checks fired; unbound chats fail closed.
- `bun run audit:scoped-feed` — all probes fired; revocation uses rescope/evict rather than unscoped removal.
- `bun run audit:settings` — parser and all five checks fired; zero named hand-written writes.
- `bun run audit:automations` — all six checks fired; production surface clean.
- `bun run audit:client-secrets` — all secret checks fired; zero POD-421-owned residual sites.
- `bun run audit:durable-classes` — every check fired; all 89 durable stores classified or explained.
- `bun run audit:rearch --phase POD-313` — one of one item at zero.
- `bun run audit:rearch --phase POD-314` — one of one item at zero.

## Runtime acceptance

The browser acceptance used two genuinely authenticated accounts (`user:sole` and `user:phase3-member`) and production RPC/feed paths. The owner created an issue, granted issue write and machine use, and started two sessions. The member received the scoped normalized feed, queued a rename while only the rename transport was interrupted, then lost the issue grant. Reconnection produced a real authenticated `sessions.rename` refusal and a kernel dead letter. The UI then exercised retry, edit-and-send, and discard over three independent refusal cycles.

Command:

```text
PODIUM_PASSWORD=phase3-owner-password npx playwright test browser/session-rename-skeleton.browser.e2e.ts --config .phase3-playwright.config.ts --project=chromium-desktop --grep "kernel Outbox dead-letter" --timeout=240000
```

Result: **1 passed** in approximately 60 seconds. Review frames:

1. `01-live-authorization-dead-letter.png` — live authorization refusal parked by the kernel Outbox.
2. `02-edit-recovery-before-send.png` — edit recovery before the replacement send.
3. `03-discard-recovery-before-cancel.png` — discard recovery before cancellation.

## Verification summary

- Focused fleet, feed sink/protocol/composition coverage: **100 tests passed**.
- Hub-role completeness plus regenerated protocol golden/feed schema: **129 tests passed**.
- `bun run test`: Node **620 files / 9,149 passed / 19 skipped**; web **182 files / 1,456 passed**; mobile **4 files / 34 passed**; Bun SQLite **14 passed**.
- `bun run typecheck`: all **26 packages** passed.
- `bun run test:multi-instance`: independent-runtime isolation **1 passed / 25 assertions**; managed-account spawn **3 passed**; installer isolation **ALL OK**.
- `git diff --check`: clean.

The earlier aggregate-load timeout recorded as POD-1308 did not recur in the serialized final run and is not used to waive any gate result.
