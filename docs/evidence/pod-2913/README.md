# POD-2913 — review-queue drives

This report records only evidence taken for the nine landed-but-never-driven
children named by the 2026-08-26 23:19 CEST review-queue audit. A finding that
cannot establish the required pre-fix boundary is recorded as UNDRIVEN; no
repair is included here.

## Protocol

Each scored drive must reproduce the symptom at the parent of the listed fix,
then show it gone at the epic tip. The server, web bundle, and daemon must be
pinned to the same commit before each reading; the daemon pin is the SHA written
at process spawn. Each drive also needs a positive control and one isolated,
named instance.
The POD-2691 process/tracker cell has no product runtime to start; its measured surface is the /proc census and tracker state.

## Findings


### POD-2298 — defect gone

The parent arm was retaken after the earlier disk-full-window reading was
discarded. It used fresh named instance 'p2913-2298p2' with server and daemon
both pinned to 'c203cec50aab6e32e1629463b9e33042210cf505'; the spawn-time pin
files agree and the daemon ran with 'PODIUM_RUNTIME_CONTRACT=1'. No web bundle
was used because this is a server/daemon-only receipt-ledger behavior. The
pre-cell check at '2026-08-27 02:37:24 CEST' reported 18 GiB free disk and
5.3 GiB available memory. At '2026-08-27 02:39:16 CEST', session
'd44658b9-7cd7-47b8-bb59-099c76534bae' was bound to 'claude-pty'; the attached
frame and 'Claude Code' startup header fired as the positive control. I
identified and killed only its exact agent child, PID 436109, before sending
marker 'P2298_LATE_REFUSAL_PARENT_DRIVEN_T5L9TK'. 'messages.send' returned
optimistic 'delivered'; the persisted transitions then showed
'message.receipt' with 'outcome=refused, refusedFor=not_running', while the
ledger row remained 'status=delivered'. This is the pre-fix symptom.

The fix arm used fresh named instance 'p2913-2298tip' with server and daemon
both pinned to 'b5c53918c5d6af54d28bafcd5ae607a30940bc6e'; both spawn-time pin
files and the server build log identify that commit. The same chat control
fired for session 'dcc592a6a-4b12-44bb-9cfa-1a2448bf9e1f'. At
'2026-08-27 01:54:26 CEST', marker 'P2298_LATE_REFUSAL_FIX_GFO43L' returned
optimistic 'delivered', then the persisted refused 'not_running' receipt was
followed by 'message.dead_letter'; the ledger row was 'dead_letter' with
'deliveryDeferredReason=delivery-failed' and 'deliveryConfirmed=false'.

The parent reproduces the optimistic-delivery lie and the tip retracts it on
the same refused receipt. Verdict: **PASS — defect gone**.


### POD-2408 — invalid listed boundary

The consumer check is positive on checkout '562620c41c620542db2abc6dab449dfc817c4c6a':
'stageRuntimeAttachment' is the default stager passed through
'apps/daemon/src/runtime/host.ts', the server command plane calls
'ctx.deps.stageAttachment' in 'apps/server/src/modules/sessions/command-plane.ts',
and 'apps/web/src/features/chat/use-attachments.ts' consumes the returned
'refusal'. The current epic branch pin is
'140f0fbd03c5e03d5e05bf8eb22da0d8271ea80c'.

The audit-listed fix 'b247c2dbf' has parent '10d5af58aa9be901105eeb2291504720e86d931b'.
At that parent, terminal, opencode, Codex, and Grok already return typed
'reason: unsupported' results from 'stageAttachment()'. The actual
throw-to-typed-refusal change is '10d5af58a' (parent
'5979159e30e8c0f2ff9f242ab64919fec6793245'), where the drivers throw before
that commit and return typed refusals after it. Therefore 'b247c2dbf^' does
not reproduce the original crash, so it cannot serve as the required pre-fix
control. Verdict: **FAIL — invalid listed boundary; no runtime drive**.


The same process/tracker probe was run against parent '7ef0f5c979b067a8be6286f8e27a868186ed3cbe' and epic tip 'b08e7d65c503c5a85e8a7d2c46d002eae5229fce' at '2026-08-27 00:39 CEST'. Parent had no UUID/guard code. Tip had the UUID definition, but the non-test consumer search was empty.
Both arms saw the positive-control sentinel and seven live agent processes in the five tracker-done worktrees for POD-91, POD-2059, POD-2291, POD-2902, and POD-2908.

At '2026-08-27 00:40 CEST', tracker checks confirmed all five stages were done; process ages ranged from 50 minutes to more than one day.

Because the tip never invokes the new guard, the same orphan process symptom remains after the fix commit. Verdict: **FAIL — still broken**.
No process was killed.

### POD-2773 — invalid pre-fix boundary; Grok unavailable

The audit names 'e38128936', whose parent is '4578be8d'. The listed commit is
docs-only ('docs/evidence/pod-2773/README.md'); the streaming implementation is
already in its parent. A probe at 'e38128936^' therefore cannot be the required
pre-fix control. Verdict: **UNDRIVEN — invalid listed boundary**.

The Grok driver is separately **UNDRIVEN** while its provider quota is
unavailable until '2026-08-27 11:03 CEST'; it produced no token. OpenCode
evidence is not used to infer Grok.

### POD-2761 — runtime gate, no reading

The exact pre-fix checkout 'a841ade7407d91e72e946d05ebd281fe59f557b6' was
prepared for the Chat → CLI → Chat → CLI Codex probe. No server, web bundle, or
daemon was started and no reading was scored because the shared test:heavy
lease was held by POD-1761. At '2026-08-27 00:26 CEST', the host reported
709 MiB free memory, 5.6 GiB available memory, load 8.87/13.08/15.12, and
16 GiB free disk; the host had active swap pressure earlier in the same gate
window. Starting a Vite build under that lease would invalidate the reading.

## Ledger

Complete rows are appended to 'docs/plans/pod-1761-results.tsv'. The remaining
children (POD-2602, POD-2604, and POD-2637) were not touched in this interval
and have no result claimed here. POD-2408 has the static boundary finding above
and no runtime drive was run. POD-2622 is handed to POD-2914;
this report does not claim a drive for it.

Last evidence update: '2026-08-27 03:04:17 CEST'.
