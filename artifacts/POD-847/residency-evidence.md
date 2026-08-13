# Warm panel residency evidence

Measured in the isolated Chromium desktop harness at 1440×900 on 2026-08-13. Each visit created and selected a distinct deterministic harness session, then settled for 500 ms; the `after GC` sample used CDP `HeapProfiler.collectGarbage` followed by `Runtime.getHeapUsage`. Raw samples are in `residency-before.json` and `residency-after.json`.

## Policy decision

The old desktop policy retained eight complete `AgentPanel` trees. The baseline shows that every retained panel owns one xterm/WebGL renderer, one terminal hub attachment, one transcript subscription, and about 97 panel DOM nodes. The chosen heavy residency budget is therefore three panels on desktop (active plus two recent warm panels) and two on narrow devices; every active split pane is admitted even above budget. Terminal mounting remains eager inside a resident panel so chat/native toggles keep the existing zero-reattach lifecycle.

## Settled resources before and after

| Visits | Policy | Mounted panels | Panel DOM nodes | Document DOM nodes | xterms | WebGL | Hub terminal attaches | Hub transcript subscriptions | Heap bytes | Heap after GC |
|---:|:---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | before | 1 | 101 | 620 | 1 | 1 | 1 | 1 | 18,350,344 | 15,764,696 |
| 1 | after | 1 | 97 | 574 | 1 | 1 | 1 | 1 | 19,157,808 | 16,193,072 |
| 3 | before | 3 | 291 | 922 | 3 | 3 | 3 | 3 | 22,287,472 | 19,350,764 |
| 3 | after | 3 | 291 | 887 | 3 | 3 | 3 | 3 | 23,976,540 | 18,700,164 |
| 8 | before | 8 | 776 | 1,682 | 8 | 8 | 8 | 8 | 27,313,632 | 22,265,988 |
| 8 | after | 3 | 291 | 1,092 | 3 | 3 | 3 | 3 | 26,341,544 | 21,082,728 |
| 20 | before | 8 | 776 | 2,167 | 8 | 8 | 8 | 8 | 38,041,476 | 24,006,800 |
| 20 | after | 3 | 291 | 1,612 | 3 | 3 | 3 | 3 | 36,813,544 | 23,353,320 |

After eviction and GC at 20 visits, the new policy retains exactly three heavy surfaces versus eight before: five fewer panels, 485 fewer panel DOM nodes, five fewer xterms/WebGL renderers, five fewer terminal attachments, and five fewer transcript subscriptions. Total document DOM continues to include the intentionally lightweight 20-tab strip and cached application state; the heavy panel subtree is the plateaued count.

## Warm switching

Thirty switches rotated among the three newest resident sessions and read the existing switch-trace ring. One initial no-op selection produced no new trace, leaving 29 completed warm traces in each run.

| Policy | Completed warm traces | p50 | p95 |
|:---|---:|---:|---:|
| before | 29 | 49.1 ms | 116.0 ms |
| after | 29 | 46.9 ms | 85.1 ms |

Every included trace was non-cold, non-timeout, and contained the existing `term:interactable` mark. The focused transcript-window test continues to require `chat:cache-hit` and no transcript reread on warm activation.

## Lifecycle proof

- Chat/native/native mode cycling keeps one `mountSession` call, one transcript subscription, zero disposal, and zero unsubscribe while toggling eligibility with `setActive(false/true)`.
- Hidden residents are passed `active=false`; visible panels still mount even during the warm-set effect's one-render lag.
- Active split panes are admission-exempt and survive a budget smaller than the number of visible panes.
- Cold eviction unmounts the keyed `AgentPanel`; selecting it again follows the existing cold remount route.
- StrictMode's probe mount and cleanup leave one live terminal/subscription owner, then balance both completely on final unmount.

## Validation record

- Focused final gate: `bun run --cwd apps/web test -- src/app/panel-deck.test.ts src/app/panel-deck.test.tsx src/features/terminal/warm-set.test.ts src/features/terminal/use-warm-set.test.tsx src/features/terminal/agent-panel-active.test.tsx src/features/chat/useTranscriptWindow.test.tsx` — **6 files passed, 67 tests passed**, duration 22.94 s.
- Isolated before browser measurement: **1 passed**, 2.3 minutes.
- Isolated after browser measurement: **1 passed**, 1.9 minutes. The harness teardown logged the known asynchronous `Cannot use a closed database` transcript-indexer message after the passing result; Playwright exited 0 and both reports were already written.
- The broader `bun run test:web` was manually interrupted at the coordinator's request after several minutes (exit 130) rather than allowed to run indefinitely. Before interruption it reported unrelated failures in `agent-panel-draft-flush.test.tsx` and `handover-pane.test.tsx`; `panel-deck.test.ts` (21 tests) and `panel-deck.test.tsx` (5 tests) had passed. The final interrupt output was:

  ```text
  @podium/web:test:  ✓ src/features/issues/issue-hierarchy.test.ts (6 tests) 16ms
  @podium/web:test:  ✓ src/features/issues/IssuePage.agent-start.test.tsx (2 tests) 5036ms
  @podium/web:test:      ✓ starts a new ticket session with a selected agent from the split dropdown 2180ms
  @podium/web:test:      ✓ picks a model for the ticket and persists it via issues.update 2849ms
  exit code 130
  ```
