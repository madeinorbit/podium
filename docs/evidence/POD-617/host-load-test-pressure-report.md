# Host load and test pressure report

Initial snapshot: 2026-08-08 around 23:00–23:30 CEST. Outcomes updated 2026-08-09. Exact load and resident-session counts change minute by minute.

## Executive summary

- The red load reading was correct. Load ultimately peaked near 69 on 8 CPU cores, or about 8.6 runnable or waiting tasks per core.
- The peak was not caused by the one protected full suite, which ran serially. It came from that legitimate suite overlapping with one typecheck and three focused Vitest lanes that entered outside `test:heavy`.
- After the team stopped overlapping validation, normalized host load fell from the peak into a substantially lower raw-load band of roughly 10–30 while serialized work continued.
- The agent count represented resident sessions, not concurrent computation. Immediate cleanup reduced residency from 38 to 35 without stopping uncertain or active work, and this host's persisted `maxIdleSessions` target was corrected from 30 to 8.
- The durable integration combines nested lease ownership, durable waiters, queued lease metadata, clearer residency/idle signals, and a shared validation admission budget. The final typecheck is green; the final full suite completed with the known red task set plus two stale-lineage tasks documented below; and the accepted POD-619 runtime evidence covers the integrated UI behavior.

## Outcomes — 2026-08-09

### Measured operating result

The worst observed one-minute load was about 69 on an 8-core host (`69 / 8 = 8.6×`). At that time one legitimate full suite held `test:heavy` and ran Turbo at concurrency one, while validation outside the lease added one typecheck and three related Vitest lanes. Once agents serialized their commands, raw load generally fell into roughly the 10–30 range even while useful work continued.

One current-main full-suite baseline then ran alone for 68 minutes at concurrency one. It completed 20 of 27 tasks successfully and reported 7 failing tasks. Those failures were present on current main and were unrelated to this integration; the failures included protocol/RPC fixture drift, Codex hook detection, runtime and architecture tripwires, and two server/terminal-client failures. The run also showed that Turbo's aggregate output can remain empty for a long time even while fresh Vitest workers are progressing, so holder health should not be inferred from an empty aggregate log.

### Final integration gate

The parent waited 54 minutes in the durable `test:heavy` queue, received the known two-minute queued grant, immediately renewed it to 30 minutes, and held it across exactly two serial commands. The installed CLI still contained the old five-minute `--wait` cap, so the first wrapper attempt expired before starting a child; that attempt is not validation evidence. A separate typecheck accidentally expanded from an orchestrator mail in a dirty main checkout and ended after about 11 seconds; it is also excluded from the evidence.

- `PODIUM_VALIDATION_RESOURCE_HELD=heavy bun run typecheck` completed 23 of 23 tasks successfully, with 0 cached, in 2m11.501s.
- `PODIUM_VALIDATION_RESOURCE_HELD=heavy bun run test` completed 18 of 27 tasks successfully, with 0 cached, in 52m17.628s. The lease was renewed throughout and released immediately at exit.

The nine red full-suite tasks were daemon, protocol, runtime, scripts, server boundary, server contracts, server services, terminal-client, and web. Seven task identities overlap the measured current-main baseline. The two additional red tasks are explained by the required child lineage: this branch is rooted at shared ancestor `86b9e8af6`, while local main had advanced to `5e5698ce3`. Later main contains, among other repairs, the corrected oracle input-origin expectation (`12470800e`) and the replicated UI-state subscription contract (`4351f2931`) plus subsequent worklist changes. None of the server-services or web failure files is in this integration's `git diff main...HEAD`; no unrelated fix or main merge was folded into this branch. The future review/landing rebase is therefore a material remaining validation risk.

The first parent typecheck also exposed two straightforward integration-only TypeScript errors in the merged lock waiter: a queued-only mock shape and an `AbortSignal.aborted` narrowing preserved across an injected `await`. The parent repaired those without changing runtime behavior; the clean full typecheck and the CLI's 369-test package task both passed afterward.

### Integrated UI evidence

The ancestry-preserving child merge did not conflict with POD-619's UI files. Its accepted runtime evidence shows a neutral `AGT 36` resident count, a critical `IDLE 12/8` target signal, and a real click opening the host popover. The review frames are [residency-meter-chip.png](../pod-619/residency-meter-chip.png) and [residency-meter-runtime.png](../pod-619/residency-meter-runtime.png). No duplicate browser lane was run during final integration.

### Immediate changes completed

- Resident sessions were reduced from 38 to 35 by reversibly stopping three clearly finished, clean, decision-free sessions. Eleven uncertain or protected sessions were left alone.
- `hibernation.maxIdleSessions` was changed from the stale persisted value 30 to 8 through the supported settings API; `idleShellHours` remained unchanged.
- Validation commands were serialized instead of overlapping test, focused-test, and typecheck work.
- Repository guidance now distinguishes root package lanes through `scripts/test.ts` from focused/direct commands and makes within-session ordering explicit.

