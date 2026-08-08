# POD-554 review of 45b251608 — status (HOLD)

Reviewed findings accepted. **No code rewrite yet** pending operator decision on #1.

| # | Finding | Status |
|---|---------|--------|
| 1 | Reclaim tab applies via `issues.stop` / unconfirmed Free all | **Held for operator** — scope question. Will not restructure until POD-554 returns. |
| 2 | Invented `--superade` / `--race-navy` on `.hp-review-btn` | Acknowledged; use `--primary` / `--primary-foreground`. Queued after #1. |
| 3 | New `.hp-rrow*` / `.hp-review-btn` primitives | Acknowledged; out of brief. Queued after #1. |
| 4 | Runtime verification | **NOT done.** Unit tests + file:// fixture screenshots are useful but are **not** runtime verification. Real component + real store + real CSS cascade against a live instance (worktree preview only — never shared root dist) after #1 is decided. |
| 5 | Header recomputes reclaimable list on issues/sessions churn | Acknowledged perf nit; queued after #1. |

## Placement
client-core viewmodels confirmed correct — leave `hostLoadView` beside `hostMemoryView`.

## What exists (and what it is not)

| Artifact | Is |
|----------|-----|
| `host-pressure.test.ts` / multimachine chip mark assertions | Unit / DOM tests — keep |
| `implemented-chip-fixture.html` + screenshots | State review aid using **re-declared** class names — useful, **not** runtime verification |
| Design mock screenshots | Design reference — not production |

## Closing #4 (later)

1. Operator decides finding 1; rebuild accordingly.
2. Preview worktree build **separately** (or export to a scratch dir and point an instance at it).
3. Do **not** write shared root `apps/web/dist` served by the live operator instance.
4. Capture the real chip on a machine that has load + residency.
