# Exact-tip correction — 2026-08-28

## Status

The five rows appended by ccce8b4c2 are preserved as historical context, not current acceptance evidence. Their runtime rows pin b3343f39a, and their parent-launch rows were measured before the required current tip eee8b18cf3cce848ef6e54b46cafa738fc7db7b0.

The exact current tip is eee8b18cf3cce848ef6e54b46cafa738fc7db7b0. No stale row was edited or relabeled.

## Exact-tip gate

At 2026-08-28 06:27:11 CEST, before any new cell: root had 5,222,456 KiB free (about 4.98 GiB, 98% used), MemAvailable was 6,613,236 KiB, SwapFree was 36,811,868 KiB, and load was 8.18/7.31/5.39. The standing brief's approximately 5 GiB floor therefore held the runtime drive. No server, web bundle, daemon, named instance, or provider session was started, and no positive control or spawn-time pin exists for this attempt.

There was no existing web bundle stamped from eee8b18cf3cc. A fresh web build was not attempted below the disk floor. POD-2773 therefore remains unmeasured at the exact tip; the b3343f39a rows are historical only.

## Static exact-tip boundary

- POD-2604: parent 6c6689046 has no state.error.detail propagation in apps/server/src/modules/interactions/synthesis.ts; fix dac2f0c0981 adds it and eee8b18cf3cc retains the path. The parent predates ab9d698ab, so a named parent arm cannot launch.
- POD-2637: parent c1d69321b has no production terminalEvidence path; fix 27f1336190 adds it and eee8b18cf3cc retains its consumers. The parent predates ab9d698ab, so a named parent arm cannot launch.
- POD-2761: parent a841ade740 checks hasMaster(record.label) before spawn; fix 3c4d9a297 uses session.adopted after spawn and eee8b18cf3cc retains that path. The parent predates ab9d698ab, so a named parent arm cannot launch.

These are bounded static facts only. They do not substitute for a runtime control.

## Superseding rows

The rows below append current-tip status without changing the historical rows.

what	driver	verdict	commit	control	alone	date	issue
POD-2604 exact-eee parent boundary recheck; named parent launch held by the disk gate and pre-ab9 socket boundary	static-audit	BLOCKED; no fresh runtime because root free was below the 5 GiB floor; parent named arm remains unavailable	eee8b18cf3ccce848ef6e54b46cafa738fc7db7b0	no — no server/daemon/session positive control started	n/a — no instance; default fenced; no server/web/daemon spawn pins	2026-08-28 06:27:11 CEST	POD-2604
POD-2637 exact-eee parent boundary recheck; named parent launch held by the disk gate and pre-ab9 socket boundary	static-audit	BLOCKED; no fresh runtime because root free was below the 5 GiB floor; parent named arm remains unavailable	eee8b18cf3cce848ef6e54b46cafa738fc7db7b0	no — no server/daemon/session positive control started	n/a — no instance; default fenced; no server/web/daemon spawn pins	2026-08-28 06:27:11 CEST	POD-2637
POD-2761 exact-eee parent boundary recheck; named parent launch held by the disk gate and pre-ab9 socket boundary	static-audit	BLOCKED; no fresh runtime because root free was below the 5 GiB floor; parent named arm remains unavailable	eee8b18cf3ccce848ef6e54b46cafa738fc7db7b0	no — no server/daemon/session positive control started	n/a — no instance; default fenced; no server/web/daemon spawn pins	2026-08-28 06:27:11 CEST	POD-2761
POD-2773 exact-eee opencode streaming arm	opencode-server	UNMEASURED; fresh exact-tip runtime held by the disk gate; b3343f39a row is historical only	eee8b18cf3ccce848ef6e54b46cafa738fc7db7b0	no — no exact-tip durable control fired	n/a — no named instance and no server/web/daemon spawn pins	2026-08-28 06:27:11 CEST	POD-2773
POD-2773 exact-eee grok streaming arm	grok-acp	UNMEASURED; fresh exact-tip runtime held by the disk gate; b3343f39a row is historical only	eee8b18cf3ccce848ef6e54b46cafa738fc7db7b0	no — no exact-tip durable control fired	n/a — no named instance and no server/web/daemon spawn pins	2026-08-28 06:27:11 CEST	POD-2773
