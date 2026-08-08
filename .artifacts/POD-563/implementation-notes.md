# Host pressure top bar — implementation notes (POD-563)

Implements the design in `host-pressure-topbar.md` / `.html`. Placement: **extend the machine chip**, no new strip.

## Chip readouts

| Mark | Scale | Source |
|------|--------|--------|
| MEM | used/total % | existing `HostMetricsWire.memory` |
| LOAD | load1÷cores against `hibernation.loadPerCore` (full = parking) | `HostMetricsWire.load` (optional; blank when absent) |
| AGT | residency count; meter only if `maxIdleSessions` set | client sessions with status live/starting/reconnecting on that machine |

Working-agent count stays only on `StatusStrip`.

## Panel

Pinned LoadPanel gains **Reclaimable**: checkout count (no GiB — no `du` probe), parkable/protected idle split, held note (dirty trees refuse at free). Hibernation sentence includes load; second deep-link opens Hibernation settings for worktree GC.

**Review** opens HostInfo **Reclaim** tab; free uses `issues.stop` (keeps branch).

## Settings

Hibernation section: existing load-per-core row + **Worktree GC** subsection (`mode` off/propose/auto, `afterDays`).

## Density

Balanced density hides AGT entirely; ≤940px sheds AGT. MEM/LOAD never shed.

## Out of scope / deferred

- Reclaimable GiB (needs daemon `du`)
- Held count without attempting free
- Dedicated list/release reclaimable tRPC (client derives candidates; free via stop)
