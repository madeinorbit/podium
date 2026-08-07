# POD-516 — runtime verification

Driven with Playwright against this worktree's built dist, served by `vite preview`
on `127.0.0.1:19321` and proxied to the live backend, so the mission under test is a
real one (POD-516 itself: 6 sessions, one grafted child task).

## Type scale — the regression this issue inherited

`shell-type-meta` was never defined in any stylesheet. Twelve spans in the Flight Deck
used it, so they fell back to the browser's default 16px and the mission title stopped
being the largest thing in the column. Measured after the fix:

| element | computed | expected |
|---|---|---|
| mission intro `h2` | **14.5px** | `shell-type-reading` |
| task-row state label `[data-operational-state]` | **10.5px** | `shell-type-micro` |
| task-row issue ref (mono `POD-516`) | **10.5px** | `shell-type-micro` |
| progress counter (`0/1`) | **10.5px** | `shell-type-micro` |

Font-size histogram for every leaf node in the column: `{10.5: 11, 12: 13, 13: 3, 14.5: 1}`.
**Nothing at 16px**, and the `h2` is the single largest text in the column.

## Layout

Four columns at 1920px: sidebar 292 | Flight Deck 360 | center 1224 | rail 44.
With the Task dock open: 292 | 360 | 884 | 340 | 44.
`document.documentElement.scrollWidth === window.innerWidth === 1920` in both — no
horizontal overflow.

## Behaviour

| check | result |
|---|---|
| Flight Deck populates from the sidebar mission | PASS — eyebrow `POD-516 in progress`, title, description, meter `0/1`, `6 live 0 coords`, mode chips, 2 task strips, 6 inset session rows |
| Display modes filter | PASS — Full 2 rows, Active 2 rows, Needs you 1 row |
| Collapse payload | PASS — collapsing the root hides the child and all 6 session rows and shows `1 task hidden · 6 live` |
| Task dock opens from the rail | PASS — one click (this needed a fix; see below) |
| Superagent opens from the rail | PASS — `data-right-dock-panel="superagent"` with content |
| Rail tray badge | PASS — Superagent cell renders the app's own `StatusBadge` (count 5), same component as the ID square badge above it |
| Stage control | PASS — a real dropdown, `0` native `<select>` elements, offers Proposed/Backlog/Planning/In Progress/Review and **not** Done (closing goes through the close dialog) |
| Bidirectional focus | PASS — clicking the `POD-532` strip retargets the dock to POD-532 while the rail/mission stays `POD-516` |
| Fresh chat with no task | PASS — deck shows "Start with a chat", Task panel shows "This chat has no task yet." — no error copy, no forced task creation |
| Column resize persists | PASS — dragged 360 → 489, survives reload (device-local key) |
| Console | Clean — no errors, no React warnings. Only Chromium WebGL perf notices from xterm's renderer. |

## Found and fixed during verification

**The Task dock needed two clicks to open.** Opening any non-Superagent panel drove
`superOpen` false, and the effect mirroring `superOpen` into the dock then closed the
panel that had just opened. Now that effect only closes the dock when the Superagent
is what is open.

**Flight Deck collapse surviving a page reload** — PASS, after a second fix.

My first read of this was wrong. I saw that the pre-existing *sidebar* collapse failed the
same way and concluded it was an artifact of the preview rig. It was not: reading
`user_layout` directly showed the write path working correctly (`superagent.mode` moved on
every toggle) while the app still booted open. The read was the problem — `AppBody` seeded
the state with a `useState` initializer, which runs on the first render, before the replica
has the row, and never runs again. Column *width* survived only because it is a
device-local key and therefore in the local cache at mount.

Fixed by subscribing instead of seeding (`useSyncExternalStore`, the same idiom as
`use-terminal-appearance`). Verified against the real backend: with `superagent.mode`
stored as folded, the app now boots **folded** and stays folded across a reload, and
expanding still responds immediately.

The same shape affects `sidebar.collapsed` and every dock section. Filed as POD-540 rather
than changed here.
