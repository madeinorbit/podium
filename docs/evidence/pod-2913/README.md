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
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
The POD-2691 process/tracker cell has no product runtime to start; its measured surface is the /proc census and tracker state.

## Findings


### POD-2298 — defect gone

<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 562620c41 (docs: refresh POD-2298 parent drive evidence)
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
<<<<<<< HEAD
=======
The parent arm used named instance 'p2913-2298b' with server and daemon pinned
to 'c203cec50aab6e32e1629463b9e33042210cf505'; the daemon pin was recorded at
spawn with 'PODIUM_RUNTIME_CONTRACT=1'. No web bundle was used because this is a
server/daemon-only receipt-ledger behavior. At '2026-08-27 01:47:03 CEST',
session '26f88d3b-b52e-4046-bbcb-b456e226b1c9' was bound to 'claude-pty' and
the chat control 'Welcome to Claude Code' fired. Sending marker
'P2298_LATE_REFUSAL_PARENT_TDV1FG' returned optimistic 'delivered'; the
persisted transitions then showed 'message.receipt' with
'outcome=refused, refusedFor=not_running', while the ledger row remained
'status=delivered'. This is the pre-fix symptom.
>>>>>>> 314ea0caa (docs: record POD-2298 drive result)
=======
>>>>>>> 562620c41 (docs: refresh POD-2298 parent drive evidence)

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


<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
### POD-2408 — defect gone

The consumer check is positive: daemon 'stageRuntimeAttachment' is wired through
'apps/daemon/src/runtime/host.ts', the server command plane calls
'ctx.deps.stageAttachment' in 'apps/server/src/modules/sessions/command-plane.ts',
and 'apps/web/src/features/chat/use-attachments.ts' consumes a returned
'refusal'. The review audit's marker 'b247c2dbf' was mislabeled: it is the
staging feature commit, whose parent already contains typed refusals. The
actual throw-to-typed-refusal boundary is '5979159e30e8c0f2ff9f242ab64919fec6793245'
-> '10d5af58aa9be901105eeb2291504720e86d931b'.

The exact parent arm used named instance 'p2913-2408-parent' and probe directory
'/tmp/pod-2913-2408-parent.xv1Gk7'. Its daemon and fake-server spawn-time pin
files both contained '5979159e30e8c0f2ff9f242ab64919fec6793245'; the web bundle
was explicitly 'n/a' because this is the server/driver contract cell and neither
boundary commit changes 'apps/web'. At the '2026-08-27 03:21:30 CEST' resource
check there were 17 GiB free disk, 4.3 GiB available memory, and load
5.30/8.37/11.02. The fake app-server positive control fired: one launch, a live
server, and thread 'thr-p2913-2408-parent' bound session
'p2913-2408-parent-session'. 'stageAttachment' reproduced the raw
'Error: codex-app-server does not stage attachments: no upload channel is exposed'.

The exact fix arm used named instance 'p2913-2408-fix' and probe directory
'/tmp/pod-2913-2408-fix.gYh1Rt'. Its daemon and fake-server spawn-time pin
files both contained '10d5af58aa9be901105eeb2291504720e86d931b'; the same positive
control fired with thread 'thr-p2913-2408-fix' and session
'p2913-2408-fix-session'. At the '2026-08-27 03:24:28 CEST' resource check
there were 17 GiB free disk, 4.0 GiB available memory, and load
5.55/7.12/10.05. 'stageAttachment' returned the typed refusal
'{ reason: unsupported, detail: Codex attachment staging is not wired to its local-image input }'.

The current epic tip was also driven with named instance 'p2913-2408-tip' and
probe directory '/tmp/pod-2913-2408-tip.zwtqG7'. Its daemon and fake-server
spawn-time pin files both contained 'a3d702adcccb133f8fc09f44ccc5cb8b5404abb1';
the web bundle was explicitly 'n/a' for the same reason. At the
'2026-08-27 03:28:15 CEST' resource check there were 17 GiB free disk,
2.9 GiB available memory, and load 21.27/11.23/10.83. The positive control
fired again with thread 'thr-p2913-2408-tip' and session
'p2913-2408-tip-session'. The later staging feature returned a file ref and the
probe read the exact 'probe' bytes back from its isolated uploads directory.

