/**
 * `@podium/model` — the L0 semantic vocabulary [ADR 4].
 *
 * One authoritative definition per entity field (name, type, brand, nullability,
 * meaning); storage, wire and port representations COMPOSE from those field
 * groups rather than restating them. This is explicitly NOT one universal record
 * (ADR 4 D1): the roles R1–R6 are legitimately distinct types, and the defect
 * being fixed is hand-restated field lists, not the number of types.
 *
 * Layer L0 (ADR 8): model imports no other @podium package. Anything that would
 * require an import from L1+ does not belong here.
 *
 * Currently modelled: the Issue vocabulary (POD-791), the issue dependency edge
 * and the Repo prefix (POD-822 — the two entities the replica's issue views join
 * against, neither of which could be a field on the issue without putting
 * cross-entity work back on the write path; see `issue/dep.ts` and `repo/`).
 * Sessions and the remaining entities follow under POD-302/POD-364-368;
 * `packages/domain`'s pure predicates are absorbed here by POD-299 (ADR 8 D4
 * records `packages/domain` → `packages/model` as a rename+absorb, so this
 * package is that rename's destination, standing up ahead of it).
 */
export * from './fields'
export * from './ids'
export * from './issue'
export * from './repo'
export * from './shape'
