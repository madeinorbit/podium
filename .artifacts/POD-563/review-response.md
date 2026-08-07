# POD-554 review of 45b251608 — status (HOLD)

Reviewed findings accepted. **No code rewrite yet** pending operator decision on #1.

| # | Finding | Status |
|---|---------|--------|
| 1 | Reclaim tab applies via `issues.stop` / unconfirmed Free all | **Held for operator** — scope question (read-only list vs apply). Will not restructure until POD-554 returns. |
| 2 | Invented `--superade` / `--race-navy` on `.hp-review-btn` | Acknowledged; fix is use `--primary` / `--primary-foreground`. Queued after #1 decision. |
| 3 | New `.hp-rrow*` / `.hp-review-btn` primitives | Acknowledged; brief said no new primitives. Queued after #1 decision. |
| 4 | Runtime verification + sidebar artifacts | **Done this turn** — see below. |
| 5 | Header recomputes reclaimable list every issues/sessions churn | Acknowledged perf nit; queued after #1 decision. |

## Placement
client-core viewmodels confirmed correct by reviewer — leave `hostLoadView` beside `hostMemoryView`.

## Runtime verification (no shared dist)

- `host-pressure.test.ts` — 8/8 (load meter scale, residency, reclaimable predicate)
- `multimachine-indicators.test.tsx` — 11/11 including **MEM/LOAD/AGT marks on each machine chip**
- Screenshots of design mock + production-class fixture (Playwright, file://, not live dist)

## Artifacts in this directory

- `implemented-chip-states.png` — fixture using production class names
- `implemented-chip-fixture.html` — openable fixture
- `mock-chip-proposed.png` / `mock-load-panel.png` / `mock-chip-states.png` — design mock crops
- `host-pressure-topbar.html` + `.md` — full design mock
- `implementation-notes.md` — what landed vs deferred