The parent reproduces the raw throw, the exact fix returns the typed refusal,
and the landed tip successfully stages the attachment. Verdict: **PASS —
typed-refusal defect gone; later staging support also verified**. No product
repair was made.


The same process/tracker probe was run against parent '7ef0f5c979b067a8be6286f8e27a868186ed3cbe' and epic tip 'b08e7d65c503c5a85e8a7d2c46d002eae5229fce' at '2026-08-27 00:39 CEST'. Parent had no UUID/guard code. Tip had the UUID definition, but the non-test consumer search was empty.
Both arms saw the positive-control sentinel and seven live agent processes in the five tracker-done worktrees for POD-91, POD-2059, POD-2291, POD-2902, and POD-2908.

At '2026-08-27 00:40 CEST', tracker checks confirmed all five stages were done; process ages ranged from 50 minutes to more than one day.

Because the tip never invokes the new guard, the same orphan process symptom remains after the fix commit. Verdict: **FAIL — still broken**.
No process was killed.
=======
=======
The POD-2691 process/tracker cell has no product runtime to start; its measured surface is the /proc census and tracker state.
>>>>>>> 9a1562b9e (docs: record dead agent process finding)

## Findings


<<<<<<< HEAD
=======

## Findings

### POD-2622 — invalid pre-fix boundary

>>>>>>> ca522e00e (docs: record review queue drive gates)
The audit names 'b266484d8'. Its parent is '1641d823c'. The substantive
child-environment changes are already present in the parent ancestry
('aa8cdacff' and 'aba4d4ff9'); the listed commit is a reconciliation/formatting
boundary rather than the first fix. A probe at 'b266484d8^' therefore cannot
reproduce the pre-fix symptom. Verdict: **UNDRIVEN — invalid listed boundary**.
No live yes/no result was inferred.
<<<<<<< HEAD
>>>>>>> ca522e00e (docs: record review queue drive gates)
=======
=======
>>>>>>> 314ea0caa (docs: record POD-2298 drive result)
### POD-2691 — still broken
=======
### POD-2408 — invalid listed boundary
=======
### POD-2408 — defect gone
>>>>>>> 210ad18a5 (docs: record POD-2408 controlled drive)

The consumer check is positive: daemon 'stageRuntimeAttachment' is wired through
'apps/daemon/src/runtime/host.ts', the server command plane calls
'ctx.deps.stageAttachment' in 'apps/server/src/modules/sessions/command-plane.ts',
and 'apps/web/src/features/chat/use-attachments.ts' consumes a returned
'refusal'. The review audit's marker 'b247c2dbf' was mislabeled: it is the
staging feature commit, whose parent already contains typed refusals. The
actual throw-to-typed-refusal boundary is '5979159e30e8c0f2ff9f242ab64919fec6793245'
-> '10d5af58aa9be901105eeb2291504720e86d931b'.

The exact parent arm used named instance 'p2913-2408-parent' and probe directory
'/tmp/pod-2913-2408-parent.xv1Gk7'. Its daemon and fake-server spawn-time pin
files both contained '5979159e30e8c0f2ff9f242ab64919fec6793245'; the web bundle
was explicitly 'n/a' because this is the server/driver contract cell and neither
boundary commit changes 'apps/web'. At the '2026-08-27 03:21:30 CEST' resource
check there were 17 GiB free disk, 4.3 GiB available memory, and load
5.30/8.37/11.02. The fake app-server positive control fired: one launch, a live
server, and thread 'thr-p2913-2408-parent' bound session
'p2913-2408-parent-session'. 'stageAttachment' reproduced the raw
'Error: codex-app-server does not stage attachments: no upload channel is exposed'.

The exact fix arm used named instance 'p2913-2408-fix' and probe directory
'/tmp/pod-2913-2408-fix.gYh1Rt'. Its daemon and fake-server spawn-time pin
files both contained '10d5af58aa9be901105eeb2291504720e86d931b'; the same positive
control fired with thread 'thr-p2913-2408-fix' and session
'p2913-2408-fix-session'. At the '2026-08-27 03:24:28 CEST' resource check
there were 17 GiB free disk, 4.0 GiB available memory, and load
5.55/7.12/10.05. 'stageAttachment' returned the typed refusal
'{ reason: unsupported, detail: Codex attachment staging is not wired to its local-image input }'.

