# shared/ — owned by the slice spec (POD-4442)

Frozen shapes: `slice-types.ts` (entities, rows, order, snapshot), `stats.ts`
(counters, row-stream events), `arm.ts` (the arm contract). See
`docs/plans/pod-4441-round-two-slice.md`; every export cites its spec section.

Arms may read; changes need the coordinator (POD-4286 session A).