### Product fixes on the integration branch

- POD-561 is integrated: nested `test:heavy` ownership is retained, both ownership paths renew, and only a newly acquired lease is released.
- POD-612 is integrated: bare `--wait` stays queued until granted, explicit timeouts are honored, timeout and interrupt paths clean up the queue entry, and long waits narrate progress with backoff. Live evidence preserved first position for about 2,450 seconds before grant.
- POD-619 is integrated: resident agent inventory is neutral, while eligible/observed idle sessions are compared with the idle target in their own signal.
- POD-623 is integrated: queued waiters retain their requested TTL and note instead of receiving the two-minute default on grant.
- POD-618 is integrated: focused tests and typechecks enter a shared admission budget, with ownership propagated to nested package tasks so they do not deadlock or self-release.

### Remaining proposals and baseline follow-ups

- POD-611 — expose the heavy-test lease and holder health in the UI.
- POD-640 — split scoped browser validation from unrelated serial unit work while preserving host and port safety.
- POD-644 — repair protocol RPC fixture and correlator drift found in the current-main baseline.
- POD-645 — repair real Codex binary hook detection found in the current-main baseline.

## 1. Where were all the sessions coming from?

The live database snapshot showed accumulated session residency rather than a sudden burst of every agent computing at once. The count included working, idle, errored, and unknown sessions; many were attached to completed or review-stage issues, and several had been resident for days.

The top-bar word “agent” was therefore easy to misread: it counted resident live, starting, or reconnecting sessions, including sessions that were not actively consuming CPU. The integrated UI fix keeps that inventory neutral and separates the observed idle population from its target.

## 2. Why did load-based hibernation not solve it?

Hibernation helped, but it is a safety valve rather than a CPU scheduler. It parks only sessions that Podium can prove are safe to resume later: sufficiently idle and quiet, resumable, and free of pending messages, offers, child work, or other terminal activity. It does not stop an actively running test or typecheck.

Live server logs showed resource-driven hibernation safely park sessions after load alerts. The remaining residents were working, errored, unknown, protected by active coordination, shell sessions, or otherwise outside the safety proof. Correcting this host's stale `maxIdleSessions: 30` setting to 8 makes future residency cleanup more effective, but it still deliberately does not interrupt active validation.

## 3. What does the red load bar mean?

The reading was accurate. Linux load counts runnable tasks plus tasks waiting in certain uninterruptible states; it is not a CPU-utilization percentage. A raw load of 69 on 8 cores is approximately 8.6 runnable or waiting tasks per core, which is severe shared-host contention.

The signal can also fall quickly because it is a rolling average. Lower readings later in the incident did not invalidate the peak; they reflected validation becoming serialized and earlier work leaving the window.

## 4. What made validation heavy?

The default suite spans a large monorepo through package-owned tasks. Turbo runs package tasks serially, but an individual Vitest task can still use workers, and cold or broadly invalidated runs can take a long time. The measured current-main baseline took 68 minutes at concurrency one, with server shards and scripts accounting for much of the elapsed time.

The exclusive `test:heavy` lease worked for root full/heavy entry points: one full suite held it and other leased work waited. The gap was focused Vitest, direct package commands, typechecking, multi-instance work, and hand-run browser verification outside the lease. Individually small commands accumulated until they outweighed the protected full run.

The durable design is tiered rather than putting every ten-second probe behind a long mutex: heavy lanes stay exclusive, focused tests and typechecks use bounded shared admission, nested tasks inherit ownership, and watch/browser work can receive policy appropriate to the resource it actually consumes.

## Recommended operating model

1. Keep resident-session cleanup conservative: stop only clearly finished, decision-free sessions and preserve uncertain or coordinating work.
2. Keep this host's idle target aligned with the current value of 8; treat that as residency and memory control, not a way to kill active validation.
3. Serialize validation inside each session: focused test first, typecheck when needed, then one final full gate at the integration boundary.
4. Match checks to regression risk. Small UI or bug changes use the smallest relevant test and required live interaction evidence; substantive integration owns the final full gate.
5. Respect healthy leases. Check `podium lock status test:heavy`, use the lease-aware entry point, and do not steal a renewing lease merely because aggregate Turbo output is quiet.
6. Prefer holder process age, fresh worker churn, and completed package-task logs as liveness/progress signals; an empty aggregate Turbo log is not evidence of a stalled run.
7. Rebase this integration onto the then-current main before landing and re-evaluate the two stale-lineage task failures; do not interpret this branch's 18/27 result as a regression caused by the issue diff or as the newer main baseline.

## Bottom line

The red load bar was telling the truth, and neither hibernation nor the full-suite mutex was fundamentally broken. Hibernation manages safe idle residency, while the overload came from active validation entering through several uncoordinated paths. Conservative session cleanup and serialization reduced immediate pressure; the integrated lock fixes and shared validation budget close the coordination gaps without making every focused check wait behind an hour-long full suite.