The current epic tip was also driven with named instance 'p2913-2408-tip' and
probe directory '/tmp/pod-2913-2408-tip.zwtqG7'. Its daemon and fake-server
spawn-time pin files both contained 'a3d702adcccb133f8fc09f44ccc5cb8b5404abb1';
the web bundle was explicitly 'n/a' for the same reason. At the
'2026-08-27 03:28:15 CEST' resource check there were 17 GiB free disk,
2.9 GiB available memory, and load 21.27/11.23/10.83. The positive control
fired again with thread 'thr-p2913-2408-tip' and session
'p2913-2408-tip-session'. The later staging feature returned a file ref and the
probe read the exact 'probe' bytes back from its isolated uploads directory.

The parent reproduces the raw throw, the exact fix returns the typed refusal,
and the landed tip successfully stages the attachment. Verdict: **PASS —
typed-refusal defect gone; later staging support also verified**. No product
repair was made.

>>>>>>> 05f708469 (docs: record POD-2408 boundary finding)

The same process/tracker probe was run against parent '7ef0f5c979b067a8be6286f8e27a868186ed3cbe' and epic tip 'b08e7d65c503c5a85e8a7d2c46d002eae5229fce' at '2026-08-27 00:39 CEST'. Parent had no UUID/guard code. Tip had the UUID definition, but the non-test consumer search was empty.
Both arms saw the positive-control sentinel and seven live agent processes in the five tracker-done worktrees for POD-91, POD-2059, POD-2291, POD-2902, and POD-2908.

At '2026-08-27 00:40 CEST', tracker checks confirmed all five stages were done; process ages ranged from 50 minutes to more than one day.

Because the tip never invokes the new guard, the same orphan process symptom remains after the fix commit. Verdict: **FAIL — still broken**.
No process was killed.
>>>>>>> 9a1562b9e (docs: record dead agent process finding)
=======
>>>>>>> ca522e00e (docs: record review queue drive gates)

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
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
children (POD-2602, POD-2604, and POD-2637) were not touched in this interval
and have no result claimed here. POD-2622 is handed to POD-2914;
this report does not claim a drive for it.

Last evidence update: '2026-08-27 03:29:11 CEST'.
=======
=======
>>>>>>> ca522e00e (docs: record review queue drive gates)
children (POD-2298, POD-2408, POD-2602, POD-2604, POD-2637, and POD-2691) were
not touched in this gated interval and have no result claimed here.

Last evidence update: '2026-08-27 00:26 CEST'.
<<<<<<< HEAD
>>>>>>> ca522e00e (docs: record review queue drive gates)
=======
children (POD-2298, POD-2408, POD-2602, POD-2604, and POD-2637) were not touched
in this interval and have no result claimed here. POD-2622 is handed to POD-2914;
this report does not claim a drive for it.

Last evidence update: '2026-08-27 00:40 CEST'.
>>>>>>> 9a1562b9e (docs: record dead agent process finding)
=======
children (POD-2408, POD-2602, POD-2604, and POD-2637) were not touched in this
interval and have no result claimed here. POD-2622 is handed to POD-2914;
this report does not claim a drive for it.

<<<<<<< HEAD
Last evidence update: '2026-08-27 01:54:27 CEST'.
>>>>>>> 314ea0caa (docs: record POD-2298 drive result)
=======
Last evidence update: '2026-08-27 02:39:16 CEST'.
>>>>>>> 562620c41 (docs: refresh POD-2298 parent drive evidence)
=======
children (POD-2602, POD-2604, and POD-2637) were not touched in this interval
and have no result claimed here. POD-2622 is handed to POD-2914;
this report does not claim a drive for it.

<<<<<<< HEAD
Last evidence update: '2026-08-27 03:04:17 CEST'.
>>>>>>> 05f708469 (docs: record POD-2408 boundary finding)
=======
Last evidence update: '2026-08-27 03:29:11 CEST'.
>>>>>>> 210ad18a5 (docs: record POD-2408 controlled drive)
=======
>>>>>>> ca522e00e (docs: record review queue drive gates)
